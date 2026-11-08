// The house: keeps Pyth prices fresh, opens and closes rounds, runs the AI agents and has them
// answer players' duels.
// Runs for DURATION_MIN minutes and exits, so a house shift (scripts/house-shift.sh) can hand over
// cleanly. Exit code 3 means the program isn't deployed yet, so there is nothing to run.

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { makeAgents } from "./agents.js";
import { DuelManager } from "./duels.js";
import { loadConfig, log } from "./config.js";
import { PriceKeeper } from "./keeper.js";
import { RoundManager } from "./rounds.js";

async function main() {
  const cfg = loadConfig();
  const until = Date.now() + cfg.durationMs;
  log("main", `program ${cfg.programId.toBase58()}`);
  log("main", `house ${cfg.keys.authority.publicKey.toBase58()}`);
  log("main", `running until ${new Date(until).toISOString()}`);

  const program = await cfg.connection.getAccountInfo(cfg.programId);
  if (!program?.executable) {
    log("main", "the program is not deployed on this cluster yet; nothing to run");
    process.exit(3);
  }
  const balance = (await cfg.connection.getBalance(cfg.keys.authority.publicKey)) / LAMPORTS_PER_SOL;
  log("main", `house balance ${balance.toFixed(3)} SOL`);
  if (balance < 0.2) log("main", "the house wallet is low; price updates and new rounds will fail until it is funded");

  const keeper = new PriceKeeper(cfg);
  const rounds = new RoundManager(cfg, keeper);
  const agents = makeAgents(cfg, keeper);
  const duels = new DuelManager(cfg, keeper);

  const keeping = keeper.run(until);
  // With a Pyth API key, give the keeper a moment to post, so new rounds use its fresh prices.
  await keeper.ready(45_000);
  log("main", keeper.posting ? "the keeper is posting fresh Pyth prices" : "rounds will use Pyth's sponsored devnet feeds");
  await Promise.all([keeping, rounds.run(until), duels.run(until), ...agents.map((a, i) => a.run(until, 10_000 + i * 15_000))]);
  log("main", "done");
}

// A stray rejection from a websocket or an RPC call must not take the whole house down.
process.on("unhandledRejection", (e) => log("main", "unhandled rejection:", (e as Error)?.message ?? e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
