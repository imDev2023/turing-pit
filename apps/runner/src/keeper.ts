// Prices for the house. With a Pyth API key, the keeper fetches Wormhole-signed updates from
// Hermes and posts them through Pyth's push oracle into our own shard of price feed accounts every
// few seconds; the updates are verified on chain, so the house chooses only when to post, never
// the price. Without a key (or while posting fails), rounds use Pyth's sponsored devnet feeds on
// shard 0, which Pyth updates itself about every five minutes, and the keeper just reads them.
// Either way it keeps a short price history for the agents.

import { Wallet } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import {
  ASSETS,
  FEED_IDS,
  PRICE_AGE_KEEPER,
  PRICE_AGE_SPONSORED,
  SHARD_ID,
  SPONSORED_SHARD_ID,
  decodePriceUpdate,
  feedAccounts,
  type Asset,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import { land } from "./rpc.js";

export interface PricePoint {
  t: number; // publish time, unix seconds
  price: number;
}

/** Where a round reads its prices: a shard of push-oracle accounts and how old a fill price may be. */
export interface PriceSource {
  shardId: number;
  maxPriceAge: number;
}

export class PriceKeeper {
  readonly history: Record<Asset, PricePoint[]> = { SOL: [], BTC: [], ETH: [] };
  /** Updates posted on chain since start, when the last one landed (ms), and the last error. */
  posted = 0;
  lastPostedAt = 0;
  lastError = "";
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

  /** True while the keeper's own updates are landing. */
  get posting(): boolean {
    return this.lastPostedAt > 0 && Date.now() - this.lastPostedAt < 60_000;
  }

  /** The price source new rounds should use. */
  source(): PriceSource {
    return this.posting
      ? { shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER }
      : { shardId: SPONSORED_SHARD_ID, maxPriceAge: PRICE_AGE_SPONSORED };
  }

  /** Waits (up to `ms`) for the first posted update, if the keeper can post at all. */
  async ready(ms: number) {
    const until = Date.now() + ms;
    while (this.hermes && !this.posting && Date.now() < until) await sleep(1_000);
  }

  latest(asset: Asset): number | undefined {
    const h = this.history[asset];
    return h.length ? h[h.length - 1].price : undefined;
  }

  /** Seconds since the latest price was published. */
  age(asset: Asset): number | undefined {
    const h = this.history[asset];
    return h.length ? Math.max(0, Math.floor(Date.now() / 1000) - h[h.length - 1].t) : undefined;
  }

  /** Percent change over the last `seconds`: latest price against the price in force back then. */
  change(asset: Asset, seconds: number): number | undefined {
    const h = this.history[asset];
    if (h.length < 2) return undefined;
    const latest = h[h.length - 1];
    const cutoff = Date.now() / 1000 - seconds;
    const then = [...h].reverse().find((p) => p.t <= cutoff);
    return then ? ((latest.price - then.price) / then.price) * 100 : undefined;
  }

  private record(asset: Asset, point: PricePoint) {
    const series = this.history[asset];
    if (series.length && series[series.length - 1].t >= point.t) return;
    series.push(point);
    if (series.length > 400) series.splice(0, series.length - 400);
  }

  private recordParsed(parsed: { id: string; price: { price: string; expo: number; publish_time: number } }[] | null | undefined) {
    for (const p of parsed ?? []) {
      const asset = ASSETS.find((a) => FEED_IDS[a] === p.id.replace(/^0x/, ""));
      if (asset) this.record(asset, { t: p.price.publish_time, price: Number(p.price.price) * Math.pow(10, p.price.expo) });
    }
  }

  /** Loads the last five minutes of prices, so agents see 1- and 5-minute moves from their first decision. */
  private async backfill(hermes: HermesClient, ids: string[]) {
    const now = Math.floor(Date.now() / 1000);
    for (const ago of [300, 240, 180, 120, 60, 30]) {
      try {
        const past = await hermes.getPriceUpdatesAtTimestamp(now - ago, ids, { parsed: true });
        this.recordParsed(past.parsed);
      } catch {
        // history is a nicety; live prices fill it in within minutes anyway
      }
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
        const prices = ASSETS.map((a) => `${a} $${this.latest(a)?.toFixed(2) ?? "?"}`).join(", ");
        log("keeper", `posted update ${this.posted} (${prices}) in ${txs.length} transactions`, sigs[sigs.length - 1]);
      }
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message?.slice(0, 300) ?? String(e);
      if (this.failures <= 3 || this.failures % 30 === 0) {
        log("keeper", `update failed (${this.failures} in a row):`, this.lastError.slice(0, 200));
      }
      if (this.failures === 3) log("keeper", "until updates land again, new rounds use Pyth's sponsored devnet feeds");
    }
  }

  /** Reads Pyth's sponsored feed accounts (shard 0) from the chain. */
  private async watch() {
    try {
      const infos = await this.cfg.connection.getMultipleAccountsInfo(feedAccounts(SPONSORED_SHARD_ID));
      infos.forEach((info, i) => {
        const p = info ? decodePriceUpdate(info.data) : null;
        if (p) this.record(ASSETS[i], { t: p.publishTime, price: p.price });
      });
    } catch (e) {
      this.lastError = (e as Error).message?.slice(0, 300) ?? String(e);
    }
  }

  async run(until: number) {
    const ids = ASSETS.map((a) => FEED_IDS[a]);
    const hermes = this.hermes;
    if (hermes) await this.backfill(hermes, ids);
    else log("keeper", "PYTH_API_KEY is not set, so rounds use Pyth's sponsored devnet feeds (updated about every 5 minutes)");
    while (Date.now() < until) {
      const started = Date.now();
      if (hermes) await this.post(hermes, ids);
      if (!this.posting) await this.watch();
      await sleep(Math.max(1_000, this.cfg.keeperIntervalMs - (Date.now() - started)));
    }
  }
}
