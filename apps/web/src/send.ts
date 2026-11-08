import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction, type TransactionInstruction } from "@solana/web3.js";
import { explainError } from "@turing-pit/sdk";

export type Note = { ok: boolean; text: string; sig?: string };

/** Signs instructions in the wallet and lands them on devnet, whichever network the wallet shows. */
export function useSender(onDone?: () => void) {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const send = async (ixs: TransactionInstruction[], done: string): Promise<boolean> => {
    if (!publicKey) return false;
    setBusy(true);
    setNote(null);
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction().add(...ixs);
      tx.feePayer = publicKey;
      tx.recentBlockhash = latest.blockhash;
      let sig: string;
      let resend: ReturnType<typeof setInterval> | undefined;
      if (signTransaction) {
        // Sent to devnet by the page, and again every two seconds until it lands.
        const raw = (await signTransaction(tx)).serialize();
        sig = await connection.sendRawTransaction(raw, { maxRetries: 0 });
        resend = setInterval(() => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined), 2000);
      } else {
        sig = await sendTransaction(tx, connection);
      }
      try {
        const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      } finally {
        clearInterval(resend);
      }
      setNote({ ok: true, text: done, sig });
      onDone?.();
      return true;
    } catch (e) {
      setNote({ ok: false, text: explainError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { publicKey, send, busy, note, setNote };
}
export type Sender = ReturnType<typeof useSender>;
