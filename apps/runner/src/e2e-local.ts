// End-to-end test against a local validator: scripts/local-e2e.sh builds the program, preloads
// three Pyth price accounts and starts solana-test-validator, then runs this file.
//
//   tsx src/e2e-local.ts --accounts <dir>   writes the price account fixtures and exits
//   tsx src/e2e-local.ts                    runs the scenario against RPC_URL (default localhost)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  ASSETS,
  ENTRANT_SIZE,
  FEED_IDS,
  KIND_AGENT,
  KIND_HUMAN,
  PIT_ERRORS,
  PRICE_AGE_SPONSORED,
  PYTH_RECEIVER_ID,
  SHARD_ID,
  SPONSORED_SHARD_ID,
  SIDE_BUY,
  SIDE_CLOSE,
  SIDE_SELL,
  bytesToHex,
  closeEntrantIx,
  closeRoundIx,
  createRoundIx,
  decodeEntrant,
  decodeFills,
  decodePriceUpdate,
  decodeRound,
  decodeTradeData,
  duelAgent,
  duelStyle,
  entrantPda,
  equityOf,
  explainError,
  feedAccount,
  finalizeRoundIx,
  hexToBytes,
  joinRoundIx,
  memoIx,
  newDuelId,
  openDuelIx,
  reasonHash,
  replayFills,
  ROUND_CLOSE_DELAY_SECONDS,
  roundIdAt,
  roundPda,
  setPriceSourceIx,
  settleIx,
  tradeIx,
  type Entrant,
} from "@turing-pit/sdk";
import { Agent, PERSONAS } from "./agents.js";
import { DuelManager } from "./duels.js";
import type { Config } from "./config.js";
import { houseKeys } from "./keys.js";
import type { PriceKeeper } from "./keeper.js";
import { RoundManager, fetchEntrants } from "./rounds.js";
import { sendIxs } from "./send.js";

const PRICES: [number, number, number] = [187.42, 98120, 3412.6];
const EXPO = -8;

/** A PriceUpdateV2 account as the Pyth receiver lays it out, fully verified, published far in the future. */
function priceAccount(feedHex: string, price: number, publishTime: number): Buffer {
  const b = Buffer.alloc(8 + 32 + 1 + 84 + 8);
  let o = 0;
  Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]).copy(b, o);
  o += 8 + 32; // discriminator, write authority (zeros)
  b[o++] = 1; // VerificationLevel::Full
  Buffer.from(hexToBytes(feedHex)).copy(b, o);
  o += 32;
  b.writeBigInt64LE(BigInt(Math.round(price * 10 ** -EXPO)), o);
  b.writeBigUInt64LE(1_000_000n, o + 8);
  b.writeInt32LE(EXPO, o + 16);
  b.writeBigInt64LE(BigInt(publishTime), o + 20);
  b.writeBigInt64LE(BigInt(publishTime - 1), o + 28);
  b.writeBigInt64LE(BigInt(Math.round(price * 10 ** -EXPO)), o + 36);
  b.writeBigUInt64LE(1_000_000n, o + 44);
  return b;
}

/**
 * Price accounts for the validator: our shard (101) published far in the future, so it never goes
 * stale, and shard 0 (Pyth's sponsored feeds) published 150 seconds ago, for the price-age checks.
 */
function writeFixtures(dir: string) {
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const sets: [number, number][] = [
    [SHARD_ID, now + 7 * 86_400],
    [SPONSORED_SHARD_ID, now - 150],
  ];
  for (const [shard, publishTime] of sets) {
    ASSETS.forEach((a, i) => {
      const data = priceAccount(FEED_IDS[a], PRICES[i], publishTime);
      const file = {
        pubkey: feedAccount(a, shard).toBase58(),
        account: {
          lamports: 10_000_000,
          data: [data.toString("base64"), "base64"],
          owner: PYTH_RECEIVER_ID.toBase58(),
          executable: false,
          rentEpoch: 0,
          space: data.length,
        },
      };
      const path = join(dir, `${a.toLowerCase()}-${shard}.json`);
      writeFileSync(path, JSON.stringify(file));
      console.log(feedAccount(a, shard).toBase58(), path);
    });
  }
}

// ---------------------------------------------------------------- scenario

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(rpc, "confirmed");
let failures = 0;

function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(ok ? "  ok  " : "  FAIL", name, ok ? "" : detail);
  if (!ok) failures++;
}

const msgOf = (code: number) => PIT_ERRORS[code - 6000];

async function expectFail(name: string, run: Promise<unknown>, want: string | RegExp) {
  try {
    await run;
    check(name, false, "the transaction succeeded");
  } catch (e) {
    const text = explainError(e);
    const raw = String((e as Error).message ?? e);
    const ok = typeof want === "string" ? text === want : want.test(text) || want.test(raw);
    check(name, ok, `got: ${text}`);
  }
}

async function chainTime(): Promise<number> {
  return (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
}

async function waitForChainTime(t: number) {
  while ((await chainTime()) < t) await new Promise((r) => setTimeout(r, 1000));
}

async function fund(...wallets: PublicKey[]) {
  for (const w of wallets) {
    const sig = await connection.requestAirdrop(w, 20 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

async function entrant(programId: PublicKey, round: PublicKey, player: PublicKey): Promise<Entrant> {
  const info = await connection.getAccountInfo(entrantPda(programId, round, player));
  const e = info ? decodeEntrant(info.data) : null;
  if (!e) throw new Error("entrant not found");
  return e;
}

async function main() {
  const seed = process.env.PIT_SEED ?? "";
  const keys = houseKeys(seed);
  const programId = keys.program.publicKey;
  const house = keys.authority;
  const agent = keys.agents[0];
  const human = Keypair.generate();
  const late = Keypair.generate();
  const idle = Keypair.generate();
  const trader = Keypair.generate();
  await fund(
    house.publicKey,
    agent.publicKey,
    keys.agents[1].publicKey,
    keys.agents[2].publicKey,
    human.publicKey,
    late.publicKey,
    idle.publicKey,
    trader.publicKey,
  );
  const send = (ixs: TransactionInstruction[], signers: Keypair[], computeUnits?: number) =>
    sendIxs(connection, ixs, signers, { computeUnits });

  console.log("price accounts");
  for (const [i, a] of ASSETS.entries()) {
    const info = await connection.getAccountInfo(feedAccount(a));
    const p = info ? decodePriceUpdate(info.data) : null;
    check(`${a} feed decodes at $${PRICES[i]}`, !!p && Math.abs(p.price - PRICES[i]) < 1e-6 && p.feedId === FEED_IDS[a], p);
  }

  console.log("price age");
  {
    const t0 = await chainTime();
    const ageRound = (id: number, maxPriceAge: number) =>
      createRoundIx({ programId, authority: house.publicKey, roundId: id, startTs: t0 - 5, endTs: t0 + 600, shardId: SPONSORED_SHARD_ID, maxPriceAge });
    await expectFail("a round's price age is at least 10 seconds", send([ageRound(6_000_001, 5)], [house]), msgOf(6001));
    await expectFail("and at most 15 minutes", send([ageRound(6_000_002, 901)], [house]), msgOf(6001));
    const strict = roundPda(programId, house.publicKey, 6_000_003);
    const relaxed = roundPda(programId, house.publicKey, 6_000_004);
    await send([ageRound(6_000_003, 60), ageRound(6_000_004, PRICE_AGE_SPONSORED)], [house]);
    check("the round records its price age", decodeRound((await connection.getAccountInfo(relaxed))!.data)?.maxPriceAge === PRICE_AGE_SPONSORED);
    for (const r of [strict, relaxed]) {
      await send([joinRoundIx({ programId, round: r, player: human.publicKey, kind: KIND_HUMAN, label: "Farhan" })], [human]);
    }
    const buyOn = (r: PublicKey) =>
      tradeIx({ programId, round: r, player: human.publicKey, asset: "SOL", side: SIDE_BUY, usd: 100, reasonHash: reasonHash("x"), shardId: SPONSORED_SHARD_ID });
    await expectFail("a one-minute round refuses a price that is minutes old", send([buyOn(strict)], [human]), msgOf(6014));
    await send([buyOn(relaxed)], [human]);
    check("a round on Pyth's sponsored feeds accepts it", (await entrant(programId, relaxed, human.publicKey)).trades === 1);
  }

  console.log("leagues");
  {
    const t0 = await chainTime();
    const week = roundPda(programId, house.publicKey, 6_000_005);
    await send([createRoundIx({ programId, authority: house.publicKey, roundId: 6_000_005, startTs: t0 - 5, endTs: t0 + 7 * 86_400 })], [house]);
    check("a week-long round opens", decodeRound((await connection.getAccountInfo(week))!.data)?.endTs === t0 + 7 * 86_400);
    await send([createRoundIx({ programId, authority: house.publicKey, roundId: 6_000_006, startTs: t0 - 5, endTs: t0 + 3_650 * 86_400 })], [house]);
    check("so does a ten-year round, the Open league", !!(await connection.getAccountInfo(roundPda(programId, house.publicKey, 6_000_006))));
    await expectFail(
      "nothing longer than ten years",
      send([createRoundIx({ programId, authority: house.publicKey, roundId: 6_000_007, startTs: t0, endTs: t0 + 3_661 * 86_400 })], [house]),
      msgOf(6000),
    );
    const switchTo = (by: Keypair) =>
      setPriceSourceIx({ programId, round: week, authority: by.publicKey, shardId: SPONSORED_SHARD_ID, maxPriceAge: PRICE_AGE_SPONSORED });
    await expectFail("only the house moves a round to another price source", send([switchTo(human)], [human]), /0x7d1|ConstraintHasOne|has one/i);
    await send([switchTo(house)], [house]);
    const w = decodeRound((await connection.getAccountInfo(week))!.data)!;
    check(
      "the house moves a long round to Pyth's sponsored feeds",
      w.shardId === SPONSORED_SHARD_ID && w.maxPriceAge === PRICE_AGE_SPONSORED && w.feeds.every((f, i) => f.equals(feedAccount(ASSETS[i], SPONSORED_SHARD_ID))),
      w,
    );
    await send([joinRoundIx({ programId, round: week, player: human.publicKey, kind: KIND_HUMAN, label: "Farhan" })], [human]);
    await send(
      [tradeIx({ programId, round: week, player: human.publicKey, asset: "BTC", side: SIDE_SELL, usd: 500, reasonHash: reasonHash("x"), shardId: SPONSORED_SHARD_ID })],
      [human],
    );
    check("and trades fill there, a short included", (await entrant(programId, week, human.publicKey)).qty[1] < 0);
  }

  console.log("duels");
  {
    // Ids carry the style and the agent; the random part is fixed here so reruns differ only by validator.
    const id = newDuelId(0, 0, () => 0.123456);
    const duel = roundPda(programId, house.publicKey, id);
    await expectFail(
      "a duel's id must carry its style",
      send([openDuelIx({ programId, authority: house.publicKey, player: human.publicKey, roundId: newDuelId(1, 0, () => 0.5), style: 0 })], [human]),
      msgOf(6001),
    );
    const why = "SOL bounced off the low, riding it";
    await send(
      [
        openDuelIx({ programId, authority: house.publicKey, player: human.publicKey, roundId: id, style: 0 }),
        joinRoundIx({ programId, round: duel, player: human.publicKey, kind: KIND_HUMAN, label: "Farhan" }),
        memoIx(why),
        tradeIx({ programId, round: duel, player: human.publicKey, asset: "SOL", side: SIDE_BUY, usd: 5000, reasonHash: reasonHash(why) }),
      ],
      [human],
      400_000,
    );
    const d0 = decodeRound((await connection.getAccountInfo(duel))!.data)!;
    check(
      "a player opens a scalp duel and its trade in one transaction",
      d0.endTs - d0.startTs === 15 * 60 && d0.entrants === 1 && d0.startCash === 10_000 && duelStyle(d0.roundId) === 0 && duelAgent(d0.roundId) === 0,
      d0,
    );
    await expectFail(
      "a second human can't take the agent's seat",
      send([joinRoundIx({ programId, round: duel, player: trader.publicKey, kind: KIND_HUMAN, label: "Other" })], [trader]),
      msgOf(6028),
    );
    await send(
      [joinRoundIx({ programId, round: duel, player: agent.publicKey, kind: KIND_AGENT, label: "Claude Momentum", registrar: house.publicKey })],
      [agent, house],
    );
    const agentWhy = "ETH failing at resistance, shorting it";
    await send(
      [memoIx(agentWhy), tradeIx({ programId, round: duel, player: agent.publicKey, asset: "ETH", side: SIDE_SELL, usd: 3000, reasonHash: reasonHash(agentWhy) })],
      [agent],
    );
    const tradeIn = (who: Keypair, asset: (typeof ASSETS)[number], side: number, usd: number) => [
      memoIx("duel"),
      tradeIx({ programId, round: duel, player: who.publicKey, asset, side, usd, reasonHash: reasonHash("duel") }),
    ];
    await expectFail("a duel is one trade: no second one", send(tradeIn(human, "BTC", SIDE_BUY, 1000), [human]), msgOf(6027));
    const pair = [entrantPda(programId, duel, human.publicKey), entrantPda(programId, duel, agent.publicKey)];
    const settleOf = (who: Keypair) => settleIx({ programId, round: duel, entrant: entrantPda(programId, duel, who.publicKey) });
    await expectFail("an open duel can't be decided", send([finalizeRoundIx({ programId, round: duel, entrants: pair })], [house]), msgOf(6006));
    await send([...tradeIn(human, "SOL", SIDE_CLOSE, 0), settleOf(human)], [human]);
    const hd = await entrant(programId, duel, human.publicKey);
    check("closing your duel trade settles it at once", hd.settled && hd.trades === 2 && hd.qty.every((q) => q === 0), hd);
    await expectFail("and nothing more can be traded", send(tradeIn(human, "SOL", SIDE_BUY, 100), [human]), msgOf(6027));
    await expectFail("while the agent's trade is open the duel waits", send([finalizeRoundIx({ programId, round: duel, entrants: pair })], [house]), msgOf(6006));
    await send([...tradeIn(agent, "ETH", SIDE_CLOSE, 0), settleOf(agent)], [agent]);
    await send([finalizeRoundIx({ programId, round: duel, entrants: pair })], [house]);
    const d1 = decodeRound((await connection.getAccountInfo(duel))!.data)!;
    check("both trades closed: the duel is decided before its time is up", d1.finalized && (await chainTime()) < d1.endTs, d1);
    // The human's $5,000 of SOL there and back cost $10 in fees; the agent's $3,000 short, $6.
    check(
      "the better trade wins",
      d1.winner.equals(agent.publicKey) && d1.winnerKind === KIND_AGENT && Math.abs(d1.winnerEquity - 9_994) < 0.01 && Math.abs(hd.finalEquity - 9_990.005) < 0.01,
      { winner: d1.winner.toBase58(), equity: d1.winnerEquity, human: hd.finalEquity },
    );
  }

  console.log("create_round");
  const now = await chainTime();
  const roundId = 7_000_000 + (now % 100_000);
  const start = now - 5;
  const end = now + 70;
  const round = roundPda(programId, house.publicKey, roundId);
  await send([createRoundIx({ programId, authority: house.publicKey, roundId, startTs: start, endTs: end })], [house]);
  const r0 = decodeRound((await connection.getAccountInfo(round))!.data);
  check("round decodes", r0?.roundId === roundId && r0.startTs === start && r0.endTs === end && r0.startCash === 10_000, r0);
  check("round stores our three feed accounts", r0?.feeds.every((f, i) => f.equals(feedAccount(ASSETS[i]))) === true);
  await expectFail(
    "a round can't be created twice",
    send([createRoundIx({ programId, authority: house.publicKey, roundId, startTs: start, endTs: end })], [house]),
    /already in use/,
  );
  await expectFail(
    "a round must end after it starts",
    send([createRoundIx({ programId, authority: house.publicKey, roundId: roundId + 1, startTs: end, endTs: start })], [house]),
    msgOf(6000),
  );

  // A second round with the same end: one player never trades, the other loses a little to fees.
  const quiet = roundPda(programId, house.publicKey, roundId + 2);
  await send([createRoundIx({ programId, authority: house.publicKey, roundId: roundId + 2, startTs: start, endTs: end })], [house]);
  for (const [who, label] of [[idle, "idle"], [trader, "trader"]] as const) {
    await send([joinRoundIx({ programId, round: quiet, player: who.publicKey, kind: KIND_HUMAN, label })], [who]);
  }
  await send(
    [tradeIx({ programId, round: quiet, player: trader.publicKey, asset: "SOL", side: SIDE_BUY, usd: 100, reasonHash: reasonHash("x") })],
    [trader],
  );

  console.log("join_round");
  await send([joinRoundIx({ programId, round, player: human.publicKey, kind: KIND_HUMAN, label: "Farhan" })], [human]);
  const h0 = await entrant(programId, round, human.publicKey);
  check("human joins with $10,000", h0.cash === 10_000 && h0.label === "Farhan" && h0.kind === KIND_HUMAN, h0);
  await expectFail(
    "an agent can't join without the house",
    send([joinRoundIx({ programId, round, player: agent.publicKey, kind: KIND_AGENT, label: "Claude Momentum" })], [agent]),
    msgOf(6004),
  );
  await send(
    [joinRoundIx({ programId, round, player: agent.publicKey, kind: KIND_AGENT, label: "Claude Momentum", registrar: house.publicKey })],
    [agent, house],
  );
  check("agent joins with the house co-signing", (await entrant(programId, round, agent.publicKey)).kind === KIND_AGENT);
  await expectFail(
    "nobody joins twice",
    send([joinRoundIx({ programId, round, player: human.publicKey, kind: KIND_HUMAN, label: "again" })], [human]),
    /already in use/,
  );

  console.log("trade");
  const why = "SOL is lagging BTC this morning";
  const buy = (usd: number, asset: (typeof ASSETS)[number], reason = why, who = human) => [
    memoIx(reason),
    tradeIx({ programId, round, player: who.publicKey, asset, side: SIDE_BUY, usd, reasonHash: reasonHash(reason) }),
  ];
  const sell = (usd: number, asset: (typeof ASSETS)[number], reason = "taking profit", who = human) => [
    memoIx(reason),
    tradeIx({ programId, round, player: who.publicKey, asset, side: SIDE_SELL, usd, reasonHash: reasonHash(reason) }),
  ];

  const sig = await send(buy(1000, "SOL"), [human]);
  let h = await entrant(programId, round, human.publicKey);
  const solQty = (1000 - 1) / PRICES[0];
  check("buy $1,000 of SOL spends $1,000 cash", Math.abs(h.cash - 9000) < 1e-6, h.cash);
  check("and holds $999 of SOL after the 0.1% fee", Math.abs(h.qty[0] - solQty) < 1e-6, h.qty[0]);
  check("the reason's hash is stored", bytesToHex(h.lastReasonHash) === bytesToHex(reasonHash(why)));
  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const ix = tx?.transaction.message.instructions.find((i) => i.programId.equals(programId));
  const decoded = ix && "data" in ix ? decodeTradeData(Buffer.from(bs58decode(ix.data))) : null;
  check("the trade decodes from the transaction", decoded?.asset === "SOL" && decoded.side === SIDE_BUY && decoded.usd === 1000, decoded);
  const memo = tx?.transaction.message.instructions.find((i) => i.programId.toBase58().startsWith("Memo"));
  check("the memo carries the reason", !!memo && "parsed" in memo && memo.parsed === why, memo);

  await expectFail("trades under $10 are refused", send(buy(9, "SOL"), [human]), msgOf(6008));
  await expectFail("no more than half of equity in one coin", send(buy(5000, "SOL"), [human]), msgOf(6011));
  await send(buy(4000, "BTC"), [human]);
  await expectFail("can't spend more cash than you have", send(buy(6000, "ETH"), [human]), new RegExp(`${msgOf(6009)}|${msgOf(6011)}`));
  const close = (asset: (typeof ASSETS)[number], who = human) => [
    memoIx("flat"),
    tradeIx({ programId, round, player: who.publicKey, asset, side: SIDE_CLOSE, usd: 0, reasonHash: reasonHash("flat") }),
  ];
  const cashBefore = (await entrant(programId, round, human.publicKey)).cash;
  await send(sell(1000, "ETH"), [human]);
  h = await entrant(programId, round, human.publicKey);
  check("selling what you don't hold opens a short", Math.abs(h.qty[2] * PRICES[2] + 1000) < 0.01, h.qty[2]);
  check("and takes in the proceeds less the fee", Math.abs(h.cash - cashBefore - 999) < 0.01, h.cash - cashBefore);
  check("the short counts against equity", Math.abs(equityOf(h, PRICES) - (10_000 - 1 - 4 - 1)) < 0.01, equityOf(h, PRICES));
  await expectFail("a short is capped at half of equity too", send(sell(4500, "ETH"), [human]), msgOf(6011));
  await send(close("ETH"), [human]);
  h = await entrant(programId, round, human.publicKey);
  check("close buys the short back", h.qty[2] === 0 && Math.abs(h.cash - (cashBefore - 2)) < 0.01, { qty: h.qty[2], cash: h.cash - cashBefore });
  await expectFail("nothing to close when flat", send(close("ETH"), [human]), msgOf(6010));
  await send(sell(500, "SOL"), [human]);
  h = await entrant(programId, round, human.publicKey);
  check("partial sell leaves the rest", Math.abs(h.qty[0] * PRICES[0] - (999 - 500)) < 0.01, h.qty[0] * PRICES[0]);
  await send(close("SOL"), [human]);
  h = await entrant(programId, round, human.publicKey);
  check("close sells a long exactly", h.qty[0] === 0, h.qty[0]);
  check("trade count", h.trades === 6, h.trades);

  // The arena rebuilds each position and its entry price from the program's Traded events.
  const mine = await connection.getSignaturesForAddress(entrantPda(programId, round, human.publicKey), {}, "confirmed");
  const fills = [];
  for (const s of [...mine].reverse()) {
    if (s.err) continue;
    const t = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    fills.push(...decodeFills(t?.meta?.logMessages));
  }
  check("every fill is in its transaction's log", fills.length === 6 && fills.every((f) => f.player.equals(human.publicKey)), fills.length);
  check(
    "a fill carries its Pyth price and fee",
    fills[0]?.asset === "SOL" && fills[0].side === SIDE_BUY && Math.abs(fills[0].price - PRICES[0]) < 1e-6 && Math.abs(fills[0].fee - 1) < 1e-6,
    fills[0],
  );
  const book = replayFills(fills);
  check("replaying the fills gives the positions on chain", book.every((p, i) => Math.abs(p.qty - h.qty[i]) < 1e-9), book);
  check("and entries at the fill price", Math.abs(book[1].entry - PRICES[1]) < 1e-6 && book[0].entry === 0, book.map((p) => p.entry));
  const booked = book.reduce((s, p) => s + p.realized - p.fees, 0);
  check("realized profit less fees is the equity change", Math.abs(10_000 + booked - equityOf(h, PRICES)) < 0.01, booked);

  const agentWhy = "ETH flat while SOL ran: buying the laggard";
  await send(buy(2000, "ETH", agentWhy, agent), [agent]);
  const a = await entrant(programId, round, agent.publicKey);
  check("agent's reason hash is stored", bytesToHex(a.lastReasonHash) === bytesToHex(reasonHash(agentWhy)));

  const wrongFeed = tradeIx({ programId, round, player: human.publicKey, asset: "SOL", side: SIDE_BUY, usd: 100, reasonHash: reasonHash("x") });
  wrongFeed.keys[3].pubkey = house.publicKey;
  await expectFail("a fake price account is refused", send([wrongFeed], [human]), msgOf(6012));

  await expectFail("settling before the end is refused", send([settleIx({ programId, round, entrant: entrantPda(programId, round, human.publicKey) })], [house]), msgOf(6006));

  console.log("closing");
  await waitForChainTime(end - 29);
  await expectFail(
    "joining closes 30 seconds before the end",
    send([joinRoundIx({ programId, round, player: late.publicKey, kind: KIND_HUMAN, label: "late" })], [late]),
    msgOf(6002),
  );
  await waitForChainTime(end + 1);
  await expectFail("no trading after the end", send(buy(100, "ETH"), [human]), msgOf(6005));

  const entrants = [human.publicKey, agent.publicKey].map((p) => entrantPda(programId, round, p));
  await expectFail("finalize needs everyone settled", send([finalizeRoundIx({ programId, round, entrants })], [house], 400_000), msgOf(6021));
  await send(entrants.map((e) => settleIx({ programId, round, entrant: e })), [house], 400_000);
  await expectFail(
    "an account can't be closed before the round is final",
    send([closeEntrantIx({ programId, round, player: human.publicKey, closer: human.publicKey })], [human]),
    msgOf(6022),
  );
  await expectFail("settling twice is refused", send([settleIx({ programId, round, entrant: entrants[0] })], [house]), msgOf(6016));
  await expectFail("finalize needs every entrant", send([finalizeRoundIx({ programId, round, entrants: [entrants[0]] })], [house]), msgOf(6018));
  await expectFail(
    "an entrant can't be listed twice",
    send([finalizeRoundIx({ programId, round, entrants: [entrants[0], entrants[0]] })], [house]),
    msgOf(6020),
  );
  await send([finalizeRoundIx({ programId, round, entrants })], [house], 400_000);
  const r1 = decodeRound((await connection.getAccountInfo(round))!.data)!;
  h = await entrant(programId, round, human.publicKey);
  const ag = await entrant(programId, round, agent.publicKey);
  const expectHuman = 10_000 - 1 - 4 - 2 - 0.5 - 0.499;
  check("human's final equity is cash plus holdings minus fees", Math.abs(h.finalEquity - expectHuman) < 0.01, h.finalEquity);
  check("agent's final equity", Math.abs(ag.finalEquity - (10_000 - 2)) < 0.01, ag.finalEquity);
  check("final equity matches the client's own math", Math.abs(equityOf(ag, PRICES) - ag.finalEquity) < 0.01);
  check("the round is finalized", r1.finalized && r1.settled === 2 && r1.entrants === 2 && r1.agents === 1, r1);
  check("the agent won", r1.winner.equals(agent.publicKey) && r1.winnerKind === KIND_AGENT, r1.winner.toBase58());
  check("best human and best agent are recorded", Math.abs(r1.bestHumanEquity - expectHuman) < 0.01 && Math.abs(r1.bestAgentEquity - 9998) < 0.01, r1);
  await expectFail("finalize only once", send([finalizeRoundIx({ programId, round, entrants })], [house]), msgOf(6017));
  const quietEntrants = [idle, trader].map((w) => entrantPda(programId, quiet, w.publicKey));
  await send(quietEntrants.map((e) => settleIx({ programId, round: quiet, entrant: e })), [house], 400_000);
  await send([finalizeRoundIx({ programId, round: quiet, entrants: quietEntrants })], [house], 400_000);
  const rq = decodeRound((await connection.getAccountInfo(quiet))!.data)!;
  check(
    "sitting in cash all round doesn't win: the player who traded does, $0.10 down",
    rq.winner.equals(trader.publicKey) && Math.abs(rq.winnerEquity - 9_999.9) < 0.01,
    { winner: rq.winner.toBase58(), equity: rq.winnerEquity },
  );
  await expectFail(
    "others can't close a player's account until three hours after the round",
    send([closeEntrantIx({ programId, round, player: human.publicKey, closer: house.publicKey })], [house]),
    msgOf(6023),
  );
  const before = await connection.getBalance(human.publicKey);
  await send([closeEntrantIx({ programId, round, player: human.publicKey, closer: human.publicKey })], [human]);
  const refund = (await connection.getBalance(human.publicKey)) - before;
  check(
    `the player closes their account and gets the rent back (+${refund} lamports)`,
    !(await connection.getAccountInfo(entrants[0])) && refund > 2_000_000,
  );
  const r2 = decodeRound((await connection.getAccountInfo(round))!.data)!;
  check("the round keeps its results", r2.finalized && r2.winner.equals(agent.publicKey) && r2.entrants === 2);
  check("the round counts closed player accounts", r2.closed === 1, r2.closed);

  console.log("close_round");
  const closeRound = (r: PublicKey, by: Keypair) => send([closeRoundIx({ programId, round: r, authority: by.publicKey })], [by]);
  await expectFail("a round can't be closed while a player's account is open", closeRound(round, house), msgOf(6024));
  await send([closeEntrantIx({ programId, round, player: agent.publicKey, closer: agent.publicKey })], [agent]);
  check("once every player's account is closed", decodeRound((await connection.getAccountInfo(round))!.data)!.closed === 2);
  await expectFail("it still waits six hours after the end", closeRound(round, house), msgOf(6025));
  // A round that ended more than six hours ago, nobody in it.
  const oldId = 8_000_000 + (now % 100_000);
  const oldEnd = (await chainTime()) - ROUND_CLOSE_DELAY_SECONDS - 60;
  const old = roundPda(programId, house.publicKey, oldId);
  await send([createRoundIx({ programId, authority: house.publicKey, roundId: oldId, startTs: oldEnd - 900, endTs: oldEnd })], [house]);
  await expectFail("an unfinished round can't be closed", closeRound(old, house), msgOf(6022));
  await send([finalizeRoundIx({ programId, round: old, entrants: [] })], [house]);
  await expectFail("only the house that opened a round can close it", closeRound(old, human), /0x7d1|ConstraintHasOne|has one/i);
  const houseBefore = await connection.getBalance(house.publicKey);
  await closeRound(old, house);
  const back = (await connection.getBalance(house.publicKey)) - houseBefore;
  check(`the house closes a finished round six hours on and gets its rent back (+${back} lamports)`, !(await connection.getAccountInfo(old)) && back > 2_000_000);

  // ---- the house runner: opens the current 15-minute round; an agent joins and trades with a stub brain.
  console.log("runner");
  const cfg = {
    keys,
    programId,
    connection,
    hermesUrl: "",
    pythApiKey: "",
    anthropicKey: "",
    agentModel: "stub",
    durationMs: 0,
    keeperIntervalMs: 0,
    agentIntervalMs: 0,
    pythTreasuryId: undefined,
  } satisfies Config;
  const keeper = { latest: (asset: string) => PRICES[ASSETS.indexOf(asset as never)], change: () => 0.42, age: () => 5 } as unknown as PriceKeeper;

  console.log("duel runner");
  {
    let duelPrompt = "";
    const duelBrain = {
      messages: {
        create: async (req: { messages: { content: string }[] }) => {
          duelPrompt = req.messages[0].content;
          const input = duelPrompt.includes("Open your trade now")
            ? { action: "short", asset: "ETH", usd: 3000, reason: "Stub brain: ETH lagging, shorting it" }
            : { action: "close", reason: "Stub brain: taking it" };
          return { content: [{ type: "tool_use", input }] };
        },
      },
    };
    const duels = new DuelManager(cfg, keeper, duelBrain as never);
    // A human challenges Claude Contrarian (agent 1) to a scalp duel and goes long SOL.
    const id = newDuelId(0, 1, () => 0.654321);
    const duel = roundPda(programId, house.publicKey, id);
    const why = "Long SOL into the bounce";
    await send(
      [
        openDuelIx({ programId, authority: house.publicKey, player: human.publicKey, roundId: id, style: 0 }),
        joinRoundIx({ programId, round: duel, player: human.publicKey, kind: KIND_HUMAN, label: "Farhan" }),
        memoIx(why),
        tradeIx({ programId, round: duel, player: human.publicKey, asset: "SOL", side: SIDE_BUY, usd: 4000, reasonHash: reasonHash(why) }),
      ],
      [human],
      400_000,
    );
    const agentOf = async () => (await fetchEntrants(cfg, duel)).find((e) => e.entrant.player.equals(keys.agents[1].publicKey));
    await duels.pass();
    check("the agent named in the duel accepts it", !!(await agentOf()));
    await duels.pass();
    const opened = await agentOf();
    check("and opens its own trade", opened?.entrant.trades === 1 && (opened?.entrant.qty[2] ?? 0) < 0, opened?.entrant.qty);
    check("the duel prompt shows the challenger's trade", duelPrompt.includes("Farhan's trade: long SOL $4,000"), duelPrompt);
    duels.lookedAt.clear();
    await duels.pass();
    const closed = await agentOf();
    check("then closes it when its call says so, settling at once", !!closed?.entrant.settled && closed.entrant.trades === 2, closed?.entrant);
    await send(
      [
        memoIx("done"),
        tradeIx({ programId, round: duel, player: human.publicKey, asset: "SOL", side: SIDE_CLOSE, usd: 0, reasonHash: reasonHash("done") }),
        settleIx({ programId, round: duel, entrant: entrantPda(programId, duel, human.publicKey) }),
      ],
      [human],
    );
    await duels.pass();
    const decided = decodeRound((await connection.getAccountInfo(duel))!.data)!;
    check(
      "the house decides the duel as soon as both trades are closed",
      decided.finalized && decided.winner.equals(keys.agents[1].publicKey),
      { finalized: decided.finalized, winner: decided.winner.toBase58() },
    );
  }

  const secondsIn = Math.floor(Date.now() / 1000) % 900;
  if (secondsIn > 840 - 75) {
    console.log("  skip  runner checks: too close to the end of the current 15-minute round");
    console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  }
  const rounds = new RoundManager(cfg);
  await rounds.run(Date.now() + 8_000);
  const current = roundIdAt(Math.floor(Date.now() / 1000));
  const live = await connection.getAccountInfo(roundPda(programId, house.publicKey, current));
  check("the house opens the current round", !!live && decodeRound(live.data)?.roundId === current);

  let prompt = "";
  const brain = {
    messages: {
      create: async (req: { messages: { content: string }[] }) => {
        prompt = req.messages[0].content;
        return { content: [{ type: "tool_use", input: { action: "buy", asset: "SOL", usd: 2500, reason: "Stub brain: SOL +0.42% in a minute" } }] };
      },
    },
  };
  const bot = new Agent(cfg, keeper, keys.agents[1], PERSONAS[1], brain as never);
  if (Math.floor(Date.now() / 1000) % 900 < 5) {
    console.log("  skip  agent tick: the round has only just opened");
  } else {
    await bot.tick();
    const liveRound = roundPda(programId, house.publicKey, current);
    const mine = (await fetchEntrants(cfg, liveRound)).find((e) => e.entrant.player.equals(keys.agents[1].publicKey));
    check("the agent joined the live round", !!mine, "not joined");
    check("the agent traded on its decision", !!mine && Math.abs(mine.entrant.qty[0] * PRICES[0] - 2497.5) < 0.01, mine?.entrant.qty);
    check("the prompt carries prices and the board", prompt.includes("SOL: $187.42") && prompt.includes("Leaderboard"), prompt);
    check("the prompt says how much the agent can still buy", prompt.includes("The most you can buy right now") && prompt.includes("SOL $4,900.00"), prompt);
  }
  const all = await connection.getProgramAccounts(programId, { filters: [{ dataSize: ENTRANT_SIZE }] });
  check("entrant accounts are the size the client expects", all.length >= 2);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

// bs58 without another dependency: web3.js re-exports PublicKey's encoder only, so decode here.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const at = process.argv.indexOf("--accounts");
if (at !== -1) writeFixtures(process.argv[at + 1]);
else
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
