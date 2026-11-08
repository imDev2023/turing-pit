import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import {
  ENTRANT_SIZE,
  KIND_AGENT,
  PRICE_AGE_KEEPER,
  PRICE_AGE_SPONSORED,
  ROUND_SIZE,
  SHARD_ID,
  SPONSORED_SHARD_ID,
  decodeEntrant,
  decodePriceUpdate,
  decodeRound,
  feedAccounts,
  isDuel,
  type Entrant,
  type PythPrice,
  type Round,
} from "@turing-pit/sdk";
import { AUTHORITY, PROGRAM_ID } from "./config";

export interface Duel {
  address: PublicKey;
  round: Round;
  human: { address: PublicKey; entrant: Entrant } | null;
  agent: { address: PublicKey; entrant: Entrant } | null;
}

export interface DuelsState {
  duels: Duel[];
  /** Live prices by shard, for marking open duel trades. */
  prices: Record<number, (PythPrice | null)[]>;
  /** The price source a new duel should use: the house's fresh feeds when they are fresh. */
  source: { shardId: number; maxPriceAge: number };
  ready: boolean;
  refresh: () => void;
}

/** Every duel under the house's address (open ones, and finished ones until their accounts are
 *  closed), with both players' accounts and the prices that mark them, every 5 seconds. */
export function useDuels(enabled: boolean): DuelsState {
  const { connection } = useConnection();
  const [duels, setDuels] = useState<Duel[]>([]);
  const [prices, setPrices] = useState<Record<number, (PythPrice | null)[]>>({});
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !PROGRAM_ID || !AUTHORITY) return;
    let cancelled = false;
    const shards = [SHARD_ID, SPONSORED_SHARD_ID];
    const load = async () => {
      try {
        // Byte 45 of a round account is the sixth byte of its id: 6 ("7" in base58) for duels.
        const [rounds, entrants, feeds] = await Promise.all([
          connection.getProgramAccounts(PROGRAM_ID!, {
            filters: [{ dataSize: ROUND_SIZE }, { memcmp: { offset: 8, bytes: AUTHORITY!.toBase58() } }, { memcmp: { offset: 45, bytes: "7" } }],
          }),
          connection.getProgramAccounts(PROGRAM_ID!, { filters: [{ dataSize: ENTRANT_SIZE }] }),
          connection.getMultipleAccountsInfo(shards.flatMap((s) => feedAccounts(s))),
        ]);
        const byRound = new Map<string, { address: PublicKey; entrant: Entrant }[]>();
        for (const a of entrants) {
          const e = decodeEntrant(a.account.data);
          if (!e) continue;
          const k = e.round.toBase58();
          byRound.set(k, [...(byRound.get(k) ?? []), { address: a.pubkey, entrant: e }]);
        }
        const list: Duel[] = rounds
          .map((a) => ({ address: a.pubkey, round: decodeRound(a.account.data) }))
          .filter((d): d is { address: PublicKey; round: Round } => !!d.round && isDuel(d.round.roundId))
          .map(({ address, round }) => {
            const es = byRound.get(address.toBase58()) ?? [];
            return {
              address,
              round,
              human: es.find((e) => e.entrant.kind !== KIND_AGENT) ?? null,
              agent: es.find((e) => e.entrant.kind === KIND_AGENT) ?? null,
            };
          })
          .sort((a, b) => b.round.startTs - a.round.startTs);
        const decoded = feeds.map((f) => (f ? decodePriceUpdate(f.data) : null));
        if (cancelled) return;
        setDuels(list);
        setPrices({ [SHARD_ID]: decoded.slice(0, 3), [SPONSORED_SHARD_ID]: decoded.slice(3, 6) });
        setReady(true);
      } catch {
        // tried again on the next pass
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connection, enabled, tick]);

  const now = Date.now() / 1000;
  const keeper = prices[SHARD_ID] ?? [];
  const fresh = keeper.length === 3 && keeper.every((p) => p && now - p.publishTime < PRICE_AGE_KEEPER - 15);
  return {
    duels,
    prices,
    source: fresh ? { shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER } : { shardId: SPONSORED_SHARD_ID, maxPriceAge: PRICE_AGE_SPONSORED },
    ready,
    refresh: () => setTick((t) => t + 1),
  };
}
