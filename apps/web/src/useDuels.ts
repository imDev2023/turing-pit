import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { ENTRANT_SIZE, KIND_AGENT, ROUND_SIZE, decodeEntrant, decodeRound, isDuel, type Entrant, type Round } from "@turing-pit/sdk";
import { AUTHORITY, PROGRAM_ID } from "./config";
import { SOURCE_ACCOUNTS, bestSource, readSources, type Prices, type Source } from "./sources";

export interface Duel {
  address: PublicKey;
  round: Round;
  human: { address: PublicKey; entrant: Entrant } | null;
  agent: { address: PublicKey; entrant: Entrant } | null;
}

export interface DuelsState {
  duels: Duel[];
  /** Live prices by source, for marking open duel trades. */
  prices: Record<number, Prices>;
  /** The price source a new duel should use: the freshest that is working. */
  source: Source;
  ready: boolean;
  refresh: () => void;
}

/** Every duel under the house's address (open ones, and finished ones until their accounts are
 *  closed), with both players' accounts and the prices that mark them, every 5 seconds. */
export function useDuels(enabled: boolean): DuelsState {
  const { connection } = useConnection();
  const [duels, setDuels] = useState<Duel[]>([]);
  const [prices, setPrices] = useState<Record<number, Prices>>({});
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !PROGRAM_ID || !AUTHORITY) return;
    let cancelled = false;
    const load = async () => {
      try {
        // Byte 45 of a round account is the sixth byte of its id: 6 ("7" in base58) for duels.
        const [rounds, entrants, feeds] = await Promise.all([
          connection.getProgramAccounts(PROGRAM_ID!, {
            filters: [{ dataSize: ROUND_SIZE }, { memcmp: { offset: 8, bytes: AUTHORITY!.toBase58() } }, { memcmp: { offset: 45, bytes: "7" } }],
          }),
          connection.getProgramAccounts(PROGRAM_ID!, { filters: [{ dataSize: ENTRANT_SIZE }] }),
          connection.getMultipleAccountsInfo(SOURCE_ACCOUNTS),
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
        if (cancelled) return;
        setDuels(list);
        setPrices(readSources(feeds));
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

  return {
    duels,
    prices,
    source: bestSource(prices, Date.now() / 1000),
    ready,
    refresh: () => setTick((t) => t + 1),
  };
}
