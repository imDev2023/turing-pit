import { Connection } from "@solana/web3.js";
import { houseKeys } from "./keys.js";
import { politeFetch } from "./rpc.js";

/** Reads an environment variable; empty values count as unset (CI passes missing secrets as ""). */
export const env = (name: string, fallback?: string): string => {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
};

export function loadConfig() {
  const keys = houseKeys(env("PIT_SEED"));
  const rpcUrl = env("RPC_URL", "https://api.devnet.solana.com");
  return {
    keys,
    programId: keys.program.publicKey,
    // Paced, with 429s handled in politeFetch rather than by web3.js retrying each on its own.
    connection: new Connection(rpcUrl, { commitment: "confirmed", fetch: politeFetch(), disableRetryOnRateLimit: true }),
    hermesUrl: env("HERMES_URL", "https://hermes.pyth.network"),
    /** Hermes needs a Pyth API key. Without one the house can't post its own fresh prices and
     *  the rounds run on Pyth's sponsored devnet feeds instead. */
    pythApiKey: process.env.PYTH_API_KEY ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    agentModel: env("AGENT_MODEL", "claude-haiku-5-5"),
    /** How long this run lasts before exiting, so the next house shift can take over cleanly. */
    durationMs: Number(env("DURATION_MIN", "340")) * 60_000,
    keeperIntervalMs: Number(env("KEEPER_INTERVAL_MS", "10000")),
    agentIntervalMs: Number(env("AGENT_INTERVAL_MS", "45000")),
    /** Pins the Pyth receiver's fee treasury (0-255); by default each update picks one at random. */
    pythTreasuryId: process.env.PYTH_TREASURY_ID ? Number(process.env.PYTH_TREASURY_ID) : undefined,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(scope: string, ...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), `[${scope}]`, ...args);
}
