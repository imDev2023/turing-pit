// Opens a round every 15 minutes, then settles every entrant and names the winner once it ends.
// Later it closes the players' accounts and then the round's own, so their rent comes back.

import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  CLOSE_DELAY_SECONDS,
  ENTRANT_SIZE,
  HOUSE_SHARD,
  LEAGUES,
  PRICE_AGE_KEEPER,
  ROUND_CLOSE_DELAY_SECONDS,
  ROUND_SIZE,
  SHARD_ID,
  closeEntrantIx,
  closeRoundIx,
  createRoundIx,
  decodeEntrant,
  decodeRound,
  finalizeRoundIx,
  leagueOf,
  roundIdAt,
  roundPda,
  roundTimes,
  setPriceSourceIx,
  settleIx,
  type Entrant,
  type Round,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import type { PriceSource } from "./keeper.js";
import { sendIxs, shortError } from "./send.js";
import { switches } from "./switches.js";

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
  /** Rounds that are settled and finalized (or gone), so the loop leaves them alone. */
  private finished = new Set<number>();
  /** Rounds known to exist, so the loop doesn't ask the chain again every five seconds. */
  private opened = new Set<number>();
  /** The price source at the last tidy-up, to tell a lasting change from a blip. */
  private lastSource = "";
  /** Last time a settle or finalize failure was logged per round, so a stall doesn't flood the log. */
  private complained = new Map<number, number>();

  private complain(roundId: number, ...args: unknown[]) {
    if (Date.now() - (this.complained.get(roundId) ?? 0) < 60_000) return;
    this.complained.set(roundId, Date.now());
    log("rounds", ...args);
  }

  /** `prices` picks each new round's price source (by default the keeper's own Pyth shard) and,
   *  for a round on the house's prices, posts a fresh price in the transaction that settles it. */
  constructor(
    private cfg: Config,
    private prices: { source(): PriceSource; priceIxs?(round: Round): TransactionInstruction[] } = {
      source: () => ({ shardId: SHARD_ID, maxPriceAge: PRICE_AGE_KEEPER }),
    },
  ) {}

  private async ensureRound(roundId: number) {
    if (this.opened.has(roundId)) return;
    if (await fetchRound(this.cfg, roundId)) return void this.opened.add(roundId);
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
      this.opened.add(roundId);
      const feeds =
        src.shardId === HOUSE_SHARD ? "the house's prices" : src.shardId === SHARD_ID ? "the house's own Pyth updates" : `Pyth's sponsored feeds (shard ${src.shardId})`;
      const when = new Date(start * 1000).toISOString().slice(0, 16).replace("T", " ");
      log("rounds", `opened ${leagueOf(roundId).label} round ${roundId} (from ${when} UTC) on ${feeds}, prices up to ${src.maxPriceAge}s old`, sig);
    } catch (e) {
      log("rounds", `could not open round ${roundId}:`, shortError(e));
    }
  }

  /** Points a round at another price source; the program allows it until the round is final. */
  private async moveRound(found: { address: PublicKey; round: Round }, src: PriceSource): Promise<string> {
    return sendIxs(
      this.cfg.connection,
      [
        setPriceSourceIx({
          programId: this.cfg.programId,
          round: found.address,
          authority: this.cfg.keys.authority.publicKey,
          shardId: src.shardId,
          maxPriceAge: src.maxPriceAge,
        }),
      ],
      [this.cfg.keys.authority],
    );
  }

  /** Settles every entrant of an ended round, then names its winner. */
  private async finishRound(roundId: number, moved = false): Promise<void> {
    const found = await fetchRound(this.cfg, roundId);
    if (!found) return void this.finished.add(roundId);
    if (found.round.finalized) return void this.finished.add(roundId);

    const entrants = await fetchEntrants(this.cfg, found.address);
    const unsettled = entrants.filter((e) => !e.entrant.settled);
    for (let i = 0; i < unsettled.length; i += 4) {
      const batch = unsettled.slice(i, i + 4);
      try {
        await sendIxs(
          this.cfg.connection,
          [
            // Open positions are marked at the price posted here.
            ...(this.prices.priceIxs?.(found.round) ?? []),
            ...batch.map((e) =>
              settleIx({ programId: this.cfg.programId, round: found.address, entrant: e.address, feeds: found.round.feeds }),
            ),
          ],
          [this.cfg.keys.authority],
          { computeUnits: 400_000 },
        );
      } catch (e) {
        const why = shortError(e);
        // A round can end on a source that has since stopped for good (the house's own Pyth
        // updates did, on 8 November), and it would never settle there. Ten minutes after its end,
        // it moves to the prices new rounds use, and its open positions are marked at those.
        const src = this.prices.source();
        const now = Math.floor(Date.now() / 1000);
        if (!moved && why.includes("StalePrice") && found.round.shardId !== src.shardId && now >= found.round.endTs + 600) {
          try {
            const sig = await this.moveRound(found, src);
            const at = src.shardId === HOUSE_SHARD ? "the house's prices" : `shard ${src.shardId} prices`;
            log("rounds", `${leagueOf(roundId).label} round ${roundId} ended on prices that have stopped; it settles at ${at} instead`, sig);
            return this.finishRound(roundId, true);
          } catch (moveError) {
            this.complain(roundId, `moving round ${roundId} to shard ${src.shardId} failed:`, shortError(moveError));
            return;
          }
        }
        this.complain(roundId, `settle failed in round ${roundId}:`, why);
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
      this.finished.add(roundId);
      const traded = entrants.filter((e) => e.entrant.trades > 0);
      const best = [...traded].sort((a, b) => b.entrant.finalEquity - a.entrant.finalEquity)[0];
      log("rounds", `${leagueOf(roundId).label} round ${roundId} finalized, winner ${best?.entrant.label ?? "none (nobody traded)"}`, sig);
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
   * Closes the player accounts of rounds that ended more than three hours ago (the rent goes back
   * to each player, mostly the house's own agents), then each round's own account six hours after
   * it ends (the rent goes back to the house). That keeps the arena's running cost down to fees.
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

    const authority = this.cfg.keys.authority;
    const rounds = await this.cfg.connection.getProgramAccounts(this.cfg.programId, {
      filters: [{ dataSize: ROUND_SIZE }, { memcmp: { offset: 8, bytes: authority.publicKey.toBase58() } }],
    });
    const closable: { address: PublicKey; round: Round }[] = [];
    for (const a of rounds) {
      const r = decodeRound(a.account.data);
      if (!r) continue;
      if (!r.finalized) {
        // A round left unfinished while the house was down: finish it, so it can be closed later.
        if (now >= r.endTs + 2 * 60 * 60 && now < r.endTs + 24 * 60 * 60) await this.finishRound(r.roundId);
        continue;
      }
      if (r.closed === r.entrants && now >= r.endTs + ROUND_CLOSE_DELAY_SECONDS + 30) closable.push({ address: a.pubkey, round: r });
    }
    for (let i = 0; i < closable.length; i += 8) {
      const batch = closable.slice(i, i + 8);
      const ids = batch.map((c) => c.round.roundId).join(", ");
      try {
        await sendIxs(
          this.cfg.connection,
          batch.map((c) => closeRoundIx({ programId: this.cfg.programId, round: c.address, authority: authority.publicKey })),
          [authority],
        );
        log("rounds", `closed round account(s) ${ids}; their rent went back to the house`);
      } catch (e) {
        log("rounds", `closing round account(s) ${ids} failed:`, shortError(e));
      }
    }
  }

  /** Long rounds (a day or more) outlive any one price source. Once a source has started or
   *  stopped landing for ten minutes (two tidy-ups in a row see the same source), the open long
   *  rounds move to the source new rounds use, so their trades keep filling. */
  private async followPriceSource() {
    const src = this.prices.source();
    const key = `${src.shardId}/${src.maxPriceAge}`;
    const stable = key === this.lastSource;
    this.lastSource = key;
    if (!stable) return;
    const now = Math.floor(Date.now() / 1000);
    for (const league of LEAGUES) {
      if (league.key === "sprint" || league.key === "hour") continue;
      const roundId = roundIdAt(now, league.key);
      const found = await fetchRound(this.cfg, roundId);
      if (!found || found.round.finalized || now >= found.round.endTs) continue;
      if (found.round.shardId === src.shardId && found.round.maxPriceAge === src.maxPriceAge) continue;
      try {
        const sig = await this.moveRound(found, src);
        const at = src.shardId === HOUSE_SHARD ? "the house's prices" : `shard ${src.shardId} prices`;
        log("rounds", `${league.label} round ${roundId} now fills at ${at} up to ${src.maxPriceAge}s old`, sig);
      } catch (e) {
        log("rounds", `moving ${league.label} round ${roundId} to shard ${src.shardId} failed:`, shortError(e));
      }
    }
  }

  async run(until: number) {
    let lastTopUp = 0;
    let lastTidy = 0;
    while (Date.now() < until) {
      const now = Math.floor(Date.now() / 1000);
      try {
        for (const league of LEAGUES) {
          const current = roundIdAt(now, league.key);
          const { end, next } = roundTimes(current);
          // Switched off (arena.json), the house opens nothing new but still finishes what ran.
          if (switches.house === "on") {
            if (now < end - 60) await this.ensureRound(current);
            if (league.key !== "open" && now >= next - 180) await this.ensureRound(current + 1);
          }
          // Settling needs fresh prices; if Pyth's feeds stall, keep retrying recent rounds
          // (two hours of sprints, the last two rounds of the longer leagues).
          const back = league.key === "sprint" ? 8 : 2;
          for (let id = current - back; id <= current; id++) {
            if (this.finished.has(id)) continue;
            if (now >= roundTimes(id).end + 3) await this.finishRound(id);
          }
        }
        if (Date.now() - lastTopUp > 120_000) {
          lastTopUp = Date.now();
          await this.topUpAgents();
        }
        if (Date.now() - lastTidy > 600_000) {
          lastTidy = Date.now();
          await this.tidyUp();
          await this.followPriceSource();
        }
      } catch (e) {
        log("rounds", "loop error:", shortError(e));
      }
      await sleep(5_000);
    }
  }
}
