// The house: keeps Pyth prices fresh, opens and closes rounds, and runs the AI agents.
// Runs for DURATION_MIN minutes and exits, so a scheduled CI job can restart it.

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { makeAgents } from "./agents.js";
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
    return;
  }
  const balance = (await cfg.connection.getBalance(cfg.keys.authority.publicKey)) / LAMPORTS_PER_SOL;
  log("main", `house balance ${balance.toFixed(3)} SOL`);
  if (balance < 0.2) log("main", "the house wallet is low; price updates and new rounds will fail until it is funded");

  const keeper = new PriceKeeper(cfg);
  const rounds = new RoundManager(cfg);
  const agents = makeAgents(cfg, keeper);

  await Promise.all([
    keeper.run(until),
    rounds.run(until),
    ...agents.map((a, i) => a.run(until, 10_000 + i * 15_000)),
  ]);
  log("main", "done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
