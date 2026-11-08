import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { PIT_ERRORS, decodeHouseFeed, explainError } from "@turing-pit/sdk";
import { HOUSE_FEED } from "./sources";

/** The program's "Price is too old" (error 6014). */
const STALE = PIT_ERRORS[14];

export type Note = { ok: boolean; text: string; sig?: string };

/** A session wallet per connected wallet, kept in this browser. It plays and signs every trade,
 *  so the player's own wallet approves once: the first action, which also funds it. */
const KEY = "turing-pit:session:";
const TOP_UP = 0.1 * LAMPORTS_PER_SOL;
const LOW = 0.02 * LAMPORTS_PER_SOL;

function sessionFor(owner: PublicKey): Keypair {
  const key = KEY + owner.toBase58();
  try {
    const saved = localStorage.getItem(key);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)));
    const fresh = Keypair.generate();
    localStorage.setItem(key, btoa(String.fromCharCode(...fresh.secretKey)));
    return fresh;
  } catch {
    // Without storage the session lasts as long as the page.
    return Keypair.generate();
  }
}

/** Lands instructions on devnet. The session wallet signs and pays; when it runs low, the same
 *  transaction tops it up from the connected wallet, which is then the one approval needed. */
export function useSender(onDone?: () => void) {
  const { publicKey: wallet, signTransaction } = useWallet();
  const { connection } = useConnection();
  const session = useMemo(() => (wallet ? sessionFor(wallet) : null), [wallet]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [walletSol, setWalletSol] = useState<number | null>(null);
  const ready = balance !== null && balance >= LOW;

  // The first action also funds the session wallet from the connected one, which needs devnet SOL.
  useEffect(() => {
    setWalletSol(null);
    if (!wallet || ready) return;
    let alive = true;
    connection
      .getBalance(wallet, "confirmed")
      .then((b) => alive && setWalletSol(b))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [connection, wallet, ready, note]);

  useEffect(() => {
    setBalance(null);
    if (!session) return;
    let alive = true;
    const check = () =>
      connection
        .getBalance(session.publicKey, "confirmed")
        .then((b) => alive && setBalance(b))
        .catch(() => undefined);
    check();
    const t = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connection, session]);

  /** Builds, signs and lands one transaction; while the session wallet runs low, the same
   *  transaction tops it up from the connected wallet, the one approval. */
  const submit = async (ixs: TransactionInstruction[]): Promise<string> => {
    if (!wallet || !session) throw new Error("Connect a wallet");
    const [latest, held] = await Promise.all([connection.getLatestBlockhash("confirmed"), connection.getBalance(session.publicKey, "confirmed")]);
    const fund = held < LOW;
    const tx = new Transaction();
    if (fund) tx.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: session.publicKey, lamports: TOP_UP - held }));
    tx.add(...ixs);
    tx.feePayer = fund ? wallet : session.publicKey;
    tx.recentBlockhash = latest.blockhash;
    let raw: Uint8Array;
    if (fund) {
      if (!signTransaction) throw new Error("This wallet can't sign transactions here");
      tx.partialSign(session);
      // Tried first, so the wallet is never asked to approve a transaction that would fail.
      const trial = await connection.simulateTransaction(tx);
      if (trial.value.err) throw new Error((trial.value.logs ?? []).join("\n") || JSON.stringify(trial.value.err));
      raw = (await signTransaction(tx)).serialize();
    } else {
      tx.sign(session);
      raw = tx.serialize();
    }
    // Sent to devnet by the page, and again every two seconds until it lands.
    const sig = await connection.sendRawTransaction(raw, { maxRetries: 0 });
    const resend = setInterval(() => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined), 2000);
    try {
      const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    } finally {
      clearInterval(resend);
    }
    return sig;
  };

  /** How many prices the house has posted so far. */
  const postsOf = async (feed: PublicKey) => {
    const info = await connection.getAccountInfo(feed, "confirmed");
    return (info && decodeHouseFeed(info.data)?.posts) || 0;
  };

  const send = async (ixs: TransactionInstruction[], done: string): Promise<boolean> => {
    if (!wallet || !session) return false;
    setBusy(true);
    setNote(null);
    try {
      let sig: string;
      try {
        sig = await submit(ixs);
      } catch (e) {
        // The house posts its prices only while someone is trading. A trade that finds its price
        // stale wakes it with a tiny transaction on the house's feed, waits for a fresh price and
        // goes again.
        const feed = HOUSE_FEED;
        if (!feed || explainError(e) !== STALE || !ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(feed)))) throw e;
        setNote({ ok: true, text: "Fetching a fresh price…" });
        const before = await postsOf(feed);
        await submit([SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: feed, lamports: 0 })]);
        let posted = false;
        for (let i = 0; i < 20 && !posted; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          posted = (await postsOf(feed)) > before;
        }
        if (!posted) throw new Error("No fresh price yet; try again in a moment");
        sig = await submit(ixs);
      }
      setNote({ ok: true, text: done, sig });
      connection.getBalance(session.publicKey, "confirmed").then(setBalance).catch(() => undefined);
      onDone?.();
      return true;
    } catch (e) {
      setNote({ ok: false, text: explainError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    wallet,
    /** The key that plays: the session wallet of the connected wallet. */
    player: session?.publicKey ?? null,
    /** False until the session wallet holds enough for fees: the next action asks the wallet once. */
    ready,
    /** The connected wallet can't fund the session wallet yet: it needs devnet SOL first. */
    short: walletSol !== null && walletSol < TOP_UP + 0.01 * LAMPORTS_PER_SOL,
    send,
    busy,
    note,
    setNote,
  };
}
export type Sender = ReturnType<typeof useSender>;
