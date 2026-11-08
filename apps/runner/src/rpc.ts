import { TransactionExpiredBlockheightExceededError, type Connection } from "@solana/web3.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The house's devnet RPC traffic, kept polite. The public endpoint allows an address 100 requests
 * and 40 new connections per 10 seconds, and GitHub's runners share addresses: a burst (six
 * leagues of rounds and agents starting at once) earned 429s whose retries, each on a fresh
 * connection, kept the limit tripped for good. So at most four requests are in flight (a few
 * kept-alive connections carry everything), one leaves every 110 ms at most, and a 429 pauses
 * all of them, from 2 seconds doubling up to 30, before the request is tried again.
 */
export function politeFetch(maxInFlight = 4, gapMs = 110): typeof fetch {
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  let nextAt = 0;
  let pausedUntil = 0;
  let pause = 2_000;
  const acquire = () => (inFlight < maxInFlight ? (inFlight++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  // A freed slot passes straight to the next waiter.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  };
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 1; ; attempt++) {
      await acquire();
      let res: Response;
      try {
        const at = Math.max(Date.now(), nextAt, pausedUntil);
        nextAt = at + gapMs;
        if (at > Date.now()) await sleep(at - Date.now());
        res = await fetch(input, init);
        if (res.status === 429) await res.arrayBuffer().catch(() => undefined);
      } finally {
        release();
      }
      if (res.status !== 429 || attempt >= 8) {
        if (res.status !== 429) pause = Math.max(2_000, pause * 0.8);
        return res;
      }
      // 429s from requests that were already under way count once.
      if (Date.now() >= pausedUntil) {
        pausedUntil = Date.now() + pause;
        pause = Math.min(pause * 2, 30_000);
      }
    }
  }) as typeof fetch;
}

/**
 * Sends signed transaction bytes and polls until they are confirmed, re-sending every few
 * seconds meanwhile. Polling over HTTP instead of web3.js's websocket subscriptions keeps the
 * house on its few kept-alive connections: a websocket that is refused with a 429 reconnects
 * every second, which by itself uses up the address's connection allowance.
 */
export async function land(
  connection: Connection,
  raw: Uint8Array,
  expiry: { lastValidBlockHeight?: number; timeoutMs?: number } = {},
  preflight = false,
): Promise<string> {
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: !preflight, maxRetries: 0 });
  const started = Date.now();
  let sentAt = started;
  for (let i = 0; ; i++) {
    await sleep(i < 4 ? 700 : 1_500);
    const status = (await connection.getSignatureStatuses([sig])).value[0];
    if (status?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return sig;
    if (Date.now() - sentAt > 3_000) {
      sentAt = Date.now();
      connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
    if (expiry.timeoutMs && Date.now() - started > expiry.timeoutMs) throw new Error(`tx ${sig} not confirmed after ${expiry.timeoutMs / 1000}s`);
    if (expiry.lastValidBlockHeight !== undefined && i % 4 === 3) {
      if ((await connection.getBlockHeight("confirmed")) > expiry.lastValidBlockHeight) {
        // One last look: it may have landed just before the blockhash expired.
        const last = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (last?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(last.err)}`);
        if (last?.confirmationStatus) return sig;
        throw new TransactionExpiredBlockheightExceededError(sig);
      }
    }
  }
}
