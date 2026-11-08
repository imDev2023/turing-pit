// Prices for the house. Every couple of seconds it reads the mid prices of Binance, Coinbase, OKX
// and Hyperliquid and posts their median to its own price feed on chain, where the program keeps
// a price only within 1% of a fresh Pyth price; rounds fill at those prices. Pyth is the check
// and the fallback. With a Pyth API key the keeper also posts Wormhole-signed updates from Hermes
// into its own shard of push-oracle accounts every few seconds (verified on chain, so the house
// chooses only when to post, never the price); without one, the check reads Pyth's sponsored
// devnet feeds on shard 0, which Pyth updates about every five minutes. New rounds use the
// freshest source that is working. The keeper also keeps a short price history for the agents.

import { Wallet } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";
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
  decodeHouseFeed,
  decodePriceUpdate,
  feedAccounts,
  houseFeedPda,
  postPricesIx,
  type Asset,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import { READ, lastHour, median, type Exchange, type Mids } from "./exchanges.js";
import { land } from "./rpc.js";
import { shortError } from "./send.js";

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
/** Compute for one post of the house's prices; a post uses about a third of it. */
const FEED_CU = 40_000;

export class PriceKeeper {
  /** Prices at least ten seconds apart, for the agents' 1-minute to 1-hour moves. */
  readonly history: Record<Asset, PricePoint[]> = { SOL: [], BTC: [], ETH: [] };
  /** Pyth updates posted on chain since start, when the last one landed (ms), and the last error. */
  posted = 0;
  lastPostedAt = 0;
  lastError = "";
  /** Posts of the house's prices sent since start. */
  feedPosts = 0;
  private live: Partial<Record<Asset, PricePoint>> = {};
  private medianAt: Record<Asset, number> = { SOL: 0, BTC: 0, ETH: 0 };
  private quotes = new Map<Exchange, { mids: Mids; at: number }>();
  /** Reads per exchange since the last heartbeat. */
  private health = new Map<Exchange, { ok: number; failed: number; error: string }>();
  /** Per coin: the feed's on-chain time at the last read, and when (ms) it last moved forward. */
  private feedTimes = [0, 0, 0];
  private feedMovedAt = [0, 0, 0];
  private wasFeeding = false;
  private feedFailures = 0;
  private blockhash: { hash: string; at: number } | null = null;
  private hermes: HermesClient | null;
  private receiver: PythSolanaReceiver;
  private failures = 0;

  constructor(private cfg: Config) {
    this.hermes = cfg.pythApiKey ? new HermesClient(cfg.hermesUrl, { accessToken: cfg.pythApiKey }) : null;
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

  /** True while the house's feed moves forward on chain for every coin. */
  get feeding(): boolean {
    const now = Date.now();
    return this.feedMovedAt.every((t) => now - t < 30_000);
  }

  /** The price source new rounds should use: the house's feed, else the freshest Pyth. */
  source(): PriceSource {
    if (this.feeding) return { shardId: HOUSE_SHARD, maxPriceAge: PRICE_AGE_HOUSE };
    return this.posting
      ? { shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER }
      : { shardId: SPONSORED_SHARD_ID, maxPriceAge: PRICE_AGE_SPONSORED };
  }

  /** Waits (up to `ms`) for the house's prices to land, so new rounds start on them. */
  async ready(ms: number) {
    const until = Date.now() + ms;
    while (!this.feeding && Date.now() < until) await sleep(1_000);
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
    if (Date.now() - this.medianAt[asset] > QUOTE_TTL_MS) this.note(asset, point);
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

  /** Reads every exchange, then posts the median of the fresh quotes for each coin. */
  private async postFeed() {
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
    const prices = [0, 0, 0];
    const sources = [0, 0, 0];
    ASSETS.forEach((a, i) => {
      const mids = [...this.quotes.values()]
        .filter((q) => now - q.at < QUOTE_TTL_MS)
        .map((q) => q.mids[a])
        .filter((p): p is number => p !== undefined);
      const m = median(mids);
      if (m === undefined) return;
      prices[i] = m;
      sources[i] = mids.length;
      this.medianAt[a] = now;
      this.note(a, { t: Math.floor(now / 1000), price: m });
    });
    if (prices.every((p) => p === 0)) return;
    try {
      const conn = this.cfg.connection;
      const authority = this.cfg.keys.authority;
      if (!this.blockhash || now - this.blockhash.at > 30_000) {
        this.blockhash = { hash: (await conn.getLatestBlockhash("confirmed")).blockhash, at: now };
      }
      const tx = new Transaction({ feePayer: authority.publicKey, recentBlockhash: this.blockhash.hash }).add(
        // A compute limit that differs from post to post keeps two posts of the same prices apart.
        ComputeBudgetProgram.setComputeUnitLimit({ units: FEED_CU + (this.feedPosts % 500) }),
        postPricesIx({
          programId: this.cfg.programId,
          authority: authority.publicKey,
          prices,
          sources,
          // The Pyth prices the program checks each price against: the keeper's own while it posts them.
          guards: feedAccounts(this.posting ? SHARD_ID : SPONSORED_SHARD_ID),
        }),
      );
      tx.sign(authority);
      // Not confirmed one by one: the next post follows in two seconds, and readFeed sees what landed.
      await conn.sendRawTransaction(tx.serialize(), { maxRetries: 0 });
      this.feedPosts++;
      this.feedFailures = 0;
      if (this.feedPosts === 1 || this.feedPosts % 300 === 0) this.heartbeat();
    } catch (e) {
      this.feedFailures++;
      const msg = shortError(e);
      if (/blockhash not found|block height exceeded/i.test(msg)) this.blockhash = null;
      if (this.feedFailures <= 3 || this.feedFailures % 60 === 0) log("feed", `post failed (${this.feedFailures} in a row):`, msg);
    }
  }

  /** The feed in the log: the first post, then about every ten minutes, with how each exchange answered. */
  private heartbeat() {
    const prices = ASSETS.map((a) => `${a} $${this.live[a]?.price.toFixed(2) ?? "?"}`).join(", ");
    const exchanges = EXCHANGES.map((x) => {
      const h = this.health.get(x);
      if (!h) return `${x} 0/0`;
      return `${x} ${h.ok}/${h.ok + h.failed}${h.failed ? ` (${h.error})` : ""}`;
    }).join(", ");
    log("feed", `post ${this.feedPosts} (${prices}); exchanges answered ${exchanges}`);
    this.health.clear();
  }

  /** Reads the house's feed back from the chain, to see that its prices keep landing. */
  private async readFeed() {
    try {
      const info = await this.cfg.connection.getAccountInfo(houseFeedPda(this.cfg.programId, this.cfg.keys.authority.publicKey));
      const feed = info ? decodeHouseFeed(info.data) : null;
      feed?.times.forEach((t, i) => {
        if (t <= this.feedTimes[i]) return;
        if (this.feedTimes[i] > 0) this.feedMovedAt[i] = Date.now();
        this.feedTimes[i] = t;
      });
    } catch {
      // the next read tries again
    }
    if (this.feeding !== this.wasFeeding) {
      this.wasFeeding = this.feeding;
      log("feed", this.feeding ? "the house's prices are landing; new rounds fill at them" : "the house's prices stopped landing; new rounds fill at Pyth's");
    }
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
    for (let n = 0; Date.now() < until; n++) {
      const started = Date.now();
      await this.postFeed();
      if (n % 3 === 0) await this.readFeed();
      await sleep(Math.max(250, this.cfg.feedIntervalMs - (Date.now() - started)));
    }
  }

  private async runPyth(until: number) {
    const ids = ASSETS.map((a) => FEED_IDS[a]);
    const hermes = this.hermes;
    if (!hermes) log("keeper", "PYTH_API_KEY is not set, so the 1% check reads Pyth's sponsored devnet feeds (updated about every 5 minutes)");
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
