// Duels: a player challenges one of the house's agents to one trade each, in a style that caps
// how long a trade may stay open (scalp 15 minutes, swing 7 days, long-term 30 days). The agent
// named in the duel's id joins, opens its own trade with its reason on chain, and closes it when
// its call says so. The program decides the duel as soon as both trades are closed, or at the
// time limit at the closing price; the house only sends the transactions that settle it.

import Anthropic from "@anthropic-ai/sdk";
import type { PublicKey } from "@solana/web3.js";
import {
  ASSETS,
  DUEL_CASH,
  DUEL_STYLES,
  KIND_AGENT,
  KIND_HUMAN,
  PERSONAS,
  ROUND_SIZE,
  SIDE_BUY,
  SIDE_CLOSE,
  SIDE_SELL,
  decodeRound,
  duelAgent,
  duelStyle,
  duelTrade,
  equityOf,
  finalizeRoundIx,
  isDuel,
  joinRoundIx,
  memoIx,
  reasonHash,
  settleIx,
  tradeIx,
  type Asset,
  type Entrant,
  type Persona,
  type Round,
} from "@turing-pit/sdk";
import { log, sleep, type Config } from "./config.js";
import type { PriceKeeper } from "./keeper.js";
import { fetchEntrants } from "./rounds.js";
import { sendIxs, shortError } from "./send.js";

type Style = (typeof DUEL_STYLES)[number];

/** How often the agent looks at an open duel trade, by style. */
const CADENCE_MS: Record<Style["key"], number> = { scalp: 45_000, swing: 3_600_000, long: 6 * 3_600_000 };
/** The most duels the house plays at once, so a flood of them can't run up its bills. */
const MAX_ACTIVE = 24;

interface Call {
  action: "long" | "short" | "close" | "hold";
  asset?: Asset;
  usd?: number;
  reason: string;
}

const DUEL_TOOL = {
  name: "decide",
  description: "Make one decision about your duel trade.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["long", "short", "close", "hold"],
        description: "long or short opens your one trade (only while you have none); close ends it for good; hold keeps waiting.",
      },
      asset: { type: "string", enum: [...ASSETS], description: "The coin, when opening." },
      usd: { type: "number", description: "Size in dollars when opening, $10 to $9,900." },
      reason: { type: "string", description: "Why, in at most 200 characters, citing the numbers you used. Posted on chain." },
    },
    required: ["action", "reason"],
  },
};

export function duelPrompt(persona: Persona, style: Style): string {
  return [
    `You are ${persona.label}, an AI trader in Turing Pit, where AI agents and humans compete in paper trading on Solana.`,
    `A human has challenged you to a ${style.label.toLowerCase()} duel: one trade each, open for at most ${style.limit}.`,
    persona.style,
    "Rules: you have $10,000. Open one trade, long or short SOL, BTC or ETH, from $10 to $9,900, at the live Pyth price; each side of it costs a 0.1% fee.",
    "Then decide when to close it. Closing is final. A trade still open at the time limit is marked at the closing price.",
    "The trade with the higher return wins the duel. Your reason is published on chain next to your trade, so make it sharp, specific and under 200 characters.",
    "Call the decide tool exactly once.",
  ].join(" ");
}

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
const left = (s: number) =>
  s >= 2 * 86_400 ? `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3_600)}h` : s >= 3_600 ? `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;

export class DuelManager {
  private claude: Anthropic | null;
  /** When the agent last looked at each duel (by round address); tests clear it. */
  readonly lookedAt = new Map<string, number>();
  private warned = new Set<string>();

  constructor(
    private cfg: Config,
    private keeper: PriceKeeper,
    claude?: Anthropic | null,
  ) {
    this.claude = claude !== undefined ? claude : cfg.anthropicKey ? new Anthropic({ apiKey: cfg.anthropicKey }) : null;
  }

  /** Duels under the house's address that are not decided yet. Byte 45 of a round account is the
   *  sixth byte of its id, which is 6 for every duel ("7" in base58). */
  private async open(): Promise<{ address: PublicKey; round: Round }[]> {
    const accounts = await this.cfg.connection.getProgramAccounts(this.cfg.programId, {
      filters: [
        { dataSize: ROUND_SIZE },
        { memcmp: { offset: 8, bytes: this.cfg.keys.authority.publicKey.toBase58() } },
        { memcmp: { offset: 45, bytes: "7" } },
      ],
    });
    return accounts
      .map((a) => ({ address: a.pubkey, round: decodeRound(a.account.data) }))
      .filter((d): d is { address: PublicKey; round: Round } => !!d.round && isDuel(d.round.roundId) && !d.round.finalized)
      .sort((a, b) => a.round.startTs - b.round.startTs)
      .slice(0, MAX_ACTIVE);
  }

  private async call(persona: Persona, style: Style, context: string): Promise<Call | null> {
    if (!this.claude) return null;
    const res = await this.claude.messages.create({
      model: this.cfg.agentModel,
      max_tokens: 400,
      system: duelPrompt(persona, style),
      tools: [DUEL_TOOL],
      tool_choice: { type: "tool", name: "decide" },
      messages: [{ role: "user", content: context }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = (res.content as Array<{ type: string; input?: unknown }>).find((b) => b.type === "tool_use");
    const input = block?.input as Partial<Call> | undefined;
    if (!input?.action || !input.reason) return null;
    return { action: input.action, asset: input.asset, usd: typeof input.usd === "number" ? input.usd : undefined, reason: String(input.reason).slice(0, 200) };
  }

  private describe(e: Entrant, prices: [number, number, number]): string {
    const t = duelTrade(e);
    if (e.settled || (e.trades >= 2 && !t)) return `closed, final return ${pct(((e.settled ? e.finalEquity : e.cash) / DUEL_CASH - 1) * 100)}`;
    if (!t) return "no trade yet";
    const now = prices[ASSETS.indexOf(t.asset)];
    return `${t.long ? "long" : "short"} ${t.asset} $${fmt(t.size, 0)} from $${fmt(t.entry)}, now $${fmt(now)}: return so far ${pct((equityOf(e, prices) / DUEL_CASH - 1) * 100)}`;
  }

  private async play(address: PublicKey, round: Round) {
    const now = Math.floor(Date.now() / 1000);
    const key = address.toBase58();
    const style = DUEL_STYLES[duelStyle(round.roundId)];
    const index = duelAgent(round.roundId);
    const wallet = this.cfg.keys.agents[index];
    const persona = PERSONAS[index];
    if (!style || !wallet || !persona) return;
    const tag = `[duel ${style.label} ${key.slice(0, 6)}]`;
    const entrants = await fetchEntrants(this.cfg, address);
    const mine = entrants.find((e) => e.entrant.player.equals(wallet.publicKey));
    const human = entrants.find((e) => e.entrant.kind === KIND_HUMAN);

    // Decided by the program as soon as both trades are closed, or at the time limit.
    if (now >= round.endTs + 3 || (round.entrants >= 2 && round.settled >= round.entrants)) {
      const unsettled = entrants.filter((e) => !e.entrant.settled);
      if (entrants.length !== round.entrants) return; // an account is still indexing
      if (unsettled.length && now < round.endTs) return;
      try {
        const sig = await sendIxs(
          this.cfg.connection,
          [
            // A trade still open at the limit is marked at the price posted here.
            ...(unsettled.length ? (this.keeper.priceIxs?.(round) ?? []) : []),
            ...unsettled.map((e) => settleIx({ programId: this.cfg.programId, round: address, entrant: e.address, feeds: round.feeds })),
            finalizeRoundIx({ programId: this.cfg.programId, round: address, entrants: entrants.map((e) => e.address) }),
          ],
          [this.cfg.keys.authority],
          { computeUnits: 400_000 },
        );
        const traders = entrants.filter((e) => e.entrant.trades > 0);
        const eq = (e: Entrant) => (e.settled ? e.finalEquity : equityOf(e, ASSETS.map((a) => this.keeper.latest(a) ?? 0) as [number, number, number]));
        const best = [...traders].sort((a, b) => eq(b.entrant) - eq(a.entrant))[0];
        log("duels", tag, `decided: ${best ? `${best.entrant.label} wins` : "nobody traded"}`, sig);
      } catch (e) {
        if (!this.warned.has(key)) log("duels", tag, "deciding failed:", shortError(e));
        this.warned.add(key);
      }
      return;
    }
    if (!human) return;
    if (!mine) {
      if (now > round.endTs - 60) return;
      await sendIxs(
        this.cfg.connection,
        [
          joinRoundIx({
            programId: this.cfg.programId,
            round: address,
            player: wallet.publicKey,
            kind: KIND_AGENT,
            label: persona.label,
            registrar: this.cfg.keys.authority.publicKey,
          }),
        ],
        [wallet, this.cfg.keys.authority],
      );
      log(persona.label, tag, `accepted ${human.entrant.label}'s challenge`);
      return;
    }
    if (mine.entrant.settled || mine.entrant.trades >= 2) return;
    const due = mine.entrant.trades === 0 ? 20_000 : CADENCE_MS[style.key];
    if (Date.now() - (this.lookedAt.get(key) ?? 0) < due) return;
    if (now > round.endTs - 20) return; // too late to trade; the program marks it at the close
    const prices = ASSETS.map((a) => this.keeper.latest(a)) as [number, number, number];
    if (prices.some((p) => p === undefined)) return;
    this.lookedAt.set(key, Date.now());

    const context = [
      `Duel: ${style.label}, against ${human.entrant.label} (human). Time left: ${left(round.endTs - now)}.`,
      "Prices now (% change over 1 minute, 5 minutes and 1 hour):",
      ...ASSETS.map(
        (a, i) =>
          `  ${a}: $${fmt(prices[i])} (1m ${pct(this.keeper.change(a, 60) ?? 0)}, 5m ${pct(this.keeper.change(a, 300) ?? 0)}, 1h ${pct(this.keeper.change(a, 3_600) ?? 0)})`,
      ),
      `${human.entrant.label}'s trade: ${this.describe(human.entrant, prices)}.`,
      `Your trade: ${this.describe(mine.entrant, prices)}.`,
      mine.entrant.trades === 0
        ? "Open your trade now: long or short one coin, $10 to $9,900."
        : "Close it now to lock in this return, or hold.",
    ].join("\n");
    let call: Call | null;
    try {
      call = await this.call(persona, style, context);
    } catch (e) {
      log(persona.label, tag, "Claude call failed:", (e as Error).message?.slice(0, 200));
      return;
    }
    if (!call) return;

    // On the house's prices, each trade carries its own fresh price, posted (and signed) by the house.
    const post = this.keeper.priceIxs?.(round) ?? [];
    const signers = post.length ? [wallet, this.cfg.keys.authority] : [wallet];
    const own = (ixs: ReturnType<typeof tradeIx>[]) => [...post, memoIx(call!.reason), ...ixs];
    const trade = (asset: Asset, side: number, usd: number) =>
      tradeIx({ programId: this.cfg.programId, round: address, player: wallet.publicKey, asset, side, usd, reasonHash: reasonHash(call!.reason), feeds: round.feeds });
    try {
      if (mine.entrant.trades === 0) {
        if ((call.action !== "long" && call.action !== "short") || !call.asset) {
          log(persona.label, tag, `waits to open: ${call.reason}`);
          return;
        }
        const usd = Math.max(10, Math.min(9_900, Math.round(call.usd ?? 5_000)));
        const age = this.keeper.age(call.asset);
        if (age !== undefined && age > round.maxPriceAge - 3) return; // the program would refuse the fill
        const sig = await sendIxs(this.cfg.connection, own([trade(call.asset, call.action === "long" ? SIDE_BUY : SIDE_SELL, usd)]), signers);
        log(persona.label, tag, `opened ${call.action} ${call.asset} $${usd}: ${call.reason}`, sig);
      } else if (call.action === "close") {
        const t = duelTrade(mine.entrant);
        if (!t) return;
        const sig = await sendIxs(
          this.cfg.connection,
          [
            ...own([trade(t.asset, SIDE_CLOSE, 0)]),
            settleIx({ programId: this.cfg.programId, round: address, entrant: mine.address, feeds: round.feeds }),
          ],
          signers,
        );
        log(persona.label, tag, `closed its ${t.asset} ${t.long ? "long" : "short"}: ${call.reason}`, sig);
      } else {
        log(persona.label, tag, `holds: ${call.reason}`);
      }
    } catch (e) {
      log(persona.label, tag, "duel trade failed:", shortError(e));
    }
  }

  /** One look at every open duel. */
  async pass() {
    try {
      for (const { address, round } of await this.open()) {
        try {
          await this.play(address, round);
        } catch (e) {
          log("duels", `duel ${address.toBase58().slice(0, 6)}:`, shortError(e));
        }
      }
    } catch (e) {
      log("duels", "loop error:", shortError(e));
    }
  }

  async run(until: number) {
    if (!this.claude) log("duels", "ANTHROPIC_API_KEY is not set: agents won't answer duels");
    while (Date.now() < until) {
      await this.pass();
      await sleep(15_000);
    }
  }
}

