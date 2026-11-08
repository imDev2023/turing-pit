import { useState } from "react";
import {
  ASSETS,
  DUEL_STYLES,
  KIND_AGENT,
  KIND_HUMAN,
  PERSONAS,
  SIDE_BUY,
  SIDE_CLOSE,
  SIDE_SELL,
  duelAgent,
  duelStyle,
  duelTrade,
  equityOf,
  finalizeRoundIx,
  joinRoundIx,
  memoIx,
  newDuelId,
  openDuelIx,
  reasonHash,
  roundPda,
  settleIx,
  tradeIx,
  type Asset,
  type Entrant,
} from "@turing-pit/sdk";
import { AUTHORITY, PROGRAM_ID, explorerTx } from "./config";
import { countdown, pct, price, savedName, usd } from "./format";
import type { Sender } from "./send";
import type { Duel, DuelsState } from "./useDuels";

const MAX = 9_900;
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

/** A side of a duel: its trade, and its return so far (or final). */
function side(e: Entrant | undefined, prices: number[]) {
  if (!e) return null;
  const t = duelTrade(e);
  const equity = e.settled ? e.finalEquity : prices.every((p) => p > 0) ? equityOf(e, prices as [number, number, number]) : e.cash;
  return { trade: t, closed: e.settled || e.trades >= 2, opened: e.trades > 0, ret: (equity / 10_000 - 1) * 100 };
}

export function DuelsView({ state, sender, now }: { state: DuelsState; sender: Sender; now: number }) {
  const me = sender.player;
  const mine = me ? state.duels.filter((d) => d.human?.entrant.player.equals(me)) : [];
  const others = state.duels.filter((d) => !me || !d.human?.entrant.player.equals(me)).slice(0, 12);
  const decided = state.duels.filter((d) => d.round.finalized && d.round.winnerEquity > 0);
  const machines = decided.filter((d) => d.round.winnerKind === KIND_AGENT).length;
  return (
    <div className="duels">
      <NewDuel state={state} sender={sender} />
      <div className="stack">
        <section className="card" aria-label="Your duels">
          <header>
            <h2>Your duels</h2>
            <span className="aside">
              Machines <b className="n machine">{machines}</b> · Humans <b className="n human">{decided.length - machines}</b>
            </span>
          </header>
          {!me ? <p className="empty">Connect a wallet</p> : mine.length === 0 ? <p className="empty">None yet</p> : null}
          <ol className="duel-list">
            {mine.map((d) => (
              <DuelCard key={d.address.toBase58()} duel={d} state={state} sender={sender} now={now} mine />
            ))}
          </ol>
        </section>
        {others.length > 0 && (
          <section className="card" aria-label="Other duels">
            <header>
              <h2>Everyone's duels</h2>
            </header>
            <ol className="duel-list">
              {others.map((d) => (
                <DuelCard key={d.address.toBase58()} duel={d} state={state} sender={sender} now={now} />
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

function NewDuel({ state, sender }: { state: DuelsState; sender: Sender }) {
  const [style, setStyle] = useState(0);
  const [agent, setAgent] = useState(-1);
  const [asset, setAsset] = useState<Asset>("SOL");
  const [long, setLong] = useState(true);
  const [amount, setAmount] = useState("5000");
  const [why, setWhy] = useState("");
  const value = Math.min(MAX, Number(amount) || 0);
  const opponent = agent < 0 ? "any agent" : PERSONAS[agent].label;

  const start = () => {
    const player = sender.player;
    if (!player || !PROGRAM_ID || !AUTHORITY) return;
    if (!(value >= 10)) return sender.setNote({ ok: false, text: "Minimum $10" });
    const pick = agent < 0 ? Math.floor(random() * PERSONAS.length) : agent;
    const id = newDuelId(style, pick, random);
    const round = roundPda(PROGRAM_ID, AUTHORITY, id);
    const reason = why.trim().slice(0, 200) || `${long ? "Long" : "Short"} ${asset}`;
    const { shardId, maxPriceAge } = state.source;
    sender
      .send(
        [
          openDuelIx({ programId: PROGRAM_ID, authority: AUTHORITY, player, roundId: id, style, shardId, maxPriceAge }),
          joinRoundIx({ programId: PROGRAM_ID, round, player, kind: KIND_HUMAN, label: (savedName() || player.toBase58().slice(0, 6)).slice(0, 24) }),
          memoIx(reason),
          tradeIx({ programId: PROGRAM_ID, round, player, asset, side: long ? SIDE_BUY : SIDE_SELL, usd: value, reasonHash: reasonHash(reason), shardId }),
        ],
        `Duel on: ${long ? "long" : "short"} ${asset} vs ${PERSONAS[pick].label}`,
      )
      .then((ok) => {
        if (ok) {
          setWhy("");
          state.refresh();
        }
      });
  };

  return (
    <section className="card" aria-label="New duel">
      <header>
        <h2>New duel</h2>
      </header>
      <form
        className="body order"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="seg wide" role="radiogroup" aria-label="Style">
          {DUEL_STYLES.map((s, i) => (
            <button type="button" key={s.key} role="radio" aria-checked={style === i} className={style === i ? "on" : ""} onClick={() => setStyle(i)}>
              {s.label} <span className="unit">{s.limit.replace(" minutes", "m").replace(" days", "d")}</span>
            </button>
          ))}
        </div>
        <div className="seg wide" role="radiogroup" aria-label="Opponent">
          {PERSONAS.map((p, i) => (
            <button type="button" key={p.label} role="radio" aria-checked={agent === i} className={agent === i ? "on" : ""} onClick={() => setAgent(i)}>
              {p.label.replace("Claude ", "")}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={agent < 0} className={agent < 0 ? "on" : ""} onClick={() => setAgent(-1)}>
            Any
          </button>
        </div>
        <div className="seg wide" role="radiogroup" aria-label="Coin">
          {ASSETS.map((a) => (
            <button type="button" key={a} role="radio" aria-checked={a === asset} className={a === asset ? "on" : ""} onClick={() => setAsset(a)}>
              {a}
            </button>
          ))}
        </div>
        <div className="seg wide" role="radiogroup" aria-label="Direction">
          <button type="button" role="radio" aria-checked={long} className={long ? "on buy" : ""} onClick={() => setLong(true)}>
            Long
          </button>
          <button type="button" role="radio" aria-checked={!long} className={!long ? "on sell" : ""} onClick={() => setLong(false)}>
            Short
          </button>
        </div>
        <label className="amount">
          <span>$</span>
          <input aria-label="Size in dollars" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
        </label>
        <div className="presets">
          {[2_500, 5_000, MAX].map((v) => (
            <button type="button" key={v} onClick={() => setAmount(String(v))}>
              {v === MAX ? "Max" : usd(v, 0)}
            </button>
          ))}
        </div>
        <input aria-label="Reason, posted on chain" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Reason (on chain)" maxLength={200} />
        <button className={`btn wide ${long ? "buy" : "sell"}`} disabled={sender.busy || !sender.player}>
          {!sender.player ? "Connect a wallet" : sender.busy ? "Sending…" : `${long ? "Long" : "Short"} ${asset} vs ${opponent}`}
        </button>
      </form>
      {sender.note && (
        <p className={`toast ${sender.note.ok ? "ok" : "bad"}`} role="status">
          {sender.note.text}
          {sender.note.sig && (
            <a href={explorerTx(sender.note.sig)} target="_blank" rel="noreferrer">
              Tx ↗
            </a>
          )}
        </p>
      )}
    </section>
  );
}

function DuelCard({ duel, state, sender, now, mine = false }: { duel: Duel; state: DuelsState; sender: Sender; now: number; mine?: boolean }) {
  const { round } = duel;
  const prices = (state.prices[round.shardId] ?? []).map((p) => p?.price ?? 0);
  const style = DUEL_STYLES[duelStyle(round.roundId)];
  const agentName = duel.agent?.entrant.label ?? PERSONAS[duelAgent(round.roundId)]?.label ?? "Agent";
  const humanName = mine ? "You" : (duel.human?.entrant.label ?? "Player");
  const you = side(duel.human?.entrant, prices);
  const them = side(duel.agent?.entrant, prices);
  let status: string;
  let tone = "";
  if (round.finalized) {
    if (round.winnerEquity === 0) status = "No trades";
    else if (round.winnerKind === KIND_AGENT) {
      status = mine ? "Lost" : `${agentName.replace("Claude ", "")} won`;
      tone = "machine";
    } else {
      status = mine ? "Won" : `${humanName} won`;
      tone = "human";
    }
  } else if (now >= round.endTs) status = "Deciding";
  else status = countdown(round.endTs - now);

  const close = () => {
    const player = sender.player;
    const h = duel.human;
    if (!player || !PROGRAM_ID || !h || !you?.trade) return;
    const reason = `Closing my ${you.trade.asset} ${you.trade.long ? "long" : "short"}`;
    const ixs = [
      memoIx(reason),
      tradeIx({ programId: PROGRAM_ID, round: duel.address, player, asset: you.trade.asset, side: SIDE_CLOSE, usd: 0, reasonHash: reasonHash(reason), shardId: round.shardId }),
      settleIx({ programId: PROGRAM_ID, round: duel.address, entrant: h.address, shardId: round.shardId }),
    ];
    // When the agent's trade is already closed, this decides the duel in the same transaction.
    if (duel.agent?.entrant.settled) ixs.push(finalizeRoundIx({ programId: PROGRAM_ID, round: duel.address, entrants: [h.address, duel.agent.address] }));
    sender.send(ixs, "Trade closed").then((ok) => ok && state.refresh());
  };

  const row = (name: string, s: ReturnType<typeof side>, ai: boolean, action?: JSX.Element) => (
    <div className={`duel-side ${ai ? "ai" : "human"}`}>
      <span className="who">
        <i className="mark" aria-label={ai ? "Claude agent" : "Human"} />
        {name}
      </span>
      <span className="what">
        {!s ? "Joining…" : !s.opened ? "Thinking…" : s.trade ? `${s.trade.long ? "Long" : "Short"} ${s.trade.asset} ${usd(s.trade.size, 0)} @ ${price(s.trade.asset, s.trade.entry)}` : "Closed"}
      </span>
      <span className={`n r ${!s?.opened ? "" : s.ret >= 0 ? "up" : "down"}`}>{s?.opened ? pct(s.ret) : "–"}</span>
      {action ?? <span />}
    </div>
  );

  const canClose = mine && !round.finalized && now < round.endTs && you?.opened && !you.closed;
  return (
    <li className="duel">
      <div className="duel-head">
        <span>
          {style?.label ?? "Duel"}
          {!mine && ` · ${humanName}`} vs {agentName}
        </span>
        <span className={`status n ${tone}`}>{status}</span>
      </div>
      {row(humanName, you, false, canClose ? (
        <button className="btn ghost small" disabled={sender.busy} onClick={close}>
          Close
        </button>
      ) : undefined)}
      {row(agentName, them, true)}
    </li>
  );
}
