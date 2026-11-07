// Keeps our shard of Pyth price feed accounts fresh on devnet, and records recent prices for
// the agents. Updates are Wormhole-verified Pyth data, so the house chooses only when to post,
// never the price.

import { Wallet } from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { ASSETS, FEED_IDS, SHARD_ID, type Asset } from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";

export interface PricePoint {
  t: number; // unix seconds
  price: number;
}

export class PriceKeeper {
  readonly history: Record<Asset, PricePoint[]> = { SOL: [], BTC: [], ETH: [] };
  private hermes: HermesClient;
  private receiver: PythSolanaReceiver;
  private failures = 0;

  constructor(private cfg: Config) {
    this.hermes = new HermesClient(cfg.hermesUrl, {});
    this.receiver = new PythSolanaReceiver({
      connection: cfg.connection,
      wallet: new Wallet(cfg.keys.authority),
    });
  }

  latest(asset: Asset): number | undefined {
    const h = this.history[asset];
    return h.length ? h[h.length - 1].price : undefined;
  }

  /** Percent change over the last `seconds`, from the keeper's own history. */
  change(asset: Asset, seconds: number): number | undefined {
    const h = this.history[asset];
    if (h.length < 2) return undefined;
    const now = h[h.length - 1];
    const then = [...h].reverse().find((p) => now.t - p.t >= seconds) ?? h[0];
    return ((now.price - then.price) / then.price) * 100;
  }

  private record(parsed: { id: string; price: { price: string; expo: number; publish_time: number } }[] | null | undefined) {
    for (const p of parsed ?? []) {
      const asset = ASSETS.find((a) => FEED_IDS[a] === p.id.replace(/^0x/, ""));
      if (!asset) continue;
      const point = { t: p.price.publish_time, price: Number(p.price.price) * Math.pow(10, p.price.expo) };
      const series = this.history[asset];
      if (series.length && series[series.length - 1].t >= point.t) continue;
      series.push(point);
      if (series.length > 400) series.splice(0, series.length - 400);
    }
  }

  /** Loads the last five minutes of prices, so agents see 1- and 5-minute moves from their first decision. */
  private async backfill(ids: string[]) {
    const now = Math.floor(Date.now() / 1000);
    for (const ago of [300, 240, 180, 120, 60, 30]) {
      try {
        const past = await this.hermes.getPriceUpdatesAtTimestamp(now - ago, ids, { parsed: true });
        this.record(past.parsed);
      } catch {
        // history is a nicety; live prices fill it in within minutes anyway
      }
    }
  }

  async run(until: number) {
    const ids = ASSETS.map((a) => FEED_IDS[a]);
    await this.backfill(ids);
    while (Date.now() < until) {
      const started = Date.now();
      try {
        const update = await this.hermes.getLatestPriceUpdates(ids, { encoding: "base64", parsed: true });
        this.record(update.parsed);
        const builder = this.receiver.newTransactionBuilder({ closeUpdateAccounts: true });
        await builder.addUpdatePriceFeed(update.binary.data, SHARD_ID);
        const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 2_000 });
        await this.receiver.provider.sendAll(txs, { skipPreflight: true, commitment: "confirmed" });
        this.failures = 0;
      } catch (e) {
        this.failures++;
        log("keeper", `update failed (${this.failures} in a row):`, (e as Error).message?.slice(0, 200));
      }
      await sleep(Math.max(1_000, this.cfg.keeperIntervalMs - (Date.now() - started)));
    }
  }
}
