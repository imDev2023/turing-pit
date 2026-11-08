// Client for the Turing Pit program: addresses, instructions and account decoding.
// Written by hand (no IDL) so the runner and the web app share one small, typed module.

import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";

export const PYTH_RECEIVER_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const PYTH_PUSH_ORACLE_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const ASSETS = ["SOL", "BTC", "ETH"] as const;
export type Asset = (typeof ASSETS)[number];

/** Pyth feed ids, in the program's asset order. */
export const FEED_IDS: Record<Asset, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

/** Our own shard of Pyth push-oracle price feed accounts, kept fresh by the runner's keeper. */
export const SHARD_ID = 101;
/** Shard 0 holds Pyth's sponsored feeds, which Pyth itself updates (about every 5 minutes on devnet). */
export const SPONSORED_SHARD_ID = 0;
/** Oldest price a trade may fill at, in seconds: with the house's keeper posting every few seconds... */
export const PRICE_AGE_KEEPER = 60;
/** ...and on Pyth's sponsored devnet feeds, whose heartbeat is about 5 minutes. */
export const PRICE_AGE_SPONSORED = 420;
/** A round on this shard fills at the house's own prices (its `HouseFeed`): the median of
 *  Binance, Coinbase, OKX and Hyperliquid, posted every couple of seconds... */
export const HOUSE_SHARD = 0xffff;
/** ...a price at most this many seconds old... */
export const PRICE_AGE_HOUSE = 20;
/** ...which the program keeps only within 1% of Pyth (in basis points)... */
export const GUARD_BPS = 100;
/** ...while that Pyth price is at most ten minutes old (seconds). */
export const GUARD_MAX_AGE = 600;
/** The exchanges the house's prices are the median of, in the order it reads them. */
export const EXCHANGES = ["Binance", "Coinbase", "OKX", "Hyperliquid"] as const;

/** Rounds run every 15 minutes: 14 minutes of trading, then a minute to settle. */
export const ROUND_SECONDS = 900;
export const TRADING_SECONDS = 840;
export const START_CASH = 10_000_000_000n; // $10,000 in micro-USD
export const FEE_BPS = 10; // 0.1%
export const MAX_ASSET_BPS = 5_000; // at most half of equity in one asset
export const MIN_TRADE_USD = 10;
/** Anyone may close a player's account this long after its round ends; the rent goes to the player. */
export const CLOSE_DELAY_SECONDS = 3 * 60 * 60;
/** The house can close a round's account this long after it ends, once its players' accounts are closed. */
export const ROUND_CLOSE_DELAY_SECONDS = 6 * 60 * 60;

export const KIND_HUMAN = 0;
export const KIND_AGENT = 1;
/** Buy: adds to a long, or covers a short first. */
export const SIDE_BUY = 0;
/** Sell: reduces a long, and past zero opens or adds to a short. */
export const SIDE_SELL = 1;
/** Close the whole position, long or short. */
export const SIDE_CLOSE = 2;

const MICRO = 1_000_000;
const QTY_SCALE = 1_000_000_000n;

const enc = new TextEncoder();
const dec = new TextDecoder();

function disc(name: string): Uint8Array {
  return sha256(enc.encode(name)).slice(0, 8);
}

const IX = {
  createRound: disc("global:create_round"),
  joinRound: disc("global:join_round"),
  trade: disc("global:trade"),
  settle: disc("global:settle"),
  finalizeRound: disc("global:finalize_round"),
  closeEntrant: disc("global:close_entrant"),
  closeRound: disc("global:close_round"),
  setPriceSource: disc("global:set_price_source"),
  openDuel: disc("global:open_duel"),
  postPrices: disc("global:post_prices"),
};
const ACCOUNT = {
  round: disc("account:Round"),
  entrant: disc("account:Entrant"),
  houseFeed: disc("account:HouseFeed"),
  priceUpdateV2: disc("account:PriceUpdateV2"),
};

export const ROUND_SIZE = 251;
/** Rounds written before `closed` was added; still decoded, with `closed` read as 0. */
const ROUND_SIZE_V1 = 247;
export const ENTRANT_SIZE = 191;
export const HOUSE_FEED_SIZE = 100;

// ---------- addresses ----------

export function u64le(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
}

export function roundPda(programId: PublicKey, authority: PublicKey, roundId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("round"), authority.toBytes(), u64le(roundId)],
    programId,
  )[0];
}

export function entrantPda(programId: PublicKey, round: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("entrant"), round.toBytes(), player.toBytes()],
    programId,
  )[0];
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The push-oracle price feed account for a feed in our shard. */
export function feedAccount(asset: Asset, shardId = SHARD_ID): PublicKey {
  const shard = new Uint8Array(2);
  new DataView(shard.buffer).setUint16(0, shardId, true);
  return PublicKey.findProgramAddressSync([shard, hexToBytes(FEED_IDS[asset])], PYTH_PUSH_ORACLE_ID)[0];
}

export function feedAccounts(shardId = SHARD_ID): [PublicKey, PublicKey, PublicKey] {
  return [feedAccount("SOL", shardId), feedAccount("BTC", shardId), feedAccount("ETH", shardId)];
}

/** A house's own price feed. */
export function houseFeedPda(programId: PublicKey, authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("house_feed"), authority.toBytes()], programId)[0];
}

/** The price accounts a round of `authority` on `shardId` reads, in asset order (a round's
 *  `feeds` hold the same three, once it exists). */
export function priceAccounts(programId: PublicKey, authority: PublicKey, shardId: number): [PublicKey, PublicKey, PublicKey] {
  if (shardId !== HOUSE_SHARD) return feedAccounts(shardId);
  const feed = houseFeedPda(programId, authority);
  return [feed, feed, feed];
}

// ---------- rounds ----------

// ---------- leagues ----------

export type LeagueKey = "sprint" | "hour" | "day" | "week" | "month" | "open" | "duel";
export interface League {
  key: LeagueKey;
  id: number;
  /** Tab label. */
  label: string;
  /** How a round of this league reads in a sentence ("a 1-hour round"). */
  noun: string;
  /** Nominal length, for display; the Open league has none. */
  seconds: number | null;
}

/** Every league runs its own rounds with its own leaderboard and winners. Sprint rounds keep the
 *  ids they always had (unix time / 900); the other leagues' ids start at `league id * 2^40`. */
export const LEAGUES: League[] = [
  { key: "sprint", id: 0, label: "15 min", noun: "15-minute", seconds: 900 },
  { key: "hour", id: 1, label: "1 hour", noun: "1-hour", seconds: 3_600 },
  { key: "day", id: 2, label: "1 day", noun: "1-day", seconds: 86_400 },
  { key: "week", id: 3, label: "1 week", noun: "1-week", seconds: 604_800 },
  { key: "month", id: 4, label: "1 month", noun: "1-month", seconds: 30 * 86_400 },
  { key: "open", id: 5, label: "Open", noun: "open-ended", seconds: null },
];
/** Duels are not a league with a schedule: a player opens each one (see `openDuelIx`). They
 *  take the next id range, so every round still tells what it is from its id alone. */
export const DUELS: League = { key: "duel", id: 6, label: "Duels", noun: "duel", seconds: null };
export const LEAGUE = Object.fromEntries([...LEAGUES, DUELS].map((l) => [l.key, l])) as Record<LeagueKey, League>;

const LEAGUE_BASE = 2 ** 40;
/** Trading stops this long before a period ends, so settling never overlaps the next round. */
export const SETTLE_SECONDS = ROUND_SECONDS - TRADING_SECONDS;
/** Weeks start on Monday 00:00 UTC (1970-01-05 was a Monday). */
const WEEK_ORIGIN = 4 * 86_400;
/** The Open league is one round, from 8 November 2026 for ten years. */
export const OPEN_START = Date.UTC(2026, 10, 8) / 1000;
export const OPEN_SECONDS = 3_650 * 86_400;

export function leagueOf(roundId: number): League {
  if (isDuel(roundId)) return DUELS;
  return roundId < LEAGUE_BASE ? LEAGUE.sprint : (LEAGUES[Math.floor(roundId / LEAGUE_BASE)] ?? LEAGUE.sprint);
}

/** The round of a league that is under way (or about to start) at a unix time. */
export function roundIdAt(unixSeconds: number, league: LeagueKey = "sprint"): number {
  const base = LEAGUE[league].id * LEAGUE_BASE;
  switch (league) {
    case "sprint":
      return Math.floor(unixSeconds / ROUND_SECONDS);
    case "hour":
      return base + Math.floor(unixSeconds / 3_600);
    case "day":
      return base + Math.floor(unixSeconds / 86_400);
    case "week":
      return base + Math.floor((unixSeconds - WEEK_ORIGIN) / 604_800);
    case "month": {
      const d = new Date(unixSeconds * 1000);
      return base + (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
    }
    case "open":
      return base;
    case "duel":
      throw new Error("duels have no schedule: each has its own id (newDuelId)");
  }
}

/** When a round starts, when its trading ends, and when its period is over (the next round's start). */
export function roundTimes(roundId: number): { start: number; end: number; next: number } {
  const league = leagueOf(roundId);
  const n = roundId - league.id * LEAGUE_BASE;
  let start: number;
  let next: number;
  switch (league.key) {
    case "sprint":
      start = roundId * ROUND_SECONDS;
      next = start + ROUND_SECONDS;
      break;
    case "hour":
      start = n * 3_600;
      next = start + 3_600;
      break;
    case "day":
      start = n * 86_400;
      next = start + 86_400;
      break;
    case "week":
      start = n * 604_800 + WEEK_ORIGIN;
      next = start + 604_800;
      break;
    case "month":
      start = Date.UTC(1970 + Math.floor(n / 12), n % 12, 1) / 1000;
      next = Date.UTC(1970 + Math.floor(n / 12), (n % 12) + 1, 1) / 1000;
      break;
    case "open":
      return { start: OPEN_START, end: OPEN_START + OPEN_SECONDS, next: Infinity };
    case "duel":
      throw new Error("a duel's times are on its round account");
  }
  return { start, end: next - SETTLE_SECONDS, next };
}

// ---------- duels ----------

/** One trade each against a house agent; the style caps how long the trade may stay open. */
export const DUEL_STYLES = [
  { key: "scalp", label: "Scalp", seconds: 15 * 60, limit: "15 minutes" },
  { key: "swing", label: "Swing", seconds: 7 * 86_400, limit: "7 days" },
  { key: "long", label: "Long-term", seconds: 30 * 86_400, limit: "30 days" },
] as const;
export const DUEL_BASE = 6 * LEAGUE_BASE;
export const DUEL_CASH = 10_000;

export function isDuel(roundId: number): boolean {
  return roundId >= DUEL_BASE && roundId - DUEL_BASE < LEAGUE_BASE;
}
/** A duel id: the style in bits 36-37, the challenged agent (its index in PERSONAS) in bits
 *  34-35, and 34 random bits. */
export function newDuelId(style: number, agent: number, random: () => number = Math.random): number {
  return DUEL_BASE + style * 2 ** 36 + agent * 2 ** 34 + Math.floor(random() * 2 ** 34);
}
export const duelStyle = (roundId: number): number => Math.floor((roundId - DUEL_BASE) / 2 ** 36) % 4;
export const duelAgent = (roundId: number): number => Math.floor((roundId - DUEL_BASE) / 2 ** 34) % 4;

/** A player's one duel trade, read back from their account: the program keeps the coins and the
 *  cash, so the entry price follows from what the trade cost, its 0.1% fee included. */
export function duelTrade(e: Pick<Entrant, "cash" | "qty">): { asset: Asset; long: boolean; coins: number; entry: number; size: number } | null {
  const i = e.qty.findIndex((q) => Math.abs(q) > 1e-12);
  if (i < 0) return null;
  const coins = Math.abs(e.qty[i]);
  const long = e.qty[i] > 0;
  const fee = FEE_BPS / 10_000;
  // A buy spends `size` of cash with the fee out of it; a sell brings in its proceeds less the fee.
  const size = long ? DUEL_CASH - e.cash : (e.cash - DUEL_CASH) / (1 - fee);
  return { asset: ASSETS[i], long, coins, entry: long ? (size * (1 - fee)) / coins : size / coins, size };
}

// ---------- instructions ----------

function concat(...parts: Uint8Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return Buffer.from(out);
}

function i64le(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
}

function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}

export function encodeLabel(label: string): Uint8Array {
  const out = new Uint8Array(24);
  out.set(enc.encode(label).slice(0, 24));
  return out;
}

export function decodeLabel(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return dec.decode(end === -1 ? bytes : bytes.slice(0, end));
}

export function reasonHash(reason: string): Uint8Array {
  return sha256(enc.encode(reason));
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});

export function createRoundIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  roundId: number;
  startTs: number;
  endTs: number;
  startCash?: bigint;
  feeBps?: number;
  maxAssetBps?: number;
  shardId?: number;
  /** Seconds; see PRICE_AGE_KEEPER and PRICE_AGE_SPONSORED. */
  maxPriceAge?: number;
}): TransactionInstruction {
  const round = roundPda(args.programId, args.authority, args.roundId);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [meta(round, false, true), meta(args.authority, true, true), meta(SystemProgram.programId, false, false)],
    data: concat(
      IX.createRound,
      u64le(args.roundId),
      i64le(args.startTs),
      i64le(args.endTs),
      u64le(args.startCash ?? START_CASH),
      u16le(args.feeBps ?? FEE_BPS),
      u16le(args.maxAssetBps ?? MAX_ASSET_BPS),
      u16le(args.shardId ?? SHARD_ID),
      u16le(args.maxPriceAge ?? PRICE_AGE_KEEPER),
    ),
  });
}

/** Opens a duel under the house's address; the player pays its rent. */
export function openDuelIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  player: PublicKey;
  roundId: number;
  style: number;
  shardId?: number;
  maxPriceAge?: number;
}): TransactionInstruction {
  const round = roundPda(args.programId, args.authority, args.roundId);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(round, false, true),
      meta(args.authority, false, false),
      meta(args.player, true, true),
      meta(SystemProgram.programId, false, false),
    ],
    data: concat(
      IX.openDuel,
      u64le(args.roundId),
      Uint8Array.of(args.style),
      u16le(args.shardId ?? SHARD_ID),
      u16le(args.maxPriceAge ?? PRICE_AGE_KEEPER),
    ),
  });
}

export function joinRoundIx(args: {
  programId: PublicKey;
  round: PublicKey;
  player: PublicKey;
  kind: number;
  label: string;
  /** The house co-signs agents; humans pass nothing. */
  registrar?: PublicKey;
}): TransactionInstruction {
  const entrant = entrantPda(args.programId, args.round, args.player);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.round, false, true),
      meta(entrant, false, true),
      meta(args.player, true, true),
      // Anchor reads a missing optional account as the program id itself.
      args.registrar ? meta(args.registrar, true, false) : meta(args.programId, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: concat(IX.joinRound, new Uint8Array([args.kind]), encodeLabel(args.label)),
  });
}

export function tradeIx(args: {
  programId: PublicKey;
  round: PublicKey;
  player: PublicKey;
  asset: Asset;
  side: number;
  /** Dollars: cash to spend on a buy, value to sell on a sell. */
  usd: number;
  reasonHash: Uint8Array;
  /** The round's price accounts (`round.feeds`, or `priceAccounts` for a round opened in the
   *  same transaction). Without them, the Pyth accounts of `shardId`. */
  feeds?: PublicKey[];
  shardId?: number;
}): TransactionInstruction {
  const entrant = entrantPda(args.programId, args.round, args.player);
  const [sol, btc, eth] = args.feeds ?? feedAccounts(args.shardId);
  const micro = BigInt(Math.floor(args.usd * MICRO));
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.round, false, false),
      meta(entrant, false, true),
      meta(args.player, true, false),
      meta(sol, false, false),
      meta(btc, false, false),
      meta(eth, false, false),
    ],
    data: concat(
      IX.trade,
      new Uint8Array([ASSETS.indexOf(args.asset), args.side]),
      u64le(micro),
      args.reasonHash,
    ),
  });
}

export function settleIx(args: {
  programId: PublicKey;
  round: PublicKey;
  entrant: PublicKey;
  /** The round's price accounts (`round.feeds`); without them, the Pyth accounts of `shardId`. */
  feeds?: PublicKey[];
  shardId?: number;
}): TransactionInstruction {
  const [sol, btc, eth] = args.feeds ?? feedAccounts(args.shardId);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.round, false, true),
      meta(args.entrant, false, true),
      meta(sol, false, false),
      meta(btc, false, false),
      meta(eth, false, false),
    ],
    data: concat(IX.settle),
  });
}

export function finalizeRoundIx(args: {
  programId: PublicKey;
  round: PublicKey;
  entrants: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [meta(args.round, false, true), ...args.entrants.map((e) => meta(e, false, false))],
    data: concat(IX.finalizeRound),
  });
}

/** Closes a player's account in a finalized round; the rent goes back to the player. */
export function closeEntrantIx(args: {
  programId: PublicKey;
  round: PublicKey;
  player: PublicKey;
  /** Signs; the player itself, or anyone once CLOSE_DELAY_SECONDS have passed. */
  closer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.round, false, true),
      meta(entrantPda(args.programId, args.round, args.player), false, true),
      meta(args.player, false, true),
      meta(args.closer, true, false),
    ],
    data: concat(IX.closeEntrant),
  });
}

/** Closes a finalized round whose player accounts are all closed; the rent goes back to the house. */
export function closeRoundIx(args: { programId: PublicKey; round: PublicKey; authority: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [meta(args.round, false, true), meta(args.authority, true, true)],
    data: concat(IX.closeRound),
  });
}

/** House only: moves an unfinished round to another price source (shard and price age limit). */
export function setPriceSourceIx(args: {
  programId: PublicKey;
  round: PublicKey;
  authority: PublicKey;
  shardId: number;
  maxPriceAge: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [meta(args.round, false, true), meta(args.authority, true, false)],
    data: concat(IX.setPriceSource, u16le(args.shardId), u16le(args.maxPriceAge)),
  });
}

/** House only: posts its prices (dollars per coin; 0 leaves an asset as it is), each the median
 *  of `sources[i]` exchanges. `guards` are verified Pyth price accounts for SOL, BTC and ETH
 *  (any shard): the program keeps a price only within 1% of its guard's. */
export function postPricesIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  prices: readonly number[];
  sources: readonly number[];
  guards: readonly PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(houseFeedPda(args.programId, args.authority), false, true),
      meta(args.authority, true, true),
      ...args.guards.map((g) => meta(g, false, false)),
      meta(SystemProgram.programId, false, false),
    ],
    data: concat(
      IX.postPrices,
      ...args.prices.map((p) => u64le(BigInt(Math.round(p * MICRO)))),
      Uint8Array.from(args.sources, (n) => Math.min(255, n)),
    ),
  });
}

export function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(enc.encode(text)),
  });
}

/** Decodes a trade instruction's data, for showing what an agent did next to its memo. */
export function decodeTradeData(data: Uint8Array):
  | { asset: Asset; side: number; usd: number; reasonHash: Uint8Array }
  | null {
  if (data.length !== 8 + 1 + 1 + 8 + 32) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== IX.trade[i]) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const asset = ASSETS[data[8]];
  if (!asset) return null;
  return {
    asset,
    side: data[9],
    usd: Number(dv.getBigUint64(10, true)) / MICRO,
    reasonHash: data.slice(18, 50),
  };
}

// ---------- accounts ----------

function hasDisc(data: Uint8Array, d: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
  return true;
}

function pk(data: Uint8Array, at: number): PublicKey {
  return new PublicKey(data.slice(at, at + 32));
}

export interface Round {
  authority: PublicKey;
  roundId: number;
  startTs: number;
  endTs: number;
  startCash: number; // dollars
  feeBps: number;
  maxAssetBps: number;
  shardId: number;
  feeds: PublicKey[];
  entrants: number;
  agents: number;
  settled: number;
  finalized: boolean;
  winner: PublicKey;
  winnerEquity: number; // dollars
  winnerKind: number;
  bestHumanEquity: number;
  bestAgentEquity: number;
  /** Seconds: the oldest price a trade may fill at in this round. */
  maxPriceAge: number;
  /** Player accounts closed so far; the house can close the round once this equals `entrants`. */
  closed: number;
}

export function decodeRound(data: Uint8Array): Round | null {
  if (data.length < ROUND_SIZE_V1 || !hasDisc(data, ACCOUNT.round)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => dv.getBigUint64(o, true);
  const i64 = (o: number) => Number(dv.getBigInt64(o, true));
  return {
    authority: pk(data, 8),
    roundId: Number(u64(40)),
    startTs: i64(48),
    endTs: i64(56),
    startCash: Number(u64(64)) / MICRO,
    feeBps: dv.getUint16(72, true),
    maxAssetBps: dv.getUint16(74, true),
    shardId: dv.getUint16(76, true),
    feeds: [pk(data, 78), pk(data, 110), pk(data, 142)],
    entrants: dv.getUint32(174, true),
    agents: dv.getUint32(178, true),
    settled: dv.getUint32(182, true),
    finalized: data[186] === 1,
    winner: pk(data, 187),
    winnerEquity: Number(u64(219)) / MICRO,
    winnerKind: data[227],
    bestHumanEquity: Number(u64(228)) / MICRO,
    bestAgentEquity: Number(u64(236)) / MICRO,
    maxPriceAge: dv.getUint16(245, true),
    closed: data.length >= ROUND_SIZE ? dv.getUint32(247, true) : 0,
  };
}

export interface Entrant {
  round: PublicKey;
  player: PublicKey;
  kind: number;
  label: string;
  cash: number; // dollars
  qty: [number, number, number]; // whole coins, negative for a short
  trades: number;
  joinedTs: number;
  lastTradeTs: number;
  lastReasonHash: Uint8Array;
  finalEquity: number; // dollars
  settled: boolean;
}

export function decodeEntrant(data: Uint8Array): Entrant | null {
  if (data.length < ENTRANT_SIZE || !hasDisc(data, ACCOUNT.entrant)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => dv.getBigUint64(o, true);
  // Positions are signed (negative is a short), in billionths of a coin; a double holds them
  // exactly up to 9 million coins.
  const coins = (o: number) => Number(dv.getBigInt64(o, true)) / Number(QTY_SCALE);
  const kind = data[72];
  const label = decodeLabel(data.slice(73, 97));
  return {
    round: pk(data, 8),
    player: pk(data, 40),
    kind,
    // The house agents joined their first rounds as "Claude …"; they are "Agent …" now.
    label: kind === KIND_AGENT ? label.replace(/^Claude /, "Agent ") : label,
    cash: Number(u64(97)) / MICRO,
    qty: [coins(105), coins(113), coins(121)],
    trades: dv.getUint32(129, true),
    joinedTs: Number(dv.getBigInt64(133, true)),
    lastTradeTs: Number(dv.getBigInt64(141, true)),
    lastReasonHash: data.slice(149, 181),
    finalEquity: Number(u64(181)) / MICRO,
    settled: data[189] === 1,
  };
}

export interface HouseFeed {
  authority: PublicKey;
  /** Dollars per coin, by asset; 0 until first posted. */
  prices: [number, number, number];
  /** When each price was kept, unix seconds by the chain's clock. */
  times: [number, number, number];
  /** How many exchanges each price is the median of. */
  sources: [number, number, number];
  posts: number;
}

export function decodeHouseFeed(data: Uint8Array): HouseFeed | null {
  if (data.length < HOUSE_FEED_SIZE || !hasDisc(data, ACCOUNT.houseFeed)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const price = (i: number) => Number(dv.getBigUint64(40 + 8 * i, true)) / MICRO;
  const time = (i: number) => Number(dv.getBigInt64(64 + 8 * i, true));
  return {
    authority: pk(data, 8),
    prices: [price(0), price(1), price(2)],
    times: [time(0), time(1), time(2)],
    sources: [data[88], data[89], data[90]],
    posts: Number(dv.getBigUint64(91, true)),
  };
}

/** A house feed's prices in the shape of Pyth's, so a round's marks read the same either way. */
export function houseFeedPrices(feed: HouseFeed): (PythPrice | null)[] {
  return ASSETS.map((a, i) => (feed.prices[i] > 0 ? { feedId: FEED_IDS[a], price: feed.prices[i], conf: 0, publishTime: feed.times[i] } : null));
}

export interface PythPrice {
  feedId: string;
  price: number; // dollars per coin
  conf: number;
  publishTime: number;
}

/** Parses a Pyth PriceUpdateV2 account, the same way the program does. */
export function decodePriceUpdate(data: Uint8Array): PythPrice | null {
  if (!hasDisc(data, ACCOUNT.priceUpdateV2)) return null;
  let o = 8 + 32;
  if (data[o] === 0) o += 2;
  else if (data[o] === 1) o += 1;
  else return null;
  if (data.length < o + 84) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const feedId = bytesToHex(data.slice(o, o + 32));
  const raw = dv.getBigInt64(o + 32, true);
  const conf = dv.getBigUint64(o + 40, true);
  const expo = dv.getInt32(o + 48, true);
  const publishTime = Number(dv.getBigInt64(o + 52, true));
  const scale = Math.pow(10, expo);
  return { feedId, price: Number(raw) * scale, conf: Number(conf) * scale, publishTime };
}

/** Mark-to-market equity in dollars. */
export function equityOf(e: Pick<Entrant, "cash" | "qty">, prices: [number, number, number]): number {
  return e.cash + e.qty[0] * prices[0] + e.qty[1] * prices[1] + e.qty[2] * prices[2];
}

// ---------- fills ----------

const EVENT = { traded: disc("event:Traded") };
/** Discriminator, three keys, asset, side, four u64s, the reason hash and a timestamp. */
const TRADED_SIZE = 8 + 32 * 3 + 1 + 1 + 8 * 4 + 32 + 8;

/** One trade as the program filled it, read from its `Traded` event. */
export interface Fill {
  round: PublicKey;
  entrant: PublicKey;
  player: PublicKey;
  asset: Asset;
  side: number;
  /** Dollars moved: the whole spend on a buy; the value before the fee on a sell or a close. */
  usd: number;
  /** Coins moved, always positive; the side says which way. */
  qty: number;
  /** The Pyth price it filled at, in dollars per coin. */
  price: number;
  fee: number;
  ts: number;
}

/** The fills in a transaction's log, where Anchor writes each event as a "Program data:" line. */
export function decodeFills(logs: readonly string[] | null | undefined): Fill[] {
  const out: Fill[] = [];
  for (const line of logs ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const data = new Uint8Array(Buffer.from(line.slice(14), "base64"));
    if (data.length < TRADED_SIZE || !hasDisc(data, EVENT.traded)) continue;
    const asset = ASSETS[data[104]];
    if (!asset) continue;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const u64 = (o: number) => Number(dv.getBigUint64(o, true));
    out.push({
      round: pk(data, 8),
      entrant: pk(data, 40),
      player: pk(data, 72),
      asset,
      side: data[105],
      usd: u64(106) / MICRO,
      qty: u64(114) / Number(QTY_SCALE),
      price: u64(122) / MICRO,
      fee: u64(130) / MICRO,
      ts: Number(dv.getBigInt64(170, true)),
    });
  }
  return out;
}

/** A player's position in one coin, rebuilt from their fills. */
export interface Position {
  asset: Asset;
  /** Coins: positive for a long, negative for a short. */
  qty: number;
  /** The open position's average price, in dollars per coin; 0 when flat. */
  entry: number;
  /** Profit or loss already taken by reducing or closing, before fees. */
  realized: number;
  fees: number;
  trades: number;
}

/** Replays one player's fills, oldest first, into a position per coin with its average entry.
 *  Adding to a position averages the entry; reducing it books profit against the entry; going
 *  through zero opens the rest at the fill price. */
export function replayFills(fills: readonly Fill[]): Position[] {
  const book: Position[] = ASSETS.map((asset) => ({ asset, qty: 0, entry: 0, realized: 0, fees: 0, trades: 0 }));
  for (const f of fills) {
    const p = book[ASSETS.indexOf(f.asset)];
    const old = p.qty;
    const delta = f.side === SIDE_BUY ? f.qty : f.side === SIDE_SELL ? -f.qty : -old;
    if (old === 0 || Math.sign(delta) === Math.sign(old)) {
      p.entry = (p.entry * Math.abs(old) + f.price * Math.abs(delta)) / (Math.abs(old) + Math.abs(delta));
    } else {
      const closed = Math.min(Math.abs(delta), Math.abs(old));
      p.realized += closed * (f.price - p.entry) * Math.sign(old);
      if (Math.abs(delta) > Math.abs(old)) p.entry = f.price;
    }
    p.qty = Math.abs(old + delta) < 1e-10 ? 0 : old + delta;
    if (p.qty === 0) p.entry = 0;
    p.fees += f.fee;
    p.trades += 1;
  }
  return book;
}

/** The program's error messages, in the order of its error enum (Anchor numbers them from 6000). */
export const PIT_ERRORS = [
  "The round must end after it starts and last at most ten years",
  "A parameter is out of range",
  "Joining is closed for this round",
  "This round is full",
  "Agents must be registered by the house",
  "The round is not live",
  "The round has not ended",
  "Unknown asset",
  "Trade is below the $10 minimum",
  "Not enough cash",
  "Nothing to sell",
  "That would make one position, long or short, more than half your equity",
  "Wrong or malformed price account",
  "Price must be positive",
  "Price is too old; try again in a few seconds",
  "Arithmetic overflow",
  "Entrant already settled",
  "Round already finalized",
  "Finalize needs every entrant of the round",
  "Not an entrant of this round",
  "Entrant listed twice",
  "Every entrant must be settled first",
  "The round is not finalized yet",
  "Only the player can close this account until three hours after the round",
  "Every player's account must be closed first",
  "A round can be closed six hours after it ends",
  "Your equity is gone: you can only close or reduce positions",
  "In a duel you open one trade, then close it",
  "This duel already has its player and its agent",
  "No price kept: each must be within 1% of a Pyth price at most 10 minutes old",
];

/** Turns a transaction error into something a player can read. */
export function explainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const custom = text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (custom) {
    const code = parseInt(custom[1], 16);
    const msg = PIT_ERRORS[code - 6000];
    if (msg) return msg;
  }
  const anchor = text.match(/Error Message: ([^.]+)/);
  if (anchor) return anchor[1];
  if (/insufficient (funds|lamports)|debit an account/i.test(text)) return "Your wallet needs a little devnet SOL for fees";
  if (/User rejected/i.test(text)) return "Cancelled in your wallet";
  return text.slice(0, 160);
}

// ---------- agents ----------

export interface Persona {
  label: string;
  style: string;
}

/** The three house agents. The arena shows these exact words, and the runner sends them to Claude. */
export const PERSONAS: Persona[] = [
  {
    label: "Agent Momentum",
    style:
      "You are a momentum trader. You go long what has been rising and short what has been falling. You size up when a move is clean and you never fight the trend.",
  },
  {
    label: "Agent Contrarian",
    style:
      "You are a contrarian. You buy sharp dips and short sharp spikes, expecting moves to snap back. You stay patient and keep some cash for the next overreaction.",
  },
  {
    label: "Agent Degen",
    style:
      "You are an aggressive risk-taker. You make concentrated bets, long or short, swing for the win, and hate sitting in cash when you are behind on the leaderboard.",
  },
];

/** The full system prompt an agent runs with, for a league. */
export function agentSystemPrompt(persona: Persona, league: League = LEAGUE.sprint): string {
  const open = league.key === "open";
  return [
    `You are ${persona.label}, an AI trader in Turing Pit, where AI agents and humans compete in paper trading on Solana.`,
    open
      ? "You are playing the Open league: one round with no end, where the highest equity leads."
      : `You are playing a ${league.noun} round: the highest equity when trading stops wins.`,
    persona.style,
    "Rules: trade SOL, BTC or ETH at live prices, long or short. Buy to go long or to cover a short; sell to cut a long, and sell more than you hold to go short; close to flatten a whole position.",
    "Every entrant starts with $10,000. Trades cost 0.1%. No single position, long or short, may exceed 50% of your equity. Minimum trade $10.",
    "Only players who trade can win, so sitting in cash all round never wins.",
    "Your reason is published on chain next to your trade, so make it sharp, specific and under 200 characters.",
    "Call the decide tool exactly once.",
  ].join(" ");
}
