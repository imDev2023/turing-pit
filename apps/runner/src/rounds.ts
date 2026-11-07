// Opens a round every 15 minutes, then settles every entrant and names the winner once it ends.

import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  CLOSE_DELAY_SECONDS,
  ENTRANT_SIZE,
  PRICE_AGE_KEEPER,
  ROUND_SECONDS,
  SHARD_ID,
  closeEntrantIx,
  createRoundIx,
  decodeEntrant,
  decodeRound,
  finalizeRoundIx,
  roundIdAt,
  roundPda,
  roundTimes,
  settleIx,
  type Entrant,
  type Round,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import type { PriceSource } from "./keeper.js";
import { sendIxs, shortError } from "./send.js";

export async function fetchRound(cfg: Config, roundId: number): Promise<{ address: PublicKey; round: Round } | null> {
  const address = roundPda(cfg.programId, cfg.keys.authority.publicKey, roundId);
  const info = await cfg.connection.getAccountInfo(address);
  const round = info ? decodeRound(info.data) : null;
  return round ? { address, round } : null;
}

export async function fetchEntrants(cfg: Config, round: PublicKey): Promise<{ address: PublicKey; entrant: Entrant }[]> {
  const accounts = await cfg.connection.getProgramAccounts(cfg.programId, {
    filters: [{ dataSize: ENTRANT_SIZE }, { memcmp: { offset: 8, bytes: round.toBase58() } }],
  });
  return accounts
    .map((a) => ({ address: a.pubkey, entrant: decodeEntrant(a.account.data) }))
    .filter((x): x is { address: PublicKey; entrant: Entrant } => x.entrant !== null);
}

export class RoundManager {
  private closed = new Set<number>();
  /** Last time a settle or finalize failure was logged per round, so a stall doesn't flood the log. */
  private complained = new Map<number, number>();

  private complain(roundId: number, ...args: unknown[]) {
    if (Date.now() - (this.complained.get(roundId) ?? 0) < 60_000) return;
    this.complained.set(roundId, Date.now());
    log("rounds", ...args);
  }

  /** `prices` picks each new round's price feeds; by default the keeper's own shard. */
  constructor(
    private cfg: Config,
    private prices: { source(): PriceSource } = { source: () => ({ shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER }) },
  ) {}

  private async ensureRound(roundId: number) {
    if (await fetchRound(this.cfg, roundId)) return;
    const { start, end } = roundTimes(roundId);
    const src = this.prices.source();
    try {
      const sig = await sendIxs(
        this.cfg.connection,
        [
          createRoundIx({
            programId: this.cfg.programId,
            authority: this.cfg.keys.authority.publicKey,
            roundId,
            startTs: start,
            endTs: end,
            shardId: src.shardId,
            maxPriceAge: src.maxPriceAge,
          }),
        ],
        [this.cfg.keys.authority],
      );
      const feeds = src.shardId === SHARD_ID ? "the house's own Pyth updates" : `Pyth's sponsored feeds (shard ${src.shardId})`;
      log("rounds", `opened round ${roundId} (${new Date(start * 1000).toISOString().slice(11, 16)} UTC) on ${feeds}, prices up to ${src.maxPriceAge}s old`, sig);
    } catch (e) {
      log("rounds", `could not open round ${roundId}:`, shortError(e));
    }
  }

  private async closeRound(roundId: number) {
    const found = await fetchRound(this.cfg, roundId);
    if (!found) return void this.closed.add(roundId);
    if (found.round.finalized) return void this.closed.add(roundId);

    const entrants = await fetchEntrants(this.cfg, found.address);
    const unsettled = entrants.filter((e) => !e.entrant.settled);
    for (let i = 0; i < unsettled.length; i += 4) {
      const batch = unsettled.slice(i, i + 4);
      try {
        await sendIxs(
          this.cfg.connection,
          batch.map((e) =>
            settleIx({ programId: this.cfg.programId, round: found.address, entrant: e.address, shardId: found.round.shardId }),
          ),
          [this.cfg.keys.authority],
          { computeUnits: 400_000 },
        );
      } catch (e) {
        this.complain(roundId, `settle failed in round ${roundId}:`, shortError(e));
        return; // try again on the next pass, once prices are fresh
      }
    }
    if (entrants.length !== found.round.entrants) return; // an entrant is still indexing; retry
    try {
      const sig = await sendIxs(
        this.cfg.connection,
        [finalizeRoundIx({ programId: this.cfg.programId, round: found.address, entrants: entrants.map((e) => e.address) })],
        [this.cfg.keys.authority],
        { computeUnits: 400_000 },
      );
      this.closed.add(roundId);
      const best = [...entrants].sort((a, b) => b.entrant.finalEquity - a.entrant.finalEquity)[0];
      log("rounds", `round ${roundId} finalized, winner ${best?.entrant.label ?? "none"}`, sig);
    } catch (e) {
      this.complain(roundId, `finalize failed in round ${roundId}:`, shortError(e));
    }
  }

  /**
   * Keeps the agents' wallets topped up from the house wallet. An agent spends about 0.0023 SOL a
   * round (its player account's rent plus fees), so 0.1 SOL lasts it about 40 rounds. The house
   * keeps a reserve for posting prices and opening rounds.
   */
  private async topUpAgents() {
    const house = this.cfg.keys.authority;
    const agentLow = 0.03 * LAMPORTS_PER_SOL;
    const topUp = 0.1 * LAMPORTS_PER_SOL;
    const houseReserve = 0.1 * LAMPORTS_PER_SOL;
    for (const agent of this.cfg.keys.agents) {
      const bal = await this.cfg.connection.getBalance(agent.publicKey);
      if (bal >= agentLow) continue;
      const houseBal = await this.cfg.connection.getBalance(house.publicKey);
      if (houseBal < topUp + houseReserve) {
        log("rounds", `house wallet is low on devnet SOL (${(houseBal / LAMPORTS_PER_SOL).toFixed(3)}), so the agents can't be topped up`);
        return;
      }
      try {
        await sendIxs(
          this.cfg.connection,
          [SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: agent.publicKey, lamports: topUp })],
          [house],
        );
        log("rounds", `topped up ${agent.publicKey.toBase58().slice(0, 6)}`);
      } catch (e) {
        log("rounds", "top-up failed:", shortError(e));
      }
    }
  }

  /**
   * Closes the player accounts of rounds that ended more than three hours ago. The rent goes back
   * to each player, mostly the house's own agents, which keeps the arena cheap to run.
   */
  private async tidyUp() {
    const now = Math.floor(Date.now() / 1000);
    const accounts = await this.cfg.connection.getProgramAccounts(this.cfg.programId, {
      filters: [{ dataSize: ENTRANT_SIZE }],
    });
    const byRound = new Map<string, PublicKey[]>();
    for (const a of accounts) {
      const e = decodeEntrant(a.account.data);
      if (e) byRound.set(e.round.toBase58(), [...(byRound.get(e.round.toBase58()) ?? []), e.player]);
    }
    for (const [key, players] of byRound) {
      const round = new PublicKey(key);
      const info = await this.cfg.connection.getAccountInfo(round);
      const r = info ? decodeRound(info.data) : null;
      if (!r?.finalized || now < r.endTs + CLOSE_DELAY_SECONDS + 30) continue;
      for (let i = 0; i < players.length; i += 8) {
        const batch = players.slice(i, i + 8);
        const closer = this.cfg.keys.authority;
        try {
          await sendIxs(
            this.cfg.connection,
            batch.map((player) => closeEntrantIx({ programId: this.cfg.programId, round, player, closer: closer.publicKey })),
            [closer],
          );
          log("rounds", `closed ${batch.length} player account(s) from round ${r.roundId}; their rent went back to the players`);
        } catch (e) {
          log("rounds", `closing player accounts from round ${r.roundId} failed:`, shortError(e));
        }
      }
    }
  }

  async run(until: number) {
    let lastTopUp = 0;
    let lastTidy = 0;
    while (Date.now() < until) {
      const now = Math.floor(Date.now() / 1000);
      const current = roundIdAt(now);
      const { end } = roundTimes(current);
      try {
        if (now < end - 60) await this.ensureRound(current);
        if (now >= (current + 1) * ROUND_SECONDS - 180) await this.ensureRound(current + 1);
        // Settling needs fresh prices; if Pyth's feeds stall, keep retrying rounds for two hours.
        for (let id = current - 8; id <= current; id++) {
          if (this.closed.has(id)) continue;
          if (now >= roundTimes(id).end + 3) await this.closeRound(id);
        }
        if (Date.now() - lastTopUp > 120_000) {
          lastTopUp = Date.now();
          await this.topUpAgents();
        }
        if (Date.now() - lastTidy > 600_000) {
          lastTidy = Date.now();
          await this.tidyUp();
        }
      } catch (e) {
        log("rounds", "loop error:", shortError(e));
      }
      await sleep(5_000);
    }
  }
}
