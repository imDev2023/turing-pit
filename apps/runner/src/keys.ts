// Every key the house uses is derived from one secret, PIT_SEED, so CI and the runner agree
// on the same addresses without any private key ever being stored or passed around.

import { sha256 } from "@noble/hashes/sha256";
import { Keypair } from "@solana/web3.js";

export const AGENT_NAMES = ["agent-0", "agent-1", "agent-2"] as const;

export function deriveKeypair(seed: string, name: string): Keypair {
  const bytes = sha256(new TextEncoder().encode(`turing-pit:${seed}:${name}`));
  return Keypair.fromSeed(bytes);
}

export function houseKeys(seed: string) {
  if (!seed || seed.length < 16) throw new Error("PIT_SEED must be set (16+ characters)");
  return {
    /** Deploys the program, opens rounds, registers agents, runs the price keeper. */
    authority: deriveKeypair(seed, "deployer"),
    program: deriveKeypair(seed, "program"),
    agents: AGENT_NAMES.map((n) => deriveKeypair(seed, n)),
  };
}
