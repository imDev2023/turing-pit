import {
  ComputeBudgetProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { land } from "./rpc.js";

/**
 * Signs and sends one transaction and waits for confirmation. The first signer pays.
 * Clusters drop transactions now and then, so the signed bytes are re-sent every few seconds
 * until they land (see `land`, which polls instead of subscribing); if the blockhash expires
 * first, the transaction is rebuilt (at most three times), after checking the old one really
 * did not land, so nothing executes twice.
 */
export async function sendIxs(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  opts: { computeUnits?: number; microLamports?: number } = {},
): Promise<string> {
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports ?? 5_000 }),
  ];
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions: [...budget, ...ixs],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign(signers);
    const raw = tx.serialize();
    try {
      // Preflight runs on the first send, so program errors surface here with their logs.
      return await land(connection, raw, { lastValidBlockHeight }, true);
    } catch (e) {
      // `land` has already checked that an expired transaction did not land after all.
      if (!(e instanceof TransactionExpiredBlockheightExceededError) || attempt >= 3) throw e;
    }
  }
}

/** Pulls the program's error message out of a failed simulation, for readable logs. */
export function shortError(e: unknown): string {
  const err = e as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const logs = err.logs ?? err.transactionLogs ?? [];
  const msg = logs.find((l) => l.includes("Error Message:")) ?? err.message ?? String(e);
  return msg.replace(/^Program log: /, "").slice(0, 300);
}
