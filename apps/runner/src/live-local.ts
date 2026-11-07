// Live-path test. scripts/live-local.sh starts a local validator with our program and copies of
// Pyth's receiver, push oracle and Wormhole programs (with the receiver's config, Wormhole's
// guardian sets and Pyth's sponsored price accounts) from devnet, then runs this file. It checks
// the parts the end-to-end test fakes, in both price modes:
//   - Pyth's sponsored devnet feeds (shard 0): the program trades on the copied accounts;
//   - with PYTH_API_KEY, the real keeper posts Hermes updates to our shard and the program
//     trades on those;
//   - with ANTHROPIC_API_KEY, each Claude agent makes one real decision in a house round.
// Nothing is sent to devnet itself.
//
//   tsx src/live-local.ts --clone-args   prints the validator's clone flags, one per line
//   tsx src/live-local.ts                runs the checks against RPC_URL (default localhost)

import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_WORMHOLE_PROGRAM_ID,
  getConfigPda,
  getGuardianSetPda,
  getTreasuryPda,
} from "@pythnetwork/pyth-solana-receiver/address";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  ASSETS,
  FEED_IDS,
  KIND_HUMAN,
  PERSONAS,
  PRICE_AGE_KEEPER,
  PRICE_AGE_SPONSORED,
  PYTH_PUSH_ORACLE_ID,
  PYTH_RECEIVER_ID,
  SHARD_ID,
  SIDE_BUY,
  SIDE_SELL,
  SPONSORED_SHARD_ID,
  bytesToHex,
  createRoundIx,
  decodeEntrant,
  decodePriceUpdate,
  decodeRound,
  entrantPda,
  feedAccounts,
  joinRoundIx,
  memoIx,
  reasonHash,
  roundIdAt,
  roundPda,
  tradeIx,
  type Entrant,
  type PythPrice,
} from "@turing-pit/sdk";
import { Agent } from "./agents.js";
import type { Config } from "./config.js";
import { PriceKeeper } from "./keeper.js";
import { houseKeys } from "./keys.js";
import { RoundManager, fetchEntrants } from "./rounds.js";
import { sendIxs } from "./send.js";

const TREASURY_ID = 0;

function cloneArgs(): string[] {
  const args = [
    "--clone-upgradeable-program", PYTH_RECEIVER_ID.toBase58(),
    "--clone-upgradeable-program", PYTH_PUSH_ORACLE_ID.toBase58(),
    "--clone-upgradeable-program", DEFAULT_WORMHOLE_PROGRAM_ID.toBase58(),
    "--clone", getConfigPda(PYTH_RECEIVER_ID).toBase58(),
    "--maybe-clone", getTreasuryPda(TREASURY_ID, PYTH_RECEIVER_ID).toBase58(),
  ];
  // Hermes updates are signed by the current guardian set; copy every set that exists.
  for (let i = 0; i < 10; i++) args.push("--maybe-clone", getGuardianSetPda(i, DEFAULT_WORMHOLE_PROGRAM_ID).toBase58());
  for (const f of feedAccounts(SPONSORED_SHARD_ID)) args.push("--clone", f.toBase58());
  return args;
}

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const connection = new Connection(rpc, "confirmed");
let failures = 0;

function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(ok ? "  ok  " : "  FAIL", name, ok ? "" : detail);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => Promise<T | null>, ms: number): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await probe().catch(() => null);
    if (v) return v;
    await sleep(2_000);
  }
  return null;
}

async function chainTime(): Promise<number> {
  return (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
}

async function pricesOn(shardId: number): Promise<PythPrice[] | null> {
  const infos = await connection.getMultipleAccountsInfo(feedAccounts(shardId));
  const prices = infos.map((info) => (info && info.owner.equals(PYTH_RECEIVER_ID) ? decodePriceUpdate(info.data) : null));
  return prices.every((p) => p !== null) ? (prices as PythPrice[]) : null;
}

async function entrantOf(programId: PublicKey, round: PublicKey, player: PublicKey): Promise<Entrant | null> {
  const info = await connection.getAccountInfo(entrantPda(programId, round, player));
  return info ? decodeEntrant(info.data) : null;
}

/** Opens a round on the given price feeds, joins as a human and buys, then sells, SOL. */
async function tradeOn(programId: PublicKey, house: Keypair, human: Keypair, shardId: number, maxPriceAge: number) {
  const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendIxs(connection, ixs, signers);
  const now = await chainTime();
  const roundId = 8_000_000 + shardId * 100_000 + (now % 100_000);
  const round = roundPda(programId, house.publicKey, roundId);
  await send(
    [createRoundIx({ programId, authority: house.publicKey, roundId, startTs: now - 5, endTs: now + 600, shardId, maxPriceAge })],
    [house],
  );
  const r = decodeRound((await connection.getAccountInfo(round))!.data);
  check(
    `the round reads shard ${shardId} and allows prices up to ${maxPriceAge}s old`,
    !!r && r.shardId === shardId && r.maxPriceAge === maxPriceAge && r.feeds.every((f, i) => f.equals(feedAccounts(shardId)[i])),
    r,
  );
  await send([joinRoundIx({ programId, round, player: human.publicKey, kind: KIND_HUMAN, label: "Live test" })], [human]);
  const why = `Live test: buying SOL on shard ${shardId}`;
  try {
    await send(
      [memoIx(why), tradeIx({ programId, round, player: human.publicKey, asset: "SOL", side: SIDE_BUY, usd: 1000, reasonHash: reasonHash(why), shardId })],
      [human],
    );
    const e = await entrantOf(programId, round, human.publicKey);
    const sol = (await pricesOn(shardId))?.[0].price ?? 0;
    check(
      `a $1,000 buy fills at the SOL price on the account ($${((e?.qty[0] ?? 0) * sol).toFixed(2)} of SOL, $${e?.cash.toFixed(2)} cash)`,
      !!e && Math.abs(e.qty[0] * sol - 999) < 10 && Math.abs(e.cash - 9_000) < 0.01,
      e,
    );
    check("the trade stores the reason's hash", !!e && bytesToHex(e.lastReasonHash) === bytesToHex(reasonHash(why)));
    await send(
      [tradeIx({ programId, round, player: human.publicKey, asset: "SOL", side: SIDE_SELL, usd: 500, reasonHash: reasonHash(""), shardId })],
      [human],
    );
    const e2 = await entrantOf(programId, round, human.publicKey);
    check("a sell fills too", !!e2 && e2.qty[0] < (e?.qty[0] ?? 0) && e2.cash > 9_400, e2);
  } catch (err) {
    check(`trades go through on shard ${shardId}`, false, (err as Error).message);
  }
}

async function main() {
  const keys = houseKeys(process.env.PIT_SEED ?? "");
  const programId = keys.program.publicKey;
  const house = keys.authority;
  const human = Keypair.generate();

  console.log("copied programs and accounts");
  const programs: [string, PublicKey][] = [
    ["Pyth receiver", PYTH_RECEIVER_ID],
    ["Pyth push oracle", PYTH_PUSH_ORACLE_ID],
    ["Wormhole", DEFAULT_WORMHOLE_PROGRAM_ID],
    ["turing_pit", programId],
  ];
  for (const [name, id] of programs) check(`${name} is loaded`, !!(await connection.getAccountInfo(id))?.executable);
  const receiverConfig = await connection.getAccountInfo(getConfigPda(PYTH_RECEIVER_ID));
  check("the receiver's config was copied from devnet", !!receiverConfig?.owner.equals(PYTH_RECEIVER_ID));

  for (const w of [house.publicKey, ...keys.agents.map((a) => a.publicKey), human.publicKey]) {
    await connection.confirmTransaction(await connection.requestAirdrop(w, 20 * LAMPORTS_PER_SOL), "confirmed");
  }
  // The receiver moves a small fee into a treasury account per update; make sure ours exists.
  const treasury = getTreasuryPda(TREASURY_ID, PYTH_RECEIVER_ID);
  await sendIxs(connection, [SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: treasury, lamports: 0.01 * LAMPORTS_PER_SOL })], [house]);

  const cfg = {
    keys,
    programId,
    connection,
    hermesUrl: process.env.HERMES_URL || "https://hermes.pyth.network",
    pythApiKey: process.env.PYTH_API_KEY ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    agentModel: process.env.AGENT_MODEL || "claude-haiku-5-5",
    durationMs: 0,
    keeperIntervalMs: 5_000,
    agentIntervalMs: 0,
    pythTreasuryId: TREASURY_ID,
  } satisfies Config;
  const keeper = new PriceKeeper(cfg);
  void keeper.run(Date.now() + 420_000);

  console.log("Pyth's sponsored devnet feeds (shard 0)");
  const sponsored = await pricesOn(SPONSORED_SHARD_ID);
  const now = Math.floor(Date.now() / 1000);
  check(
    `devnet's sponsored accounts were copied: ${sponsored?.map((p, i) => `${ASSETS[i]} $${p.price.toFixed(2)} (${now - p.publishTime}s old)`).join(", ")}`,
    !!sponsored && sponsored.every((p, i) => p.feedId === FEED_IDS[ASSETS[i]]),
  );
  if (sponsored && sponsored.some((p) => now - p.publishTime > PRICE_AGE_SPONSORED - 60)) {
    console.log(`  note  a sponsored price is older than ${PRICE_AGE_SPONSORED - 60}s; Pyth's devnet pusher may be lagging`);
  }
  await tradeOn(programId, house, human, SPONSORED_SHARD_ID, PRICE_AGE_SPONSORED);

  console.log("house keeper (Hermes -> push oracle, shard 101)");
  if (!cfg.pythApiKey) {
    console.log("  skip  PYTH_API_KEY is not set (Hermes refuses requests without one)");
  } else {
    const first = await waitFor(async () => {
      const p = await pricesOn(SHARD_ID);
      const t = Math.floor(Date.now() / 1000);
      return p && p.every((x) => t - x.publishTime < 60) ? p : null;
    }, 120_000);
    check("the keeper posts all three feeds to our shard", !!first, keeper.lastError || "no accounts");
    if (first) {
      ASSETS.forEach((a, i) => {
        const hermes = keeper.latest(a) ?? 0;
        check(
          `${a} account: feed id matches, $${first[i].price.toFixed(2)} vs Hermes $${hermes.toFixed(2)}`,
          first[i].feedId === FEED_IDS[a] && Math.abs(first[i].price - hermes) / hermes < 0.01,
          first[i],
        );
      });
      const later = await waitFor(async () => {
        const p = await pricesOn(SHARD_ID);
        return p && p[0].publishTime > first[0].publishTime ? p : null;
      }, 40_000);
      check("the keeper keeps the accounts fresh", !!later, keeper.lastError);
      console.log(`  ..    ${keeper.posted} updates posted so far`);
      await tradeOn(programId, house, human, SHARD_ID, PRICE_AGE_KEEPER);
    }
  }

  console.log("Claude agents");
  if (!cfg.anthropicKey) {
    console.log("  skip  ANTHROPIC_API_KEY is not set");
    return finish();
  }
  // Agents trade in the house's scheduled rounds; wait for one with time left to trade.
  const secondsIn = Math.floor(Date.now() / 1000) % 900;
  if (secondsIn > 840 - 60 || secondsIn < 6) {
    const wait = ((900 - secondsIn + 6) % 900) * 1000;
    console.log(`  ..    waiting ${Math.round(wait / 1000)} s for the next round to open`);
    await sleep(wait);
  }
  await keeper.ready(30_000);
  await new RoundManager(cfg, keeper).run(Date.now() + 6_000);
  const current = roundIdAt(Math.floor(Date.now() / 1000));
  const live = roundPda(programId, house.publicKey, current);
  const liveRound = (await connection.getAccountInfo(live)) ? decodeRound((await connection.getAccountInfo(live))!.data) : null;
  check(`the house opens the scheduled round on shard ${liveRound?.shardId}`, !!liveRound && liveRound.shardId === keeper.source().shardId);

  const claude = new Anthropic({ apiKey: cfg.anthropicKey });
  for (const [i, persona] of PERSONAS.entries()) {
    let decision: Record<string, unknown> | undefined;
    let error = "";
    const recorder = {
      messages: {
        create: async (req: Anthropic.MessageCreateParamsNonStreaming) => {
          try {
            const res = await claude.messages.create(req);
            decision = (res.content.find((b) => b.type === "tool_use") as { input?: Record<string, unknown> } | undefined)?.input;
            console.log(`  ..    ${persona.label}: ${res.usage.input_tokens} tokens in, ${res.usage.output_tokens} out`);
            return res;
          } catch (e) {
            error = (e as Error).message;
            throw e;
          }
        },
      },
    };
    const agent = new Agent(cfg, keeper, keys.agents[i], persona, recorder as unknown as Anthropic);
    await agent.tick();
    const me = (await fetchEntrants(cfg, live)).find((e) => e.entrant.player.equals(keys.agents[i].publicKey))?.entrant;
    check(`${persona.label} joins the round`, !!me);
    const action = decision?.action;
    const reason = typeof decision?.reason === "string" ? decision.reason : "";
    check(
      `${persona.label} decides: ${action ?? "nothing"} ${decision?.asset ?? ""} ${decision?.usd ?? ""} "${reason}"`,
      !error && ["buy", "sell", "hold"].includes(String(action)) && reason.length > 0,
      error || decision,
    );
    if (reason.length > 200) console.log(`  note  the reason ran to ${reason.length} characters; the runner cuts it at 200`);
    if (me && me.trades > 0) {
      check(`${persona.label}'s trade carries its reason's hash`, bytesToHex(me.lastReasonHash) === bytesToHex(reasonHash(reason.slice(0, 200))));
    }
  }
  return finish();
}

function finish() {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

if (process.argv.includes("--clone-args")) console.log(cloneArgs().join("\n"));
else
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
