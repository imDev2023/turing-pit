// Three Claude-powered traders. Each holds its own wallet, plays every league (15 minutes to a
// month, and the open-ended one), and posts its reason on chain as a memo in the same transaction
// as the trade; the program stores the reason's hash, so anyone can check the memo is the reason
// the trade was made with. Agents go long or short.

import Anthropic from "@anthropic-ai/sdk";
import type { Keypair } from "@solana/web3.js";
import {
  ASSETS,
  KIND_AGENT,
  LEAGUES,
  MAX_ASSET_BPS,
  MIN_TRADE_USD,
  PERSONAS,
  PRICE_AGE_KEEPER,
  SIDE_BUY,
  SIDE_CLOSE,
  SIDE_SELL,
  entrantPda,
  equityOf,
  joinRoundIx,
  leagueOf,
  memoIx,
  reasonHash,
  roundIdAt,
  roundTimes,
  tradeIx,
  agentSystemPrompt,
  type Asset,
  type Entrant,
  type League,
  type LeagueKey,
  type Persona,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import type { PriceKeeper } from "./keeper.js";
import { fetchEntrants, fetchRound } from "./rounds.js";
import { sendIxs, shortError } from "./send.js";

export { PERSONAS };

interface Decision {
  action: "buy" | "sell" | "close" | "hold";
  asset?: Asset;
  usd?: number;
  reason: string;
}

interface Order {
  asset: Asset;
  side: number;
  usd: number;
}

const DECIDE_TOOL = {
  name: "decide",
  description: "Make exactly one trading decision for this moment.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["buy", "sell", "close", "hold"],
        description: "buy: go long or cover a short. sell: cut a long, or sell more than you hold to go short. close: flatten the whole position in the asset.",
      },
      asset: { type: "string", enum: [...ASSETS] },
      usd: { type: "number", description: "Dollars to spend on a buy, or dollar value to sell. Not needed for close." },
      reason: {
        type: "string",
        description: "Why, in at most 200 characters, citing the numbers you used. This is posted on chain.",
      },
    },
    required: ["action", "reason"],
  },
};

/** The least time between two decisions in a league, so Claude is asked as often as the round
 *  length deserves: a few times a sprint, a few times a day in the long leagues. */
const CADENCE_MS: Record<LeagueKey, number> = {
  sprint: 120_000,
  hour: 600_000,
  day: 3_600_000,
  week: 4 * 3_600_000,
  month: 12 * 3_600_000,
  open: 6 * 3_600_000,
};

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

function timeLeft(seconds: number): string {
  if (seconds >= 2 * 86_400) return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The 24-hour picture from Coinbase for the long leagues, refreshed every ten minutes. */
const market: { at: number; stats: Partial<Record<Asset, { open: number; high: number; low: number }>> } = { at: 0, stats: {} };
async function dayStats(): Promise<typeof market.stats> {
  if (Date.now() - market.at < 600_000) return market.stats;
  market.at = Date.now();
  await Promise.all(
    ASSETS.map(async (a) => {
      try {
        const r = await fetch(`https://api.exchange.coinbase.com/products/${a}-USD/stats`, { signal: AbortSignal.timeout(5_000) });
        const s = (await r.json()) as { open: string; high: string; low: string };
        market.stats[a] = { open: Number(s.open), high: Number(s.high), low: Number(s.low) };
      } catch {
        // context only; the decision goes ahead without it
      }
    }),
  );
  return market.stats;
}

export class Agent {
  private joined = new Set<number>();
  private recent = new Map<LeagueKey, string[]>();
  /** When the last decision in each league was made. */
  private decidedAt = new Map<LeagueKey, number>();
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
      log(this.label, `joined round ${roundId} (${leagueOf(roundId).label})`);
    } catch (e) {
      log(this.label, `join failed for round ${roundId}:`, shortError(e));
    }
  }

  /** Dollars of coin `i` the agent can buy: its cash, and the cap on a long (a short is covered first). */
  private buyRoom(me: Entrant, prices: [number, number, number], equity: number, i: number): number {
    const position = me.qty[i] * prices[i];
    return Math.max(0, Math.min(me.cash, ((equity * MAX_ASSET_BPS) / 10_000 - position) * 0.98));
  }

  /** Dollars of coin `i` the agent can sell: its long, then a short up to the cap. */
  private sellRoom(me: Entrant, prices: [number, number, number], equity: number, i: number): number {
    const position = me.qty[i] * prices[i];
    return Math.max(0, ((equity * MAX_ASSET_BPS) / 10_000 + position) * 0.98);
  }

  private snapshot(
    league: League,
    me: Entrant,
    others: Entrant[],
    prices: [number, number, number],
    secondsLeft: number | null,
    maxPriceAge: number,
    day: Awaited<ReturnType<typeof dayStats>>,
  ): string {
    const equity = equityOf(me, prices);
    const board = [me, ...others]
      .map((e) => ({ label: e.label, kind: e.kind === KIND_AGENT ? "AI" : "human", equity: equityOf(e, prices) }))
      .sort((a, b) => b.equity - a.equity);
    const rank = board.findIndex((b) => b.label === me.label) + 1;
    const buy = ASSETS.map((_, i) => this.buyRoom(me, prices, equity, i));
    const sell = ASSETS.map((_, i) => this.sellRoom(me, prices, equity, i));
    const pct = (c: number | undefined) => (c === undefined ? "n/a" : `${fmt(c, 3)}%`);
    const long = league.key !== "sprint" && league.key !== "hour";
    const position = (i: number) => {
      const q = me.qty[i];
      if (Math.abs(q * prices[i]) < 0.01) return `${ASSETS[i]} flat`;
      return `${ASSETS[i]} ${q > 0 ? "long" : "short"} ${fmt(Math.abs(q), 6)} ($${fmt(Math.abs(q * prices[i]))})`;
    };
    const recent = this.recent.get(league.key) ?? [];
    const lines = [
      secondsLeft === null
        ? "League: Open (no end). The highest equity leads."
        : `League: ${league.label}. Time left in this round: ${timeLeft(secondsLeft)}.`,
      "Pyth prices now (% change over 1 minute, 5 minutes and 1 hour; how long ago the price was published):",
      ...ASSETS.map((a, i) => {
        const d = day[a];
        const range = long && d ? `; 24h ${pct(((prices[i] - d.open) / d.open) * 100)}, range $${fmt(d.low)}-$${fmt(d.high)}` : "";
        return `  ${a}: $${fmt(prices[i])} (1m ${pct(this.keeper.change(a, 60))}, 5m ${pct(this.keeper.change(a, 300))}, 1h ${pct(this.keeper.change(a, 3_600))}${range}; ${this.keeper.age(a) ?? "?"}s ago)`;
      }),
      `Trades fill at the latest published price while it is under ${maxPriceAge}s old.` +
        (maxPriceAge > PRICE_AGE_KEEPER ? " These devnet feeds publish about every 5 minutes, so a price a few minutes old is normal." : ""),
      `Your cash: $${fmt(me.cash)}. Positions: ${ASSETS.map((_, i) => position(i)).join(", ")}.`,
      `The most you can buy right now: ${ASSETS.map((a, i) => `${a} $${fmt(buy[i])}`).join(", ")}. ` +
        `The most you can sell (your long, then a short): ${ASSETS.map((a, i) => `${a} $${fmt(sell[i])}`).join(", ")}. ` +
        `No position may exceed ${MAX_ASSET_BPS / 100}% of your equity; orders under $${MIN_TRADE_USD} are refused.`,
      `Your equity: $${fmt(equity)} (started at $10,000.00). Rank ${rank} of ${board.length}.`,
      "Leaderboard:",
      ...board.slice(0, 5).map((b, i) => `  ${i + 1}. ${b.label} (${b.kind}) $${fmt(b.equity)}`),
      me.trades === 0 ? "You have not traded yet this round, and only players who trade can win." : "",
      recent.length ? `Your last decisions in this league: ${recent.slice(-3).join(" | ")}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  private async decide(league: League, context: string): Promise<Decision | null> {
    if (!this.claude) return null;
    const res = await this.claude.messages.create({
      model: this.cfg.agentModel,
      max_tokens: 400,
      system: agentSystemPrompt(this.persona, league),
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

  /** Turns a decision into an order the program will accept, or null when there is nothing to do. */
  private clamp(d: Decision, me: Entrant, prices: [number, number, number]): Order | null {
    if (d.action === "hold" || !d.asset) return null;
    const i = ASSETS.indexOf(d.asset);
    if (i < 0) return null;
    const value = me.qty[i] * prices[i];
    if (d.action === "close") return Math.abs(value) >= 0.01 ? { asset: d.asset, side: SIDE_CLOSE, usd: 0 } : null;
    if (!d.usd) return null;
    const equity = equityOf(me, prices);
    // An order that would land within 1% of flat closes the position exactly instead.
    if (d.action === "buy" && value < 0 && Math.abs(d.usd + value) <= Math.abs(value) * 0.01) return { asset: d.asset, side: SIDE_CLOSE, usd: 0 };
    if (d.action === "sell" && value > 0 && Math.abs(d.usd - value) <= value * 0.01) return { asset: d.asset, side: SIDE_CLOSE, usd: 0 };
    const room = d.action === "buy" ? this.buyRoom(me, prices, equity, i) : this.sellRoom(me, prices, equity, i);
    const usd = Math.min(d.usd, room);
    // An order cut to a fraction of its size is no longer the trade its reason describes.
    if (usd < MIN_TRADE_USD || usd < d.usd / 2) return null;
    return { asset: d.asset, side: d.action === "buy" ? SIDE_BUY : SIDE_SELL, usd };
  }

  /** One look at a league: join its round (and the next one as it nears), then decide if due. */
  private async play(league: League, now: number) {
    const roundId = roundIdAt(now, league.key);
    const { start, end, next } = roundTimes(roundId);
    await this.ensureJoined(roundId);
    if (league.key !== "open" && now >= next - 240) await this.ensureJoined(roundId + 1);
    if (now < start + 5 || now > end - 15) return;
    if (Date.now() - (this.decidedAt.get(league.key) ?? 0) < CADENCE_MS[league.key]) return;

    const prices = ASSETS.map((a) => this.keeper.latest(a)) as [number, number, number];
    if (prices.some((p) => p === undefined)) return;
    const found = await fetchRound(this.cfg, roundId);
    if (!found) return;
    const entrants = (await fetchEntrants(this.cfg, found.address)).map((e) => e.entrant);
    const me = entrants.find((e) => e.player.equals(this.wallet.publicKey));
    if (!me) return;
    const others = entrants.filter((e) => !e.player.equals(this.wallet.publicKey));
    const day = league.key === "sprint" || league.key === "hour" ? {} : await dayStats();

    let decision: Decision | null = null;
    try {
      const secondsLeft = league.key === "open" ? null : end - now;
      decision = await this.decide(league, this.snapshot(league, me, others, prices, secondsLeft, found.round.maxPriceAge, day));
      this.decidedAt.set(league.key, Date.now());
    } catch (e) {
      log(this.label, "Claude call failed:", (e as Error).message?.slice(0, 200));
      return;
    }
    if (!decision) return;
    const order = this.clamp(decision, me, prices);
    const wanted = `${decision.action} ${decision.asset ?? "?"}${decision.usd ? ` $${Math.round(decision.usd)}` : ""}`;
    const recent = this.recent.get(league.key) ?? [];
    recent.push(decision.action === "hold" ? "hold" : order ? describe(order) : `${wanted} (not placed: outside the limits)`);
    this.recent.set(league.key, recent.slice(-6));
    const where = `[${league.label}]`;
    if (!order) {
      log(this.label, where, decision.action === "hold" ? `holds: ${decision.reason}` : `can't ${wanted} within the limits, so holds: ${decision.reason}`);
      return;
    }
    // The program refuses fills at prices older than the round allows; don't pay for a failed trade.
    const age = this.keeper.age(order.asset);
    if (age !== undefined && age > found.round.maxPriceAge - 3) {
      log(this.label, where, `skips its ${order.asset} trade: the price is ${age}s old, over this round's ${found.round.maxPriceAge}s limit`);
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
      log(this.label, where, `${describe(order)}: ${decision.reason}`, sig);
    } catch (e) {
      log(this.label, where, "trade failed:", shortError(e));
    }
  }

  async tick() {
    const now = Math.floor(Date.now() / 1000);
    for (const league of LEAGUES) {
      try {
        await this.play(league, now);
      } catch (e) {
        log(this.label, `[${league.label}] tick error:`, shortError(e));
      }
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

function describe(order: Order): string {
  if (order.side === SIDE_CLOSE) return `closed ${order.asset}`;
  return `${order.side === SIDE_BUY ? "bought" : "sold"} $${Math.round(order.usd)} ${order.asset}`;
}

export function makeAgents(cfg: Config, keeper: PriceKeeper): Agent[] {
  const claude = cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
  if (!claude) log("agents", "ANTHROPIC_API_KEY is not set: agents will join rounds but not trade");
  return cfg.keys.agents.map((w, i) => new Agent(cfg, keeper, w, PERSONAS[i], claude));
}
