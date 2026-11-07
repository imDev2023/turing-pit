// Three Claude-powered traders. Each holds its own wallet, decides every ~45 seconds, and posts
// its reason on chain as a memo in the same transaction as the trade; the program stores the
// reason's hash, so anyone can check the memo is the reason the trade was made with.

import Anthropic from "@anthropic-ai/sdk";
import type { Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSETS,
  KIND_AGENT,
  MAX_ASSET_BPS,
  MIN_TRADE_USD,
  PERSONAS,
  PRICE_AGE_KEEPER,
  SIDE_BUY,
  SIDE_SELL,
  entrantPda,
  equityOf,
  joinRoundIx,
  memoIx,
  reasonHash,
  roundIdAt,
  roundTimes,
  tradeIx,
  agentSystemPrompt,
  type Asset,
  type Entrant,
  type Persona,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import type { PriceKeeper } from "./keeper.js";
import { fetchEntrants, fetchRound } from "./rounds.js";
import { sendIxs, shortError } from "./send.js";

export { PERSONAS };

interface Decision {
  action: "buy" | "sell" | "hold";
  asset?: Asset;
  usd?: number;
  reason: string;
}

const DECIDE_TOOL = {
  name: "decide",
  description: "Make exactly one trading decision for this moment.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["buy", "sell", "hold"] },
      asset: { type: "string", enum: [...ASSETS] },
      usd: { type: "number", description: "Dollars to spend on a buy, or dollar value to sell." },
      reason: {
        type: "string",
        description: "Why, in at most 200 characters, citing the numbers you used. This is posted on chain.",
      },
    },
    required: ["action", "reason"],
  },
};

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

export class Agent {
  private joined = new Set<number>();
  private recent: string[] = [];
  /** The prices (publish times) the last decision saw, and when it was made. */
  private decidedOn = "";
  private decidedAt = 0;
  private usage = { calls: 0, input: 0, output: 0 };

  constructor(
    private cfg: Config,
    private keeper: PriceKeeper,
    private wallet: Keypair,
    private persona: Persona,
    private claude: Anthropic | null,
  ) {}

  get label() {
    return this.persona.label;
  }

  private async ensureJoined(roundId: number) {
    if (this.joined.has(roundId)) return;
    const found = await fetchRound(this.cfg, roundId);
    if (!found) return;
    const entrant = entrantPda(this.cfg.programId, found.address, this.wallet.publicKey);
    if (await this.cfg.connection.getAccountInfo(entrant)) {
      this.joined.add(roundId);
      return;
    }
    try {
      await sendIxs(
        this.cfg.connection,
        [
          joinRoundIx({
            programId: this.cfg.programId,
            round: found.address,
            player: this.wallet.publicKey,
            kind: KIND_AGENT,
            label: this.persona.label,
            registrar: this.cfg.keys.authority.publicKey,
          }),
        ],
        [this.wallet, this.cfg.keys.authority],
      );
      this.joined.add(roundId);
      log(this.label, `joined round ${roundId}`);
    } catch (e) {
      log(this.label, `join failed for round ${roundId}:`, shortError(e));
    }
  }

  private snapshot(
    me: Entrant,
    others: Entrant[],
    prices: [number, number, number],
    secondsLeft: number,
    maxPriceAge: number,
  ): string {
    const equity = equityOf(me, prices);
    const board = [me, ...others]
      .map((e) => ({ label: e.label, kind: e.kind === KIND_AGENT ? "AI" : "human", equity: equityOf(e, prices) }))
      .sort((a, b) => b.equity - a.equity);
    const rank = board.findIndex((b) => b.label === me.label) + 1;
    const room = ASSETS.map((_, i) => Math.max(0, this.buyRoom(me, prices, equity, i)));
    const lines = [
      `Time left in the round: ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s.`,
      "Pyth prices now (% change over 1 and 5 minutes; how long ago the price was published):",
      ...ASSETS.map((a, i) => {
        const c1 = this.keeper.change(a, 60);
        const c5 = this.keeper.change(a, 300);
        const pct = (c: number | undefined) => (c === undefined ? "n/a" : `${fmt(c, 3)}%`);
        return `  ${a}: $${fmt(prices[i])} (1m ${pct(c1)}, 5m ${pct(c5)}; ${this.keeper.age(a) ?? "?"}s ago)`;
      }),
      `Trades fill at the latest published price while it is under ${maxPriceAge}s old.` +
        (maxPriceAge > PRICE_AGE_KEEPER ? " These devnet feeds publish about every 5 minutes, so a price a few minutes old is normal." : ""),
      `Your cash: $${fmt(me.cash)}. Holdings: ${ASSETS.map((a, i) => `${a} ${fmt(me.qty[i], 6)} ($${fmt(me.qty[i] * prices[i])})`).join(", ")}.`,
      `The most you can buy right now (your cash, and at most ${MAX_ASSET_BPS / 100}% of your equity in one coin): ` +
        `${ASSETS.map((a, i) => `${a} $${fmt(room[i])}`).join(", ")}. Orders under $${MIN_TRADE_USD} are refused.`,
      `Your equity: $${fmt(equity)} (started at $10,000.00). Rank ${rank} of ${board.length}.`,
      "Leaderboard:",
      ...board.slice(0, 5).map((b, i) => `  ${i + 1}. ${b.label} (${b.kind}) $${fmt(b.equity)}`),
      this.recent.length ? `Your last decisions: ${this.recent.slice(-3).join(" | ")}` : "You have not traded yet this round.",
    ];
    return lines.join("\n");
  }

  private async decide(context: string): Promise<Decision | null> {
    if (!this.claude) return null;
    const system = agentSystemPrompt(this.persona);
    const res = await this.claude.messages.create({
      model: this.cfg.agentModel,
      max_tokens: 400,
      system,
      tools: [DECIDE_TOOL],
      tool_choice: { type: "tool", name: "decide" },
      messages: [{ role: "user", content: context }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    this.usage.calls++;
    this.usage.input += res.usage?.input_tokens ?? 0;
    this.usage.output += res.usage?.output_tokens ?? 0;
    if (this.usage.calls % 25 === 0) {
      log(this.label, `${this.usage.calls} Claude calls so far: ${this.usage.input} tokens in, ${this.usage.output} out`);
    }
    const block = (res.content as Array<{ type: string; input?: unknown }>).find((b) => b.type === "tool_use");
    const input = block?.input as Partial<Decision> | undefined;
    if (!input?.action || !input.reason) return null;
    return {
      action: input.action,
      asset: input.asset,
      usd: typeof input.usd === "number" ? input.usd : undefined,
      reason: String(input.reason).slice(0, 200),
    };
  }

  /** Dollars of coin `i` the agent can still buy: its cash, and the program's cap per coin (with a
   *  little margin, since the price can move before the trade lands). */
  private buyRoom(me: Entrant, prices: [number, number, number], equity: number, i: number): number {
    const position = me.qty[i] * prices[i];
    return Math.min(me.cash, ((equity * MAX_ASSET_BPS) / 10_000 - position) * 0.98);
  }

  /** Clamps a decision to what the program will accept. Returns null when there is nothing to do. */
  private clamp(d: Decision, me: Entrant, prices: [number, number, number]): { asset: Asset; side: number; usd: number } | null {
    if (d.action === "hold" || !d.asset || !d.usd) return null;
    const i = ASSETS.indexOf(d.asset);
    if (i < 0) return null;
    const equity = equityOf(me, prices);
    if (d.action === "buy") {
      const usd = Math.min(d.usd, this.buyRoom(me, prices, equity, i));
      // An order cut to a fraction of its size is no longer the trade its reason describes.
      return usd >= MIN_TRADE_USD && usd >= d.usd / 2 ? { asset: d.asset, side: SIDE_BUY, usd } : null;
    }
    const held = me.qty[i] * prices[i];
    if (held < MIN_TRADE_USD) return null;
    return { asset: d.asset, side: SIDE_SELL, usd: Math.max(MIN_TRADE_USD, Math.min(d.usd, held)) };
  }

  async tick() {
    const now = Math.floor(Date.now() / 1000);
    const roundId = roundIdAt(now);
    const { start, end } = roundTimes(roundId);
    await this.ensureJoined(roundId);
    if (now >= end - 240) await this.ensureJoined(roundId + 1);
    if (now < start + 5 || now > end - 15) return;

    const prices = ASSETS.map((a) => this.keeper.latest(a)) as [number, number, number];
    if (prices.some((p) => p === undefined)) return;

    const found = await fetchRound(this.cfg, roundId);
    if (!found) return;
    const entrants = (await fetchEntrants(this.cfg, found.address)).map((e) => e.entrant);
    const me = entrants.find((e) => e.player.equals(this.wallet.publicKey as PublicKey));
    if (!me) return;
    const others = entrants.filter((e) => !e.player.equals(this.wallet.publicKey));

    // Pyth's sponsored devnet feeds move every few minutes: don't ask Claude about the same
    // prices again, except every five minutes so the agent still sees the board and the clock.
    const seen = ASSETS.map((a) => this.keeper.history?.[a]?.at(-1)?.t ?? 0).join(",");
    if (seen === this.decidedOn && Date.now() - this.decidedAt < 300_000) return;

    let decision: Decision | null = null;
    try {
      decision = await this.decide(this.snapshot(me, others, prices, end - now, found.round.maxPriceAge));
      this.decidedOn = seen;
      this.decidedAt = Date.now();
    } catch (e) {
      log(this.label, "Claude call failed:", (e as Error).message?.slice(0, 200));
      return;
    }
    if (!decision) return;
    const order = this.clamp(decision, me, prices);
    const wanted = `${decision.action} ${decision.asset ?? "?"} $${Math.round(decision.usd ?? 0)}`;
    this.recent.push(
      decision.action === "hold" ? "hold" : order ? `${decision.action} ${order.asset} $${Math.round(order.usd)}` : `${wanted} (not placed: outside the limits)`,
    );
    if (this.recent.length > 6) this.recent.shift();
    if (!order) {
      log(this.label, decision.action === "hold" ? `holds: ${decision.reason}` : `can't ${wanted} within the limits, so holds: ${decision.reason}`);
      return;
    }
    // The program refuses fills at prices older than the round allows; don't pay for a failed trade.
    const age = this.keeper.age(order.asset);
    if (age !== undefined && age > found.round.maxPriceAge - 3) {
      log(this.label, `skips its ${order.asset} trade: the price is ${age}s old, over this round's ${found.round.maxPriceAge}s limit`);
      return;
    }
    try {
      const sig = await sendIxs(
        this.cfg.connection,
        [
          memoIx(decision.reason),
          tradeIx({
            programId: this.cfg.programId,
            round: found.address,
            player: this.wallet.publicKey,
            asset: order.asset,
            side: order.side,
            usd: order.usd,
            reasonHash: reasonHash(decision.reason),
            shardId: found.round.shardId,
          }),
        ],
        [this.wallet],
      );
      log(this.label, `${order.side === SIDE_BUY ? "bought" : "sold"} $${Math.round(order.usd)} ${order.asset}: ${decision.reason}`, sig);
    } catch (e) {
      log(this.label, "trade failed:", shortError(e));
    }
  }

  async run(until: number, offsetMs: number) {
    await sleep(offsetMs);
    while (Date.now() < until) {
      const started = Date.now();
      try {
        await this.tick();
      } catch (e) {
        log(this.label, "tick error:", shortError(e));
      }
      await sleep(Math.max(5_000, this.cfg.agentIntervalMs - (Date.now() - started)));
    }
  }
}

export function makeAgents(cfg: Config, keeper: PriceKeeper): Agent[] {
  const claude = cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
  if (!claude) log("agents", "ANTHROPIC_API_KEY is not set: agents will join rounds but not trade");
  return cfg.keys.agents.map((w, i) => new Agent(cfg, keeper, w, PERSONAS[i], claude));
}
