// Prices for the house. Every couple of seconds it reads the mid prices of Binance, Coinbase, OKX
// and Hyperliquid, which costs nothing, and it puts their median on chain only when a game needs
// a price: first in each of its agents' trades and its settlements, so those carry their own
// fresh price, and every couple of seconds while a player is trading (any player's transaction
// on the house's feed account keeps it posting for ten minutes; the site sends a tiny one when a
// trade finds the price stale). The program keeps a posted price only within 1% of a Pyth price,
// read from Pyth's sponsored devnet feeds, which Pyth pays for. With PYTH_PUSH=1 and a Pyth API
// key the keeper also posts Hermes updates into its own shard of Pyth accounts every few seconds.
// The keeper also keeps a short price history for the agents.

import { Wallet } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { ComputeBudgetProgram, Transaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  ASSETS,
  EXCHANGES,
  FEED_IDS,
  HOUSE_SHARD,
  PRICE_AGE_HOUSE,
  PRICE_AGE_KEEPER,
  PRICE_AGE_SPONSORED,
  SHARD_ID,
  SPONSORED_SHARD_ID,
  decodePriceUpdate,
  feedAccounts,
  houseFeedPda,
  postPricesIx,
  type Asset,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import { READ, lastHour, median, type Exchange, type Mids } from "./exchanges.js";
import { land } from "./rpc.js";
import { ownSignatures, rememberOwn, shortError } from "./send.js";

export interface PricePoint {
  t: number; // unix seconds
  price: number;
}

/** Where a round reads its prices (the house's feed, or a shard of Pyth accounts) and how old a fill price may be. */
export interface PriceSource {
  shardId: number;
  maxPriceAge: number;
}

/** An exchange's quote counts toward the median for this long after it arrives. */
const QUOTE_TTL_MS = 10_000;
/** Compute for one post of the house's prices on its own; a post uses about a third of it. */
const FEED_CU = 40_000;
/** A player's transaction on the house's feed keeps the house posting for this long. */
const AWAKE_MS = 10 * 60_000;

export class PriceKeeper {
  /** Prices at least ten seconds apart, for the agents' 1-minute to 1-hour moves. */
  readonly history: Record<Asset, PricePoint[]> = { SOL: [], BTC: [], ETH: [] };
  /** Pyth updates posted on chain since start, when the last one landed (ms), and the last error. */
  posted = 0;
  lastPostedAt = 0;
  lastError = "";
  /** Posts of the house's prices sent on their own (those inside trades and settlements aside). */
  feedPosts = 0;
  private readonly feed: PublicKey;
  private live: Partial<Record<Asset, PricePoint>> = {};
  private medians: Partial<Record<Asset, { price: number; sources: number; at: number }>> = {};
  private quotes = new Map<Exchange, { mids: Mids; at: number }>();
  /** Reads per exchange since the last heartbeat. */
  private health = new Map<Exchange, { ok: number; failed: number; error: string }>();
  private postsAtHeartbeat = 0;
  private lastHeartbeat = 0;
  private awakeUntil = 0;
  /** The newest transaction seen on the house's feed, and whether the feed has been looked at yet. */
  private lastTouch: string | undefined;
  private looked = false;
  private feedFailures = 0;
  private blockhash: { hash: string; at: number } | null = null;
  private hermes: HermesClient | null;
  private receiver: PythSolanaReceiver;
  private failures = 0;

  constructor(private cfg: Config) {
    this.feed = houseFeedPda(cfg.programId, cfg.keys.authority.publicKey);
    this.hermes = cfg.pythApiKey && cfg.pythPush ? new HermesClient(cfg.hermesUrl, { accessToken: cfg.pythApiKey }) : null;
    this.receiver = new PythSolanaReceiver({
      connection: cfg.connection,
      wallet: new Wallet(cfg.keys.authority),
      treasuryId: cfg.pythTreasuryId,
    });
  }

  /** True while the keeper's own Pyth updates are landing. */
  get posting(): boolean {
    return this.lastPostedAt > 0 && Date.now() - this.lastPostedAt < 60_000;
  }

  /** True while every coin has a fresh median, so the house can price a trade. */
  get pricing(): boolean {
    return ASSETS.every((a) => Date.now() - (this.medians[a]?.at ?? 0) < QUOTE_TTL_MS);
  }

  /** True while a player is trading: the house posts its prices every couple of seconds. */
  get awake(): boolean {
    return Date.now() < this.awakeUntil;
  }

  /** The price source new rounds should use: the house's prices, else the freshest Pyth. */
  source(): PriceSource {
    if (this.pricing) return { shardId: HOUSE_SHARD, maxPriceAge: PRICE_AGE_HOUSE };
    return this.posting
      ? { shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER }
      : { shardId: SPONSORED_SHARD_ID, maxPriceAge: PRICE_AGE_SPONSORED };
  }

  /** Waits (up to `ms`) for the exchanges to answer, so new rounds start on the house's prices. */
  async ready(ms: number) {
    const until = Date.now() + ms;
    while (!this.pricing && Date.now() < until) await sleep(500);
  }

  latest(asset: Asset): number | undefined {
    return this.live[asset]?.price;
  }

  /** Seconds since the latest price was set. */
  age(asset: Asset): number | undefined {
    const p = this.live[asset];
    return p ? Math.max(0, Math.floor(Date.now() / 1000) - p.t) : undefined;
  }

  /** Percent change over the last `seconds`: latest price against the price in force back then. */
  change(asset: Asset, seconds: number): number | undefined {
    const latest = this.live[asset];
    if (!latest) return undefined;
    const cutoff = Date.now() / 1000 - seconds;
    const then = [...this.history[asset]].reverse().find((p) => p.t <= cutoff);
    return then ? ((latest.price - then.price) / then.price) * 100 : undefined;
  }

  /** For a round on the house's prices: a post of the current medians to put first in its trade
   *  or settlement, so the transaction carries its own fresh price; the house signs it too.
   *  Empty for rounds on Pyth's accounts, or while no exchange answers. */
  priceIxs(round: { shardId: number }): TransactionInstruction[] {
    if (round.shardId !== HOUSE_SHARD) return [];
    const ix = this.postIx();
    return ix ? [ix] : [];
  }

  /** The current medians as a post_prices instruction (0 for a coin no exchange has answered for lately). */
  private postIx(): TransactionInstruction | null {
    const now = Date.now();
    const fresh = ASSETS.map((a) => {
      const m = this.medians[a];
      return m && now - m.at < QUOTE_TTL_MS ? m : null;
    });
    if (fresh.every((m) => !m)) return null;
    return postPricesIx({
      programId: this.cfg.programId,
      authority: this.cfg.keys.authority.publicKey,
      prices: fresh.map((m) => m?.price ?? 0),
      sources: fresh.map((m) => m?.sources ?? 0),
      // The Pyth prices the program checks each price against: the keeper's own while it posts them.
      guards: feedAccounts(this.posting ? SHARD_ID : SPONSORED_SHARD_ID),
    });
  }

  /** Sets a coin's latest price; the history keeps points at least ten seconds apart. */
  private note(asset: Asset, point: PricePoint) {
    const live = this.live[asset];
    if (live && live.t > point.t) return;
    this.live[asset] = point;
    const series = this.history[asset];
    const last = series[series.length - 1];
    if (last && point.t - last.t < 10) return;
    series.push(point);
    if (series.length > 720) series.splice(0, series.length - 720);
  }

  /** Pyth's prices stand in for a coin while no exchange answers for it. */
  private notePyth(asset: Asset, point: PricePoint) {
    if (Date.now() - (this.medians[asset]?.at ?? 0) > QUOTE_TTL_MS) this.note(asset, point);
  }

  private recordParsed(parsed: { id: string; price: { price: string; expo: number; publish_time: number } }[] | null | undefined) {
    for (const p of parsed ?? []) {
      const asset = ASSETS.find((a) => FEED_IDS[a] === p.id.replace(/^0x/, ""));
      if (asset) this.notePyth(asset, { t: p.price.publish_time, price: Number(p.price.price) * Math.pow(10, p.price.expo) });
    }
  }

  /** Loads the last hour of Coinbase's one-minute prices, so agents see 1-minute to 1-hour moves from their first decision. */
  private async backfill() {
    for (const a of ASSETS) {
      try {
        for (const p of await lastHour(a)) this.note(a, p);
      } catch {
        // history is a nicety; live prices fill it in within the hour anyway
      }
    }
  }

  /** Reads every exchange (free) and takes the median of the fresh quotes for each coin. */
  private async readExchanges() {
    const reads = await Promise.allSettled(EXCHANGES.map((x) => READ[x]()));
    const now = Date.now();
    reads.forEach((r, i) => {
      const x = EXCHANGES[i];
      const h = this.health.get(x) ?? { ok: 0, failed: 0, error: "" };
      if (r.status === "fulfilled") {
        this.quotes.set(x, { mids: r.value, at: now });
        h.ok++;
      } else {
        h.failed++;
        h.error = String((r.reason as Error)?.message ?? r.reason).slice(0, 60);
      }
      this.health.set(x, h);
    });
    for (const a of ASSETS) {
      const mids = [...this.quotes.values()]
        .filter((q) => now - q.at < QUOTE_TTL_MS)
        .map((q) => q.mids[a])
        .filter((p): p is number => p !== undefined);
      const m = median(mids);
      if (m === undefined) continue;
      this.medians[a] = { price: m, sources: mids.length, at: now };
      this.note(a, { t: Math.floor(now / 1000), price: m });
    }
  }

  /** Looks for players' transactions on the house's feed: every trade on the house's prices reads
   *  it, and the site sends a tiny one when a trade finds the price stale. Each keeps the house
   *  posting for the next ten minutes. */
  private async checkWake() {
    try {
      const sigs = await this.cfg.connection.getSignaturesForAddress(this.feed, { limit: 20, until: this.lastTouch }, "confirmed");
      // The first look only marks where to start: what it finds came before this shift, whose own
      // posts it can't tell from a player's.
      const first = !this.looked;
      this.looked = true;
      if (!sigs.length) return;
      this.lastTouch = sigs[0].signature;
      if (first || sigs.every((s) => ownSignatures.has(s.signature))) return;
      if (!this.awake) log("feed", "a player is trading; the house posts prices every 2 s until ten minutes after their last trade");
      this.awakeUntil = Date.now() + AWAKE_MS;
    } catch {
      // looked at again in two seconds
    }
  }

  /** Posts the medians on their own, while a player is trading. */
  private async postFeed() {
    const ix = this.postIx();
    if (!ix) return;
    try {
      const conn = this.cfg.connection;
      const authority = this.cfg.keys.authority;
      if (!this.blockhash || Date.now() - this.blockhash.at > 30_000) {
        this.blockhash = { hash: (await conn.getLatestBlockhash("confirmed")).blockhash, at: Date.now() };
      }
      const tx = new Transaction({ feePayer: authority.publicKey, recentBlockhash: this.blockhash.hash }).add(
        // A compute limit that differs from post to post keeps two posts of the same prices apart.
        ComputeBudgetProgram.setComputeUnitLimit({ units: FEED_CU + (this.feedPosts % 500) }),
        ix,
      );
      tx.sign(authority);
      rememberOwn(tx.signature!);
      // Not confirmed one by one: the next post follows in two seconds.
      await conn.sendRawTransaction(tx.serialize(), { maxRetries: 0 });
      this.feedPosts++;
      this.feedFailures = 0;
    } catch (e) {
      this.feedFailures++;
      const msg = shortError(e);
      if (/blockhash not found|block height exceeded/i.test(msg)) this.blockhash = null;
      if (this.feedFailures <= 3 || this.feedFailures % 60 === 0) log("feed", `post failed (${this.feedFailures} in a row):`, msg);
    }
  }

  /** The prices in the log every ten minutes, with how each exchange answered and what was posted. */
  private heartbeat() {
    const prices = ASSETS.map((a) => `${a} $${this.live[a]?.price.toFixed(2) ?? "?"}`).join(", ");
    const exchanges = EXCHANGES.map((x) => {
      const h = this.health.get(x);
      if (!h) return `${x} 0/0`;
      return `${x} ${h.ok}/${h.ok + h.failed}${h.failed ? ` (${h.error})` : ""}`;
    }).join(", ");
    const posts = this.feedPosts - this.postsAtHeartbeat;
    log("feed", `${prices}; exchanges answered ${exchanges}; ${posts ? `${posts} posts while players traded` : "no player traded, so nothing posted on its own"}`);
    this.health.clear();
    this.postsAtHeartbeat = this.feedPosts;
    this.lastHeartbeat = Date.now();
  }

  private async post(hermes: HermesClient, ids: string[]) {
    try {
      const update = await hermes.getLatestPriceUpdates(ids, { encoding: "base64", parsed: true });
      this.recordParsed(update.parsed);
      const builder = this.receiver.newTransactionBuilder({ closeUpdateAccounts: true });
      await builder.addUpdatePriceFeed(update.binary.data, SHARD_ID);
      const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 2_000 });
      // Each transaction needs the one before it (write the VAA, verify it, post the prices).
      const sigs: string[] = [];
      for (const { tx, signers } of txs) {
        tx.sign([this.cfg.keys.authority, ...(signers ?? [])]);
        sigs.push(await land(this.cfg.connection, tx.serialize(), { timeoutMs: 45_000 }));
      }
      this.failures = 0;
      this.posted++;
      this.lastPostedAt = Date.now();
      // A heartbeat in the log: the first update, then about every ten minutes.
      if (this.posted === 1 || this.posted % 60 === 0) {
        log("keeper", `posted Pyth update ${this.posted} in ${txs.length} transactions`, sigs[sigs.length - 1]);
      }
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message?.slice(0, 300) ?? String(e);
      if (this.failures <= 3 || this.failures % 30 === 0) {
        log("keeper", `Pyth update failed (${this.failures} in a row):`, this.lastError.slice(0, 200));
      }
    }
  }

  /** Reads Pyth's sponsored feed accounts (shard 0) from the chain. */
  private async watch() {
    try {
      const infos = await this.cfg.connection.getMultipleAccountsInfo(feedAccounts(SPONSORED_SHARD_ID));
      infos.forEach((info, i) => {
        const p = info ? decodePriceUpdate(info.data) : null;
        if (p) this.notePyth(ASSETS[i], { t: p.publishTime, price: p.price });
      });
    } catch (e) {
      this.lastError = (e as Error).message?.slice(0, 300) ?? String(e);
    }
  }

  private async runFeed(until: number) {
    while (Date.now() < until) {
      const started = Date.now();
      await this.readExchanges();
      await this.checkWake();
      if (this.awake) await this.postFeed();
      if (Date.now() - this.lastHeartbeat > 600_000) this.heartbeat();
      await sleep(Math.max(250, this.cfg.feedIntervalMs - (Date.now() - started)));
    }
  }

  private async runPyth(until: number) {
    const ids = ASSETS.map((a) => FEED_IDS[a]);
    const hermes = this.hermes;
    if (!hermes) log("keeper", "the 1% check reads Pyth's sponsored devnet feeds; the house posts no Pyth updates of its own");
    while (Date.now() < until) {
      const started = Date.now();
      if (hermes) await this.post(hermes, ids);
      if (!this.posting) await this.watch();
      await sleep(Math.max(1_000, this.cfg.keeperIntervalMs - (Date.now() - started)));
    }
  }

  async run(until: number) {
    await this.backfill();
    await Promise.all([this.runFeed(until), this.runPyth(until)]);
  }
}
