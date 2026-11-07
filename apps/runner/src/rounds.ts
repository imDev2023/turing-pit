// Opens a round every 15 minutes, then settles every entrant and names the winner once it ends.

import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ENTRANT_SIZE,
  ROUND_SECONDS,
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

  constructor(private cfg: Config) {}

  private async ensureRound(roundId: number) {
    if (await fetchRound(this.cfg, roundId)) return;
    const { start, end } = roundTimes(roundId);
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
          }),
        ],
        [this.cfg.keys.authority],
      );
      log("rounds", `opened round ${roundId} (${new Date(start * 1000).toISOString().slice(11, 16)} UTC)`, sig);
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
          batch.map((e) => settleIx({ programId: this.cfg.programId, round: found.address, entrant: e.address })),
          [this.cfg.keys.authority],
          { computeUnits: 400_000 },
        );
      } catch (e) {
        log("rounds", `settle failed in round ${roundId}:`, shortError(e));
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
      log("rounds", `finalize failed in round ${roundId}:`, shortError(e));
    }
  }

  /** Keeps the agents' wallets topped up from the house wallet. */
  private async topUpAgents() {
    const house = this.cfg.keys.authority;
    for (const agent of this.cfg.keys.agents) {
      const bal = await this.cfg.connection.getBalance(agent.publicKey);
      if (bal >= 0.05 * LAMPORTS_PER_SOL) continue;
      const houseBal = await this.cfg.connection.getBalance(house.publicKey);
      if (houseBal < 0.5 * LAMPORTS_PER_SOL) {
        log("rounds", "house wallet is low on devnet SOL:", houseBal / LAMPORTS_PER_SOL);
        return;
      }
      try {
        await sendIxs(
          this.cfg.connection,
          [SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: agent.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })],
          [house],
        );
        log("rounds", `topped up ${agent.publicKey.toBase58().slice(0, 6)}`);
      } catch (e) {
        log("rounds", "top-up failed:", shortError(e));
      }
    }
  }

  async run(until: number) {
    let lastTopUp = 0;
    while (Date.now() < until) {
      const now = Math.floor(Date.now() / 1000);
      const current = roundIdAt(now);
      const { end } = roundTimes(current);
      try {
        if (now < end - 60) await this.ensureRound(current);
        if (now >= (current + 1) * ROUND_SECONDS - 180) await this.ensureRound(current + 1);
        for (const id of [current - 2, current - 1, current]) {
          if (this.closed.has(id)) continue;
          if (now >= roundTimes(id).end + 3) await this.closeRound(id);
        }
        if (Date.now() - lastTopUp > 120_000) {
          lastTopUp = Date.now();
          await this.topUpAgents();
        }
      } catch (e) {
        log("rounds", "loop error:", shortError(e));
      }
      await sleep(5_000);
    }
  }
}
