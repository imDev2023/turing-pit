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
  decodeEntrant,
  decodePriceUpdate,
  decodeRound,
  decodeTradeData,
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
}

export interface Tally {
  ai: number;
  human: number;
  rounds: number;
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
  error: string | null;
  ready: boolean;
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
  };
}

export function useArena(): ArenaState {
  const { connection } = useConnection();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [round, setRound] = useState<Round | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<(PythPrice | null)[]>([null, null, null]);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [tally, setTally] = useState<Tally>({ ai: 0, human: 0, rounds: 0 });
  const [error, setError] = useState<string | null>(PROGRAM_ID && AUTHORITY ? null : "This build has no program id yet.");
  const [ready, setReady] = useState(false);
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

  // Round, entrants and prices, every 4 seconds.
  useEffect(() => {
    if (!PROGRAM_ID || !roundAddress) return;
    let cancelled = false;
    const feeds = feedAccounts();
    const load = async () => {
      try {
        const [roundInfo, ...feedInfos] = await connection.getMultipleAccountsInfo([roundAddress, ...feeds]);
        const r = roundInfo ? decodeRound(roundInfo.data) : null;
        const p = feedInfos.map((f) => (f ? decodePriceUpdate(f.data) : null));
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

  // What the agents said, every 12 seconds.
  useEffect(() => {
    if (!PROGRAM_ID) return;
    let cancelled = false;
    const load = async () => {
      const agents = rowsRef.current.filter((r) => r.entrant.kind === KIND_AGENT);
      try {
        const fresh: { sig: string; label: string }[] = [];
        for (const a of agents) {
          const sigs = await connection.getSignaturesForAddress(a.entrant.player, { limit: 6 });
          for (const s of sigs) if (!seen.current.has(s.signature)) fresh.push({ sig: s.signature, label: a.entrant.label });
        }
        if (fresh.length) {
          const txs = await connection.getParsedTransactions(
            fresh.map((f) => f.sig),
            { maxSupportedTransactionVersion: 0 },
          );
          txs.forEach((tx, i) => seen.current.set(fresh[i].sig, tx ? parseThought(tx, fresh[i].sig, fresh[i].label) : null));
        }
        if (cancelled) return;
        const all = [...seen.current.values()].filter((t): t is Thought => t !== null);
        setThoughts(all.sort((a, b) => b.ts - a.ts).slice(0, 30));
      } catch {
        // The feed is best-effort; the next pass retries.
      }
    };
    const first = setTimeout(load, 1500);
    const t = setInterval(load, 12000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [connection]);

  // Machines vs humans over the last 24 rounds, every minute.
  useEffect(() => {
    if (!PROGRAM_ID || !AUTHORITY) return;
    let cancelled = false;
    const load = async () => {
      const current = roundIdAt(Math.floor(Date.now() / 1000));
      const ids = Array.from({ length: 24 }, (_, i) => current - 1 - i);
      try {
        const infos = await connection.getMultipleAccountsInfo(ids.map((id) => roundPda(PROGRAM_ID!, AUTHORITY!, id)));
        const next: Tally = { ai: 0, human: 0, rounds: 0 };
        for (const info of infos) {
          const r = info ? decodeRound(info.data) : null;
          if (!r || !r.finalized || r.entrants === 0) continue;
          next.rounds++;
          if (r.winnerKind === KIND_AGENT) next.ai++;
          else next.human++;
        }
        if (!cancelled) setTally(next);
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
    error,
    ready,
    refresh: () => setTick((t) => t + 1),
  };
}
