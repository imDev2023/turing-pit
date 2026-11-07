// Prints the public addresses derived from PIT_SEED (never the private keys).
// Usage: PIT_SEED=... pnpm --filter @turing-pit/runner keys [--json]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { houseKeys } from "./keys.js";

const keys = houseKeys(process.env.PIT_SEED ?? "");
const out = {
  programId: keys.program.publicKey.toBase58(),
  authority: keys.authority.publicKey.toBase58(),
  agents: keys.agents.map((a) => a.publicKey.toBase58()),
};

// With --write, also writes the keypair files the Solana and Anchor CLIs need (CI only).
const write = process.argv.indexOf("--write");
if (write !== -1) {
  const [deployerPath, programPath] = process.argv.slice(write + 1, write + 3);
  for (const [path, kp] of [
    [deployerPath, keys.authority],
    [programPath, keys.program],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  }
}

console.log(JSON.stringify(out, null, 2));
