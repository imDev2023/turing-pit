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
  SIDE_SELL,
  bytesToHex,
  closeEntrantIx,
  closeRoundIx,
  createRoundIx,
  decodeEntrant,
  decodePriceUpdate,
  decodeRound,
  decodeTradeData,
  entrantPda,
  equityOf,
  explainError,
  feedAccount,
  finalizeRoundIx,
  hexToBytes,
  joinRoundIx,
  memoIx,
  reasonHash,
  ROUND_CLOSE_DELAY_SECONDS,
  roundIdAt,
  roundPda,
  settleIx,
  tradeIx,
  type Entrant,
} from "@turing-pit/sdk";
import { Agent, PERSONAS } from "./agents.js";
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
  await fund(house.publicKey, agent.publicKey, keys.agents[1].publicKey, keys.agents[2].publicKey, human.publicKey, late.publicKey);
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
  await expectFail("can't sell what you don't hold", send(sell(100, "ETH"), [human]), msgOf(6010));
  await send(sell(500, "SOL"), [human]);
  h = await entrant(programId, round, human.publicKey);
  check("partial sell leaves the rest", Math.abs(h.qty[0] * PRICES[0] - (999 - 500)) < 0.01, h.qty[0] * PRICES[0]);
  await send(sell(1_000_000, "SOL"), [human]);
  h = await entrant(programId, round, human.publicKey);
  check("selling more than you hold sells everything", h.qty[0] === 0, h.qty[0]);
  check("trade count", h.trades === 4, h.trades);

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
  const expectHuman = 10_000 - 1 - 4 - 0.5 - 0.499;
  check("human's final equity is cash plus holdings minus fees", Math.abs(h.finalEquity - expectHuman) < 0.01, h.finalEquity);
  check("agent's final equity", Math.abs(ag.finalEquity - (10_000 - 2)) < 0.01, ag.finalEquity);
  check("final equity matches the client's own math", Math.abs(equityOf(ag, PRICES) - ag.finalEquity) < 0.01);
  check("the round is finalized", r1.finalized && r1.settled === 2 && r1.entrants === 2 && r1.agents === 1, r1);
  check("the agent won", r1.winner.equals(agent.publicKey) && r1.winnerKind === KIND_AGENT, r1.winner.toBase58());
  check("best human and best agent are recorded", Math.abs(r1.bestHumanEquity - expectHuman) < 0.01 && Math.abs(r1.bestAgentEquity - 9998) < 0.01, r1);
  await expectFail("finalize only once", send([finalizeRoundIx({ programId, round, entrants })], [house]), msgOf(6017));
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

  const keeper = { latest: (asset: string) => PRICES[ASSETS.indexOf(asset as never)], change: () => 0.42, age: () => 5 } as unknown as PriceKeeper;
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
