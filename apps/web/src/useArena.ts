import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ENTRANT_SIZE,
  KIND_AGENT,
  MEMO_PROGRAM_ID,
  SHARD_ID,
  SPONSORED_SHARD_ID,
  bytesToHex,
  decodeEntrant,
  decodePriceUpdate,
  decodeRound,
  decodeTradeData,
  entrantPda,
  equityOf,
  feedAccounts,
  reasonHash,
  roundIdAt,
  roundPda,
  roundTimes,
  type Asset,
  type Entrant,
  type PythPrice,
  type Round,
} from "@turing-pit/sdk";
import { AUTHORITY, PROGRAM_ID } from "./config";

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
  trade: { asset: Asset; side: number; usd: number } | null;
  verified: boolean;
  /** The SHA-256 the program stored with the trade, in hex. */
  hash: string;
}

export interface Tally {
  ai: number;
  human: number;
  /** Settled rounds in which at least one human and one agent played. */
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
}

export interface ArenaState {
  now: number;
  roundId: number;
  start: number;
  end: number;
  round: Round | null;
  roundAddress: PublicKey | null;
  rows: Row[];
  prices: (PythPrice | null)[];
  thoughts: Thought[];
  tally: Tally;
  history: PastRound[];
  error: string | null;
  ready: boolean;
  /** The shard of the price feeds shown: the round's own, or before a round the fresher one. */
  priceShard: number;
  /** Whether the program is on this cluster; null until the first check. */
  deployed: boolean | null;
  refresh: () => void;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function parseThought(tx: ParsedTransactionWithMeta, sig: string, label: string): Thought | null {
  let reason: string | null = null;
  let trade: Thought["trade"] = null;
  let hash: Uint8Array | null = null;
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      const parsed = (ix as ParsedInstruction).parsed;
      reason = typeof parsed === "string" ? parsed : null;
    } else if (PROGRAM_ID && ix.programId.equals(PROGRAM_ID)) {
      const data = (ix as PartiallyDecodedInstruction).data;
      const decoded = data ? decodeTradeData(bs58.decode(data)) : null;
      if (decoded) {
        trade = { asset: decoded.asset, side: decoded.side, usd: decoded.usd };
        hash = decoded.reasonHash;
      }
    }
  }
  if (!reason || !trade || tx.meta?.err) return null;
  return {
    sig,
    label,
    ts: tx.blockTime ?? 0,
    reason,
    trade,
    verified: hash !== null && sameBytes(reasonHash(reason), hash),
    hash: hash ? bytesToHex(hash) : "",
  };
}

export function useArena(): ArenaState {
  const { connection } = useConnection();
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
  const [tick, setTick] = useState(0);
  const seen = useRef(new Map<string, Thought | null>());
  const rowsRef = useRef<Row[]>([]);

  const roundId = roundIdAt(now);
  const { start, end } = roundTimes(roundId);
  const roundAddress = useMemo(
    () => (PROGRAM_ID && AUTHORITY ? roundPda(PROGRAM_ID, AUTHORITY, roundId) : null),
    [roundId],
  );

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
    // Both price sources a round can use: the house keeper's shard and Pyth's sponsored feeds.
    const shards = [SHARD_ID, SPONSORED_SHARD_ID];
    const feeds = shards.flatMap((s) => feedAccounts(s));
    const load = async () => {
      try {
        const [roundInfo, ...feedInfos] = await connection.getMultipleAccountsInfo([roundAddress, ...feeds]);
        const r = roundInfo ? decodeRound(roundInfo.data) : null;
        const sets = shards.map((_, k) => feedInfos.slice(k * 3, k * 3 + 3).map((f) => (f ? decodePriceUpdate(f.data) : null)));
        // Show the round's own feeds; before a round exists, whichever source is fresher.
        const newest = (set: (PythPrice | null)[]) => Math.max(...set.map((x) => x?.publishTime ?? 0));
        const keeperFresher = newest(sets[0]) > 0 && newest(sets[0]) >= newest(sets[1]);
        const shard = r ? r.shardId : keeperFresher ? SHARD_ID : SPONSORED_SHARD_ID;
        let p = sets[shards.indexOf(shard)];
        if (!p && r) {
          const own = await connection.getMultipleAccountsInfo(r.feeds);
          p = own.map((f) => (f ? decodePriceUpdate(f.data) : null));
        }
        const live = p.map((x) => x?.price ?? 0) as [number, number, number];
        let next: Row[] = [];
        if (r) {
          const accounts = await connection.getProgramAccounts(PROGRAM_ID!, {
            filters: [{ dataSize: ENTRANT_SIZE }, { memcmp: { offset: 8, bytes: roundAddress.toBase58() } }],
          });
          next = accounts
            .map((a) => ({ address: a.pubkey.toBase58(), entrant: decodeEntrant(a.account.data) }))
            .filter((x): x is { address: string; entrant: Entrant } => x.entrant !== null)
            .map(({ address, entrant }) => {
              const equity = entrant.settled ? entrant.finalEquity : equityOf(entrant, live);
              return { address, entrant, equity, pnlPct: ((equity - r.startCash) / r.startCash) * 100 };
            })
            .sort((a, b) => b.equity - a.equity);
        }
        if (cancelled) return;
        setRound(r);
        setPrices(p);
        setPriceShard(shard);
        setRows(next);
        rowsRef.current = next;
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
  }, [connection, roundAddress, tick]);

  // What the agents said, every 12 seconds. Transactions are fetched one at a time, so one the
  // RPC refuses (busy public RPCs answer 429) or can't return yet is simply tried on the next
  // pass, which comes sooner after a miss.
  useEffect(() => {
    if (!PROGRAM_ID) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const misses = new Map<string, number>();
    const load = async () => {
      const agents = rowsRef.current.filter((r) => r.entrant.kind === KIND_AGENT);
      let missed = agents.length === 0;
      for (const a of agents) {
        if (cancelled) return;
        let sigs: Awaited<ReturnType<typeof connection.getSignaturesForAddress>>;
        try {
          sigs = await connection.getSignaturesForAddress(a.entrant.player, { limit: 6 });
        } catch {
          missed = true;
          continue;
        }
        for (const s of sigs) {
          if (cancelled) return;
          if (seen.current.has(s.signature)) continue;
          if (s.err) {
            seen.current.set(s.signature, null);
            continue;
          }
          try {
            const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
            const tries = (misses.get(s.signature) ?? 0) + 1;
            if (tx) seen.current.set(s.signature, parseThought(tx, s.signature, a.entrant.label));
            else if (tries >= 5) seen.current.set(s.signature, null);
            else {
              misses.set(s.signature, tries);
              missed = true;
            }
          } catch {
            missed = true;
          }
        }
      }
      if (cancelled) return;
      const all = [...seen.current.values()].filter((x): x is Thought => x !== null);
      setThoughts(all.sort((a, b) => b.ts - a.ts).slice(0, 30));
      t = setTimeout(load, missed ? 3000 : 12000);
    };
    t = setTimeout(load, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [connection]);

  // Machines vs humans, and the recent winners, over the last 24 rounds (six hours), every minute.
  useEffect(() => {
    if (!PROGRAM_ID || !AUTHORITY) return;
    let cancelled = false;
    const load = async () => {
      const current = roundIdAt(Math.floor(Date.now() / 1000));
      const ids = Array.from({ length: 24 }, (_, i) => current - 1 - i);
      try {
        const infos = await connection.getMultipleAccountsInfo(ids.map((id) => roundPda(PROGRAM_ID!, AUTHORITY!, id)));
        const next: Tally = { ai: 0, human: 0, rounds: 0 };
        const done: { address: PublicKey; round: Round }[] = [];
        infos.forEach((info, i) => {
          const r = info ? decodeRound(info.data) : null;
          if (!r || !r.finalized || r.entrants === 0) return;
          done.push({ address: roundPda(PROGRAM_ID!, AUTHORITY!, ids[i]), round: r });
          if (r.agents === 0 || r.entrants === r.agents) return; // uncontested
          next.rounds++;
          if (r.winnerKind === KIND_AGENT) next.ai++;
          else next.human++;
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
          };
        });
        if (!cancelled) {
          setTally(next);
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
  }, [connection]);

  return {
    now,
    roundId,
    start,
    end,
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
    refresh: () => setTick((t) => t + 1),
  };
}
