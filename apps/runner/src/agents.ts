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
  type Asset,
  type Entrant,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import type { PriceKeeper } from "./keeper.js";
import { fetchEntrants, fetchRound } from "./rounds.js";
import { sendIxs, shortError } from "./send.js";

interface Persona {
  label: string;
  style: string;
}

export const PERSONAS: Persona[] = [
  {
    label: "Claude Momentum",
    style:
      "You are a momentum trader. You buy what has been rising over the last few minutes and cut what is falling. You size up when a move is clean and you never fight the trend.",
  },
  {
    label: "Claude Contrarian",
    style:
      "You are a contrarian. You buy sharp dips and trim after spikes, expecting short moves to snap back. You stay patient and keep some cash for the next overreaction.",
  },
  {
    label: "Claude Degen",
    style:
      "You are an aggressive risk-taker. You make concentrated bets, swing for the win, and hate sitting in cash when you are behind on the leaderboard.",
  },
];

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
  ): string {
    const equity = equityOf(me, prices);
    const board = [me, ...others]
      .map((e) => ({ label: e.label, kind: e.kind === KIND_AGENT ? "AI" : "human", equity: equityOf(e, prices) }))
      .sort((a, b) => b.equity - a.equity);
    const rank = board.findIndex((b) => b.label === me.label) + 1;
    const lines = [
      `Time left in the round: ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s.`,
      "Prices now (and % change over 1 and 5 minutes):",
      ...ASSETS.map((a, i) => {
        const c1 = this.keeper.change(a, 60);
        const c5 = this.keeper.change(a, 300);
        return `  ${a}: $${fmt(prices[i])} (${c1 === undefined ? "n/a" : fmt(c1, 3)}%, ${c5 === undefined ? "n/a" : fmt(c5, 3)}%)`;
      }),
      `Your cash: $${fmt(me.cash)}. Holdings: ${ASSETS.map((a, i) => `${a} ${fmt(me.qty[i], 6)} ($${fmt(me.qty[i] * prices[i])})`).join(", ")}.`,
      `Your equity: $${fmt(equity)} (started at $10,000.00). Rank ${rank} of ${board.length}.`,
      "Leaderboard:",
      ...board.slice(0, 5).map((b, i) => `  ${i + 1}. ${b.label} (${b.kind}) $${fmt(b.equity)}`),
      this.recent.length ? `Your last decisions: ${this.recent.slice(-3).join(" | ")}` : "You have not traded yet this round.",
    ];
    return lines.join("\n");
  }

  private async decide(context: string): Promise<Decision | null> {
    if (!this.claude) return null;
    const system = [
      `You are ${this.persona.label}, an AI trader in Turing Pit: a live 14-minute paper-trading round on Solana where AI agents compete against humans.`,
      this.persona.style,
      "Rules: long only (buy, sell or hold) in SOL, BTC or ETH at live Pyth prices. Every entrant starts with $10,000. Trades cost 0.1%.",
      "No single asset may exceed 50% of your equity. Minimum trade $10. The highest equity when the round ends wins.",
      "Your reason is published on chain next to your trade, so make it sharp, specific and under 200 characters.",
      "Call the decide tool exactly once.",
    ].join(" ");
    const res = await this.claude.messages.create({
      model: this.cfg.agentModel,
      max_tokens: 400,
      system,
      tools: [DECIDE_TOOL],
      tool_choice: { type: "tool", name: "decide" },
      messages: [{ role: "user", content: context }],
    } as Anthropic.MessageCreateParamsNonStreaming);
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

  /** Clamps a decision to what the program will accept. Returns null when there is nothing to do. */
  private clamp(d: Decision, me: Entrant, prices: [number, number, number]): { asset: Asset; side: number; usd: number } | null {
    if (d.action === "hold" || !d.asset || !d.usd) return null;
    const i = ASSETS.indexOf(d.asset);
    if (i < 0) return null;
    const equity = equityOf(me, prices);
    if (d.action === "buy") {
      const position = me.qty[i] * prices[i];
      const room = (equity * MAX_ASSET_BPS) / 10_000 - position;
      const usd = Math.min(d.usd, me.cash, room * 0.98);
      return usd >= MIN_TRADE_USD ? { asset: d.asset, side: SIDE_BUY, usd } : null;
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

    let decision: Decision | null = null;
    try {
      decision = await this.decide(this.snapshot(me, others, prices, end - now));
    } catch (e) {
      log(this.label, "Claude call failed:", (e as Error).message?.slice(0, 200));
      return;
    }
    if (!decision) return;
    const order = this.clamp(decision, me, prices);
    this.recent.push(`${decision.action}${decision.asset ? " " + decision.asset : ""}${order ? ` $${Math.round(order.usd)}` : ""}`);
    if (this.recent.length > 6) this.recent.shift();
    if (!order) {
      log(this.label, `holds: ${decision.reason}`);
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
