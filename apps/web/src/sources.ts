// The price sources a round can fill at: the house's feed (the median of four exchanges, kept
// within 1% of Pyth), the keeper's shard of Pyth updates, and Pyth's sponsored devnet feeds. The
// house posts its prices only while someone trades, so between trades the site marks positions at
// Coinbase's free live quotes.

import type { AccountInfo, PublicKey } from "@solana/web3.js";
import {
  ASSETS,
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
  houseFeedPrices,
  type Asset,
  type PythPrice,
} from "@turing-pit/sdk";
import { AUTHORITY, PROGRAM_ID } from "./config";
import type { Quote } from "./market";

export type Prices = (PythPrice | null)[];
export type Source = { shardId: number; maxPriceAge: number };

/** The house's price feed account. */
export const HOUSE_FEED = PROGRAM_ID && AUTHORITY ? houseFeedPda(PROGRAM_ID, AUTHORITY) : null;
const house = HOUSE_FEED;

/** Every source's accounts: the house's feed, then Pyth's three per shard. */
export const SOURCE_ACCOUNTS: PublicKey[] = [...(house ? [house] : []), ...feedAccounts(SHARD_ID), ...feedAccounts(SPONSORED_SHARD_ID)];

/** Each source's prices by shard id, from the accounts in SOURCE_ACCOUNTS. */
export function readSources(infos: (AccountInfo<Uint8Array> | null)[]): Record<number, Prices> {
  const feed = house && infos[0] ? decodeHouseFeed(infos[0].data) : null;
  const pyth = (house ? infos.slice(1) : infos).map((f) => (f ? decodePriceUpdate(f.data) : null));
  return {
    [HOUSE_SHARD]: feed ? houseFeedPrices(feed) : [null, null, null],
    [SHARD_ID]: pyth.slice(0, 3),
    [SPONSORED_SHARD_ID]: pyth.slice(3, 6),
  };
}

/** The source a new round or duel should use: the house's prices once the house has posted
 *  in the last day (it posts more as soon as someone trades), else the keeper's Pyth updates
 *  while fresh, else Pyth's sponsored feeds. */
export function bestSource(prices: Record<number, Prices>, now: number): Source {
  const within = (shard: number, age: number) => {
    const p = prices[shard] ?? [];
    return p.length === 3 && p.every((x) => x && now - x.publishTime < age);
  };
  if (within(HOUSE_SHARD, 86_400)) return { shardId: HOUSE_SHARD, maxPriceAge: PRICE_AGE_HOUSE };
  if (within(SHARD_ID, PRICE_AGE_KEEPER - 15)) return { shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER };
  return { shardId: SPONSORED_SHARD_ID, maxPriceAge: PRICE_AGE_SPONSORED };
}

/** What to mark positions at: the round's own price while a trade could still fill at it, else
 *  Coinbase's live quote (the next trade posts a fresh price anyway). */
export function markPrices(prices: Prices, quotes: Partial<Record<Asset, Quote>>, maxAge: number, now: number): [number, number, number] {
  return ASSETS.map((a, i) => {
    const p = prices[i];
    if (p && now - p.publishTime <= maxAge) return p.price;
    return quotes[a]?.price ?? p?.price ?? 0;
  }) as [number, number, number];
}

/** What a source is called where a price shows where it came from. */
export function sourceName(shardId: number): string {
  return shardId === HOUSE_SHARD ? "Exchange median" : shardId === SHARD_ID ? "Pyth" : "Pyth sponsored feed";
}

/** How old a price may be before a trade can't fill at it, by source. */
export function sourceLimit(shardId: number): number {
  return shardId === HOUSE_SHARD ? PRICE_AGE_HOUSE : shardId === SHARD_ID ? PRICE_AGE_KEEPER : PRICE_AGE_SPONSORED;
}
