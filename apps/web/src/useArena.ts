import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  type Connection,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ENTRANT_SIZE,
  KIND_AGENT,
  LEAGUE,
  LEAGUES,
  MEMO_PROGRAM_ID,
  SHARD_ID,
  bytesToHex,
  decodeEntrant,
  decodeFills,
  decodePriceUpdate,
  decodeRound,
  decodeTradeData,
  entrantPda,
  equityOf,
  reasonHash,
  roundIdAt,
  roundPda,
  roundTimes,
  type Asset,
  type Entrant,
  type Fill,
  type League,
  type LeagueKey,
  type PythPrice,
  type Round,
} from "@turing-pit/sdk";
import { AUTHORITY, PROGRAM_ID } from "./config";
import { SOURCE_ACCOUNTS, bestSource, readSources } from "./sources";

export interface Row {
  address: string;
  entrant: Entrant;
  equity: number;
  pnlPct: number;
}

export interface Thought {
  sig: string;
  label: string;
  ts: number;
  reason: string;
  trade: { asset: Asset; side: number; usd: number };
  /** The Pyth price the trade filled at, from the program's event. */
  price: number | null;
  /** The round the trade was in, as an address. */
  round: string | null;
  verified: boolean;
  /** The SHA-256 the program stored with the trade, in hex. */
  hash: string;
}

export interface Tally {
  ai: number;
  human: number;
  /** Settled rounds in which at least one human and one agent traded. */
  rounds: number;
}

export interface PastRound {
  roundId: number;
  start: number;
  entrants: number;
  agents: number;
  winnerLabel: string;
  winnerKind: number;
  winnerEquity: number;
  startCash: number;
  /** False when nobody traded, so nobody won. */
  won: boolean;
}

/** How the league's previous round ended, and how the connected player did in it. */
export interface LastRound {
  roundId: number;
  start: number;
  end: number;
  finalized: boolean;
  traders: number;
  winnerLabel: string | null;
  winnerKind: number;
  winnerPnlPct: number | null;
  mine: { traded: boolean; rank: number | null; equity: number; pnlPct: number } | null;
}

export type RoundFill = Fill & { sig: string };

export interface ArenaState {
  league: League;
  now: number;
  roundId: number;
  start: number;
  /** When trading stops. */
  end: number;
  /** When the next round of this league starts; Infinity for the Open league. */
  next: number;
  round: Round | null;
  roundAddress: PublicKey | null;
  rows: Row[];
  prices: (PythPrice | null)[];
  thoughts: Thought[];
  tally: Tally;
  history: PastRound[];
  error: string | null;
  ready: boolean;
  /** The source of the prices shown: the round's own, or before a round the one a new round would use. */
  priceShard: number;
  /** Whether the program is on this cluster; null until the first check. */
  deployed: boolean | null;
  /** Everyone's fills in this round (its latest 40 transactions), oldest first. */
  fills: RoundFill[];
  /** The connected player's fills in this round, oldest first; null until they are all loaded. */
  myFills: Fill[] | null;
  lastRound: LastRound | null;
  /** The league of a round under way or just finished, by address. */
  leagueOfRound: (address: string | null) => League | null;
  refresh: () => void;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What the arena needs from one transaction: the memo, the trade instruction and its fills. */
interface TxInfo {
  slot: number;
  ts: number;
  reason: string | null;
  trade: { asset: Asset; side: number; usd: number; hash: Uint8Array } | null;
  fills: Fill[];
}

function parseTx(tx: ParsedTransactionWithMeta): TxInfo | null {
  if (tx.meta?.err) return null;
  let reason: string | null = null;
  let trade: TxInfo["trade"] = null;
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      const parsed = (ix as ParsedInstruction).parsed;
      reason = typeof parsed === "string" ? parsed : null;
    } else if (PROGRAM_ID && ix.programId.equals(PROGRAM_ID)) {
      const data = (ix as PartiallyDecodedInstruction).data;
      const d = data ? decodeTradeData(bs58.decode(data)) : null;
      if (d) trade = { asset: d.asset, side: d.side, usd: d.usd, hash: d.reasonHash };
    }
  }
  return { slot: tx.slot, ts: tx.blockTime ?? 0, reason, trade, fills: decodeFills(tx.meta?.logMessages) };
}

function toThought(sig: string, info: TxInfo, label: string): Thought | null {
  if (!info.reason || !info.trade) return null;
  const fill = info.fills[0];
  return {
    sig,
    label,
    ts: info.ts,
    reason: info.reason,
    trade: { asset: info.trade.asset, side: info.trade.side, usd: info.trade.usd },
    price: fill?.price ?? null,
    round: fill ? fill.round.toBase58() : null,
    verified: sameBytes(reasonHash(info.reason), info.trade.hash),
    hash: bytesToHex(info.trade.hash),
  };
}

/** Transactions are read one at a time, a few a second at most: the public devnet RPC answers
 *  bursts with 429s. Each is read once and kept; one the RPC can't return yet is tried again on a
 *  later pass, five times at most. */
class TxReader {
  cache = new Map<string, TxInfo | null>();
  private tries = new Map<string, number>();
  private nextAt = 0;
  constructor(private connection: Connection) {}

  /** True once the transaction is known (or given up on); false to try again later. */
  async read(sig: string, failed = false): Promise<boolean> {
    if (this.cache.has(sig)) return true;
    if (failed) {
      this.cache.set(sig, null);
      return true;
    }
    const wait = Math.max(0, this.nextAt - Date.now());
    this.nextAt = Math.max(Date.now(), this.nextAt) + 300;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (this.cache.has(sig)) return true;
    try {
      const tx = await this.connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (tx) {
        this.cache.set(sig, parseTx(tx));
        return true;
      }
    } catch {
      // tried again on a later pass
    }
    const n = (this.tries.get(sig) ?? 0) + 1;
    this.tries.set(sig, n);
    if (n >= 5) this.cache.set(sig, null);
    return n >= 5;
  }
}

export function useArena(leagueKey: LeagueKey, player: PublicKey | null): ArenaState {
  const { connection } = useConnection();
  const league = LEAGUE[leagueKey];
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [round, setRound] = useState<Round | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<(PythPrice | null)[]>([null, null, null]);
  const [priceShard, setPriceShard] = useState(SHARD_ID);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [tally, setTally] = useState<Tally>({ ai: 0, human: 0, rounds: 0 });
  const [history, setHistory] = useState<PastRound[]>([]);
  const [error, setError] = useState<string | null>(PROGRAM_ID && AUTHORITY ? null : "This build has no program id yet.");
  const [ready, setReady] = useState(false);
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [fills, setFills] = useState<RoundFill[]>([]);
  const [myFills, setMyFills] = useState<Fill[] | null>(null);
  const [lastRound, setLastRound] = useState<LastRound | null>(null);
  const [tick, setTick] = useState(0);
  const reader = useMemo(() => new TxReader(connection), [connection]);
  /** Every agent seen on any board, so their reasons keep loading whichever league is shown. */
  const agents = useRef(new Map<string, { key: PublicKey; label: string }>());
  const thoughtSigs = useRef(new Map<string, string>());
  const shownLeague = useRef<LeagueKey | null>(null);

  const roundId = roundIdAt(now, leagueKey);
  const { start, end, next } = roundTimes(roundId);
  const roundAddress = useMemo(
    () => (PROGRAM_ID && AUTHORITY ? roundPda(PROGRAM_ID, AUTHORITY, roundId) : null),
    [roundId],
  );

  // Rounds of every league under way or just finished, to tag the agents' reasons. All leagues
  // change rounds on a quarter hour, so this only changes with the sprint round.
  const sprintId = roundIdAt(now);
  const roundLeagues = useMemo(() => {
    const map = new Map<string, League>();
    if (!PROGRAM_ID || !AUTHORITY) return map;
    const t = sprintId * 900 + 1;
    for (const l of LEAGUES) {
      const id = roundIdAt(t, l.key);
      for (const r of l.key === "open" ? [id] : [id, id - 1]) map.set(roundPda(PROGRAM_ID, AUTHORITY, r).toBase58(), l);
    }
    return map;
  }, [sprintId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Is the program on this cluster yet? Checked every 30 seconds until it is.
  useEffect(() => {
    if (!PROGRAM_ID) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const info = await connection.getAccountInfo(PROGRAM_ID!);
        if (cancelled) return;
        setDeployed(!!info?.executable);
        if (info?.executable) return;
      } catch {
        // retried below
      }
      if (!cancelled) t = setTimeout(check, 30_000);
    };
    check();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connection]);

  // Round, entrants and prices, every 4 seconds.
  useEffect(() => {
    if (!PROGRAM_ID || !roundAddress) return;
    let cancelled = false;
    if (shownLeague.current !== leagueKey) {
      // Another league's board must not show under this one's name, even for a moment.
      shownLeague.current = leagueKey;
      setRound(null);
      setRows([]);
      setReady(false);
    }
    const load = async () => {
      try {
        const [roundInfo, ...sourceInfos] = await connection.getMultipleAccountsInfo([roundAddress, ...SOURCE_ACCOUNTS]);
        const r = roundInfo ? decodeRound(roundInfo.data) : null;
        const sources = readSources(sourceInfos);
        // Show the round's own prices; before a round exists, the source a new one would use.
        const shard = r ? r.shardId : bestSource(sources, Date.now() / 1000).shardId;
        let p = sources[shard];
        if (!p && r) {
          const own = await connection.getMultipleAccountsInfo(r.feeds);
          p = own.map((f) => (f ? decodePriceUpdate(f.data) : null));
        }
        const live = p.map((x) => x?.price ?? 0) as [number, number, number];
        let list: Row[] = [];
        if (r) {
          const accounts = await connection.getProgramAccounts(PROGRAM_ID!, {
            filters: [{ dataSize: ENTRANT_SIZE }, { memcmp: { offset: 8, bytes: roundAddress.toBase58() } }],
          });
          list = accounts
            .map((a) => ({ address: a.pubkey.toBase58(), entrant: decodeEntrant(a.account.data) }))
            .filter((x): x is { address: string; entrant: Entrant } => x.entrant !== null)
            .map(({ address, entrant }) => {
              const equity = entrant.settled ? entrant.finalEquity : equityOf(entrant, live);
              return { address, entrant, equity, pnlPct: ((equity - r.startCash) / r.startCash) * 100 };
            })
            // Traders first, by equity: only they can win.
            .sort((a, b) => Number(b.entrant.trades > 0) - Number(a.entrant.trades > 0) || b.equity - a.equity);
          for (const row of list) {
            if (row.entrant.kind === KIND_AGENT)
              agents.current.set(row.entrant.player.toBase58(), { key: row.entrant.player, label: row.entrant.label });
          }
        }
        if (cancelled) return;
        setRound(r);
        setPrices(p);
        setPriceShard(shard);
        setRows(list);
        setError(null);
        setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connection, roundAddress, leagueKey, tick]);

  // What the agents said, in every league, every 12 seconds (3 after a miss).
  useEffect(() => {
    if (!PROGRAM_ID) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      const all: Thought[] = [];
      for (const [sig, label] of thoughtSigs.current) {
        const info = reader.cache.get(sig);
        const th = info ? toThought(sig, info, label) : null;
        if (th) all.push(th);
      }
      setThoughts(all.sort((a, b) => b.ts - a.ts).slice(0, 40));
    };
    const load = async () => {
      const list = [...agents.current.values()];
      let missed = list.length === 0;
      for (const a of list) {
        if (cancelled) return;
        let sigs: Awaited<ReturnType<typeof connection.getSignaturesForAddress>>;
        try {
          sigs = await connection.getSignaturesForAddress(a.key, { limit: 6 });
        } catch {
          missed = true;
          continue;
        }
        for (const s of sigs) {
          if (cancelled) return;
          thoughtSigs.current.set(s.signature, a.label);
          if (!(await reader.read(s.signature, !!s.err))) missed = true;
        }
        // Each agent's reasons show as soon as they are read.
        publish();
      }
      if (cancelled) return;
      publish();
      t = setTimeout(load, missed ? 3000 : 12000);
    };
    t = setTimeout(load, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connection, reader]);

  // Everyone's trades in this round, for the chart, every 8 seconds.
  useEffect(() => {
    if (!roundAddress) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    setFills([]);
    const load = async () => {
      let missed = false;
      try {
        const sigs = await connection.getSignaturesForAddress(roundAddress, { limit: 40 });
        for (const s of sigs) {
          if (cancelled) return;
          if (!(await reader.read(s.signature, !!s.err))) missed = true;
        }
        const list: (RoundFill & { slot: number })[] = [];
        for (const s of sigs) {
          const info = reader.cache.get(s.signature);
          for (const f of info?.fills ?? []) if (f.round.equals(roundAddress)) list.push({ ...f, sig: s.signature, slot: info!.slot });
        }
        list.sort((a, b) => a.slot - b.slot || a.ts - b.ts);
        if (!cancelled) setFills(list);
      } catch {
        missed = true;
      }
      if (!cancelled) t = setTimeout(load, missed ? 3000 : 8000);
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connection, reader, roundAddress]);

  // The connected player's own fills in this round, read again after each of their trades, so
  // the positions panel can show entry prices (the program keeps only the coins held).
  const me = player ? rows.find((r) => r.entrant.player.equals(player)) : undefined;
  const myTrades = me?.entrant.trades ?? -1;
  const mySeat = useRef("");
  useEffect(() => {
    const seat = `${roundAddress?.toBase58()}:${player?.toBase58()}`;
    if (mySeat.current !== seat) {
      // Another round or wallet: the last fills don't apply. After a trade they stay until the new list is in.
      mySeat.current = seat;
      setMyFills(null);
    }
    if (!player || !roundAddress || !PROGRAM_ID || myTrades < 0) return;
    const address = entrantPda(PROGRAM_ID, roundAddress, player);
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = async () => {
      attempts++;
      try {
        const sigs: Awaited<ReturnType<typeof connection.getSignaturesForAddress>> = [];
        let before: string | undefined;
        for (let page = 0; page < 5; page++) {
          const batch = await connection.getSignaturesForAddress(address, { limit: 1000, before });
          sigs.push(...batch);
          if (batch.length < 1000) break;
          before = batch[batch.length - 1].signature;
        }
        let missed = false;
        for (const s of sigs) {
          if (cancelled) return;
          if (!(await reader.read(s.signature, !!s.err))) missed = true;
        }
        const list: (Fill & { slot: number })[] = [];
        for (const s of sigs) {
          const info = reader.cache.get(s.signature);
          for (const f of info?.fills ?? []) if (f.entrant.equals(address)) list.push({ ...f, slot: info!.slot });
        }
        // Until every trade is in the RPC's index, try again shortly (the panel checks the
        // replayed positions against the chain, so a list that stays short is shown as unknown).
        if ((missed || list.length < myTrades) && attempts < 10) {
          if (!cancelled) t = setTimeout(load, 2500);
          return;
        }
        list.sort((a, b) => a.slot - b.slot || a.ts - b.ts);
        if (!cancelled) setMyFills(list);
      } catch {
        if (!cancelled) t = setTimeout(load, 3000);
      }
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connection, reader, roundAddress, player, myTrades]);

  // Machines vs humans, and the recent winners, over the league's last 24 rounds, every minute.
  useEffect(() => {
    setTally({ ai: 0, human: 0, rounds: 0 });
    setHistory([]);
    if (!PROGRAM_ID || !AUTHORITY || leagueKey === "open") return;
    let cancelled = false;
    const load = async () => {
      const current = roundIdAt(Math.floor(Date.now() / 1000), leagueKey);
      const ids = Array.from({ length: 24 }, (_, i) => current - 1 - i);
      try {
        const infos = await connection.getMultipleAccountsInfo(ids.map((id) => roundPda(PROGRAM_ID!, AUTHORITY!, id)));
        const score: Tally = { ai: 0, human: 0, rounds: 0 };
        const done: { address: PublicKey; round: Round }[] = [];
        infos.forEach((info, i) => {
          const r = info ? decodeRound(info.data) : null;
          if (!r || !r.finalized || r.entrants === 0) return;
          done.push({ address: roundPda(PROGRAM_ID!, AUTHORITY!, ids[i]), round: r });
          // The program records no winner when nobody traded.
          if (r.winnerEquity === 0 || r.agents === 0 || r.entrants === r.agents) return;
          score.rounds++;
          if (r.winnerKind === KIND_AGENT) score.ai++;
          else score.human++;
        });
        const recent = done.slice(0, 8);
        const winners = recent.length
          ? await connection.getMultipleAccountsInfo(recent.map((d) => entrantPda(PROGRAM_ID!, d.address, d.round.winner)))
          : [];
        const past: PastRound[] = recent.map((d, i) => {
          const w = winners[i] ? decodeEntrant(winners[i]!.data) : null;
          return {
            roundId: d.round.roundId,
            start: d.round.startTs,
            entrants: d.round.entrants,
            agents: d.round.agents,
            winnerLabel: w?.label || d.round.winner.toBase58().slice(0, 6),
            winnerKind: d.round.winnerKind,
            winnerEquity: d.round.winnerEquity,
            startCash: d.round.startCash,
            won: d.round.winnerEquity > 0,
          };
        });
        if (!cancelled) {
          setTally(score);
          setHistory(past);
        }
      } catch {
        // retried next minute
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connection, leagueKey]);

  // How the league's previous round ended, polled until the program has finalized it.
  useEffect(() => {
    setLastRound(null);
    if (!PROGRAM_ID || !AUTHORITY || leagueKey === "open") return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const prevId = roundId - 1;
    const address = roundPda(PROGRAM_ID, AUTHORITY, prevId);
    const load = async () => {
      try {
        const info = await connection.getAccountInfo(address);
        const r = info ? decodeRound(info.data) : null;
        if (!r || r.entrants === 0) return;
        const accounts = await connection.getProgramAccounts(PROGRAM_ID!, {
          filters: [{ dataSize: ENTRANT_SIZE }, { memcmp: { offset: 8, bytes: address.toBase58() } }],
        });
        const all = accounts.map((a) => decodeEntrant(a.account.data)).filter((e): e is Entrant => e !== null);
        const traders = all.filter((e) => e.trades > 0).sort((a, b) => b.finalEquity - a.finalEquity);
        const winner = r.winnerEquity > 0 ? all.find((e) => e.player.equals(r.winner)) : undefined;
        const mine = player ? all.find((e) => e.player.equals(player)) : undefined;
        const pnl = (equity: number) => ((equity - r.startCash) / r.startCash) * 100;
        if (cancelled) return;
        setLastRound({
          roundId: prevId,
          start: r.startTs,
          end: r.endTs,
          finalized: r.finalized,
          traders: traders.length,
          winnerLabel: r.winnerEquity > 0 ? winner?.label || r.winner.toBase58().slice(0, 6) : null,
          winnerKind: r.winnerKind,
          winnerPnlPct: r.winnerEquity > 0 ? pnl(r.winnerEquity) : null,
          mine: mine
            ? {
                traded: mine.trades > 0,
                rank: mine.trades > 0 && r.finalized ? traders.findIndex((e) => e.player.equals(mine.player)) + 1 : null,
                equity: mine.finalEquity,
                pnlPct: pnl(mine.finalEquity),
              }
            : null,
        });
        if (!r.finalized) t = setTimeout(load, 10_000);
      } catch {
        if (!cancelled) t = setTimeout(load, 10_000);
      }
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connection, leagueKey, roundId, player]);

  return {
    league,
    now,
    roundId,
    start,
    end,
    next,
    round,
    roundAddress,
    rows,
    prices,
    thoughts,
    tally,
    history,
    error,
    ready,
    priceShard,
    deployed,
    fills,
    myFills,
    lastRound,
    leagueOfRound: (address) => (address ? (roundLeagues.get(address) ?? null) : null),
    refresh: () => setTick((t) => t + 1),
  };
}
