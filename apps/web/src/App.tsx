import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  ASSETS,
  KIND_AGENT,
  KIND_HUMAN,
  LEAGUES,
  MAX_ASSET_BPS,
  PERSONAS,
  PRICE_AGE_KEEPER,
  PRICE_AGE_SPONSORED,
  SHARD_ID,
  SIDE_BUY,
  SIDE_CLOSE,
  SIDE_SELL,
  agentSystemPrompt,
  explainError,
  joinRoundIx,
  memoIx,
  reasonHash,
  replayFills,
  roundIdAt,
  roundTimes,
  tradeIx,
  type Asset,
  type League,
  type LeagueKey,
  type Position,
} from "@turing-pit/sdk";
import { Chart, type ChartLine, type ChartMark } from "./Chart";
import { PROGRAM_ID, explorerAddress, explorerTx } from "./config";
import { INTERVALS, priceAt, useQuotes, type Quote } from "./market";
import { useArena, type ArenaState, type LastRound, type PastRound, type Row, type Thought } from "./useArena";

type Phase = "live" | "settling";
type Quotes = Partial<Record<Asset, Quote>>;

const usd = (n: number, d = 2) =>
  (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signedUsd = (n: number, d = 2) => (n >= 0 ? "+" : "") + usd(n, d);
const pct = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%";
const pts = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2);
const kilo = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `$${Math.round(n)}`);
const pad = (n: number) => String(n).padStart(2, "0");
const priceDp = (a: Asset, p: number) => (a === "BTC" && p > 10_000 ? 0 : 2);
const coinDp: Record<Asset, number> = { SOL: 3, BTC: 5, ETH: 4 };
const ordinal = (n: number) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

/** A countdown: mm:ss under an hour, h:mm:ss under a day, then days and hours. */
const countdown = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  const d = Math.floor(v / 86_400);
  const h = Math.floor((v % 86_400) / 3_600);
  const m = Math.floor((v % 3_600) / 60);
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  if (h > 0) return `${h}:${pad(m)}:${pad(v % 60)}`;
  return `${pad(m)}:${pad(v % 60)}`;
};
const brief = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  const d = Math.floor(v / 86_400);
  const h = Math.floor((v % 86_400) / 3_600);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(Math.floor((v % 3_600) / 60))}m`;
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
};
const ago = (ts: number, now: number) => {
  const s = Math.max(0, now - ts);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
};
const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + " UTC";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A time as the league reads it: the hour for short rounds, the day as well for long ones. */
const stamp = (ts: number, league: League) => {
  if (league.key === "sprint" || league.key === "hour") return utc(ts);
  const d = new Date(ts * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${utc(ts)}`;
};

/** Pit traders wore a three-letter badge; ours come from the name on the board. */
function badge(label: string, ai: boolean): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  const pick = (ai && words.length > 1 ? words[1] : words[0]) ?? "PIT";
  return pick.slice(0, 3).toUpperCase().padEnd(3, "X");
}

const DEFAULT_INTERVAL: Record<LeagueKey, number> = { sprint: 60, hour: 60, day: 900, week: 3_600, month: 21_600, open: 3_600 };

/** The league shown, kept in the address (#week), so a link opens the same board. */
function useLeague(): [LeagueKey, (k: LeagueKey) => void] {
  const read = (): LeagueKey => LEAGUES.find((l) => `#${l.key}` === window.location.hash)?.key ?? "sprint";
  const [key, setKey] = useState<LeagueKey>(read);
  useEffect(() => {
    const on = () => setKey(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const choose = (k: LeagueKey) => {
    window.history.replaceState(null, "", k === "sprint" ? window.location.pathname + window.location.search : `#${k}`);
    setKey(k);
  };
  return [key, choose];
}

/** An equal-weighted basket of the three coins: how much it moved between two times, in percent,
 *  from Coinbase's minute candles (and its live price for "now"). */
function useMarket(quotes: Quotes, times: number[], now: number) {
  const [opens, setOpens] = useState<Record<number, number[]>>({});
  const minutes = [...new Set(times.filter((t) => t > 0 && t <= now).map((t) => Math.floor(t / 60) * 60))].sort((a, b) => a - b).slice(-12);
  const key = minutes.join(",");
  // Minutes whose candle wasn't there yet are asked for again every 30 seconds.
  const retry = Math.floor(now / 30);
  useEffect(() => {
    let cancelled = false;
    for (const minute of minutes) {
      if (opens[minute]) continue;
      Promise.all(ASSETS.map((a) => priceAt(a, minute))).then((ps) => {
        if (!cancelled && ps.every((p) => p !== null)) setOpens((o) => (o[minute] ? o : { ...o, [minute]: ps as number[] }));
      });
    }
    return () => {
      cancelled = true;
    };
    // `key` stands for `minutes`; `opens` is read only to skip what is already known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  return (from: number, to: number | null): number | null => {
    const a = opens[Math.floor(from / 60) * 60];
    const b = to === null ? ASSETS.map((x) => quotes[x]?.price ?? 0) : opens[Math.floor(to / 60) * 60];
    if (!a || !b || b.some((x) => !x)) return null;
    return (ASSETS.reduce((s, _, i) => s + b[i] / a[i] - 1, 0) / ASSETS.length) * 100;
  };
}

type Msg = { ok: boolean; text: string; sig?: string };

/** Signs a transaction in the wallet and lands it on devnet. */
function useSender(arena: ArenaState) {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const send = async (tx: Transaction, done: string) => {
    if (!publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = latest.blockhash;
      let sig: string;
      let resend: ReturnType<typeof setInterval> | undefined;
      if (signTransaction) {
        // Sign in the wallet, then send to devnet ourselves, so it works whichever network the
        // wallet is showing; re-send every two seconds until it lands.
        const raw = (await signTransaction(tx)).serialize();
        sig = await connection.sendRawTransaction(raw, { maxRetries: 0 });
        resend = setInterval(() => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined), 2000);
      } else {
        sig = await sendTransaction(tx, connection);
      }
      try {
        const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      } finally {
        clearInterval(resend);
      }
      setMsg({ ok: true, text: done, sig });
      arena.refresh();
    } catch (e) {
      setMsg({ ok: false, text: explainError(e) });
    } finally {
      setBusy(false);
    }
  };

  const trade = (asset: Asset, side: number, value: number, why: string, done: string) => {
    if (!publicKey || !PROGRAM_ID || !arena.roundAddress) return;
    const reason = why.trim().slice(0, 200) || "No reason given";
    const tx = new Transaction().add(
      memoIx(reason),
      tradeIx({
        programId: PROGRAM_ID,
        round: arena.roundAddress,
        player: publicKey,
        asset,
        side,
        usd: value,
        reasonHash: reasonHash(reason),
        shardId: arena.round?.shardId,
      }),
    );
    send(tx, done);
  };

  return { send, trade, busy, msg, setMsg };
}
type Sender = ReturnType<typeof useSender>;

export function App() {
  const [leagueKey, setLeague] = useLeague();
  const { publicKey } = useWallet();
  const arena = useArena(leagueKey, publicKey ?? null);
  const { quotes, streaming } = useQuotes();
  const [asset, setAsset] = useState<Asset>("SOL");
  const [interval, setInterval_] = useState(DEFAULT_INTERVAL[leagueKey]);
  useEffect(() => setInterval_(DEFAULT_INTERVAL[leagueKey]), [leagueKey]);
  const sender = useSender(arena);
  useEffect(() => sender.setMsg(null), [leagueKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { league, now } = arena;
  const open = league.key === "open";
  const phase: Phase = now < arena.end ? "live" : "settling";
  const me = publicKey ? arena.rows.find((r) => r.entrant.player.equals(publicKey)) : undefined;
  const marketTo = phase === "settling" ? arena.end : null;
  const market = useMarket(
    quotes,
    [arena.start, ...arena.rows.map((r) => Math.max(arena.start, r.entrant.joinedTs)), ...(marketTo ? [marketTo] : [])],
    now,
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="page">
        <header className="bar">
          <a className="brand" href="./" aria-label="Turing Pit home">
            <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
              <rect width="32" height="32" rx="7" fill="var(--floor-2)" />
              <path d="M8 23l8-14 8 14" stroke="var(--human)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="16" cy="19" r="2.2" fill="var(--machine)" />
            </svg>
            <span>Turing Pit</span>
          </a>
          <WalletMultiButton />
        </header>

        <LeagueTabs current={leagueKey} now={now} onPick={setLeague} />

        <section className="hero">
          <GameClock arena={arena} phase={phase} />
          <div className="pitch">
            <h1>Can you out-trade the machines?</h1>
            <p>
              Three Claude agents trade SOL, BTC and ETH, long or short, against anyone with a wallet. Pick a league from fifteen
              minutes to a month, or the Open league that never ends. Everyone starts with $10,000 of paper cash, and a Solana
              program keeps the books.
            </p>
            <Scoreboard arena={arena} />
          </div>
        </section>

        {!open && arena.lastRound && <LastRoundNote last={arena.lastRound} league={league} />}

        <Prices arena={arena} />

        {arena.error && <p className="banner">{arena.error}</p>}

        <main className="terminal">
          <section className="panel chart-panel" aria-label="Chart">
            <div className="chart-head">
              <div className="tickers" role="radiogroup" aria-label="Coin">
                {ASSETS.map((a) => {
                  const q = quotes[a];
                  const day = q?.open24h ? (q.price / q.open24h - 1) * 100 : null;
                  return (
                    <button key={a} role="radio" aria-checked={a === asset} className={`ticker ${a === asset ? "on" : ""}`} onClick={() => setAsset(a)}>
                      <span className="sym">{a}</span>
                      <span className="num">{q ? usd(q.price, priceDp(a, q.price)) : "…"}</span>
                      {day !== null && <span className={`chg ${day >= 0 ? "up" : "down"}`}>{pct(day)}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="intervals" role="radiogroup" aria-label="Candle interval">
                {INTERVALS.map((i) => (
                  <button key={i.seconds} role="radio" aria-checked={i.seconds === interval} className={i.seconds === interval ? "on" : ""} onClick={() => setInterval_(i.seconds)}>
                    {i.label}
                  </button>
                ))}
              </div>
            </div>
            <TradeChart arena={arena} asset={asset} seconds={interval} me={me} />
            <p className="chart-note">
              <span className={`dot ${streaming ? "live" : ""}`} aria-hidden /> {streaming ? "Live" : "Delayed"} candles from Coinbase.{" "}
              <span className="key me">▲▼ you</span> <span className="key agent">▲▼ agents</span> <span className="key human">▲▼ other players</span>, this round.
              Trades fill at the Pyth price on chain, the dotted line.
            </p>
          </section>

          <Seat arena={arena} phase={phase} asset={asset} onAsset={setAsset} sender={sender} me={me} />

          <Positions arena={arena} me={me} phase={phase} sender={sender} />
        </main>

        <main className="grid">
          <div className="stack">
            <Leaderboard arena={arena} market={market} marketTo={marketTo} />
            <History rounds={arena.history} league={league} />
          </div>
          <Thoughts arena={arena} />
        </main>

        <section className="agents" aria-labelledby="agents-title">
          <div className="panel-head">
            <h2 id="agents-title">The agents</h2>
            <span className="hint">Each one is Claude with its own wallet and its own style, in every league</span>
          </div>
          <ul>
            {PERSONAS.map((p) => (
              <li key={p.label}>
                <span className="badge" aria-hidden>
                  {badge(p.label, true)}
                </span>
                <div>
                  <h3>{p.label}</h3>
                  <p>{p.style}</p>
                  <details>
                    <summary>Read the full prompt</summary>
                    <p className="prompt">{agentSystemPrompt(p, league)}</p>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <footer className="foot">
          <h2>How a round works</h2>
          <ol className="steps">
            <li>Pick a league: rounds of fifteen minutes, an hour, a day, a week or a month, or the Open league with no end. Everyone joins with $10,000 of paper cash.</li>
            <li>Go long or short SOL, BTC and ETH. Trades fill on chain at the latest Pyth price, with a 0.1% fee, and no position may be more than half your equity.</li>
            <li>Hold as long as you like. When trading stops, open positions are marked at the closing price. Only players who traded are ranked, and the program records the winner.</li>
            <li>Each agent writes its reason into the trade. The program stores the reason's hash, so nobody can edit it later.</li>
          </ol>
          <p className="meta">
            Runs on Solana devnet.{" "}
            {PROGRAM_ID ? (
              <>
                <a href={explorerAddress(PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
                  See the program on Explorer
                </a>
                .
              </>
            ) : (
              "The program address appears here once it's deployed."
            )}{" "}
            Open source on{" "}
            <a href="https://github.com/imDev2023/turing-pit" target="_blank" rel="noreferrer">
              GitHub
            </a>
            , with the{" "}
            <a href="https://github.com/imDev2023/turing-pit#roadmap" target="_blank" rel="noreferrer">
              roadmap
            </a>
            . Charts by{" "}
            <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">
              TradingView Lightweight Charts
            </a>
            . Built for the MLH x Solana hackathon.
          </p>
        </footer>
      </div>
    </MotionConfig>
  );
}

function LeagueTabs({ current, now, onPick }: { current: LeagueKey; now: number; onPick: (k: LeagueKey) => void }) {
  return (
    <nav className="leagues" aria-label="Leagues">
      {LEAGUES.map((l) => {
        const { end, next } = roundTimes(roundIdAt(now, l.key));
        const left = l.key === "open" ? "no end" : now < end ? brief(end - now) : `next ${brief(next - now)}`;
        return (
          <button key={l.key} className={l.key === current ? "on" : ""} aria-current={l.key === current ? "page" : undefined} onClick={() => onPick(l.key)}>
            <span className="name">{l.label}</span>
            <span className="left">{left}</span>
          </button>
        );
      })}
    </nav>
  );
}

function GameClock({ arena, phase }: { arena: ArenaState; phase: Phase }) {
  const { league, now } = arena;
  const traders = arena.rows.length;
  const field = `${traders} ${traders === 1 ? "player" : "players"}`;
  if (league.key === "open") {
    return (
      <div className="clock">
        <p className="clock-label">Open league · no time limit</p>
        <p className="clock-time long" aria-live="off">
          {countdown(now - arena.start)}
        </p>
        <p className="clock-sub">
          {arena.deployed === false
            ? "The arena opens once its program is on devnet."
            : arena.ready && !arena.round
              ? "Waiting for the house to open the Open league."
              : `Running since ${stamp(arena.start, league)} with ${field}. Join any time; the leaderboard is the standings.`}
        </p>
      </div>
    );
  }
  const exists = !arena.ready || !!arena.round;
  const left = !exists && now < arena.start ? arena.start - now : phase === "live" ? arena.end - now : arena.next - now;
  const text = countdown(left);
  return (
    <div className={`clock ${exists && phase === "live" && left <= 60 ? "urgent" : ""}`}>
      <p className="clock-label">
        {league.label} round · {!exists ? "next round in" : phase === "live" ? "trading closes in" : "settling, next round in"}
      </p>
      <p className={`clock-time ${text.length > 6 ? "long" : ""}`} aria-live="off">
        {text}
      </p>
      <p className="clock-sub">
        {arena.deployed === false
          ? "The arena opens once its program is on devnet."
          : arena.ready && !arena.round
            ? "Waiting for the house to open this round."
            : phase === "live"
              ? `Opened ${stamp(arena.start, league)} with ${field}. Trading stops at ${stamp(arena.end, league)}.`
              : "Final equity is being marked at the closing price."}
      </p>
    </div>
  );
}

function Scoreboard({ arena }: { arena: ArenaState }) {
  const { league } = arena;
  if (league.key === "open") {
    const traders = arena.rows.filter((r) => r.entrant.trades > 0);
    const best = (kind: number) => traders.filter((r) => r.entrant.kind === kind).reduce((m, r) => Math.max(m, r.equity), 0);
    const ai = best(KIND_AGENT);
    const human = best(KIND_HUMAN);
    const share = ai + human > 0 ? (ai / (ai + human)) * 100 : 50;
    return (
      <div className="score" aria-label="Best machine and best human in the Open league">
        <div className="score-side machine">
          <b>{ai ? kilo(ai) : "–"}</b>
          <span>best machine</span>
        </div>
        <div className="score-bar" aria-hidden>
          <span style={{ width: `${share}%` }} />
        </div>
        <div className="score-side human">
          <b>{human ? kilo(human) : "–"}</b>
          <span>best human</span>
        </div>
        <p className="score-note">{human ? "The best equity on each side, live." : "No human has traded in the Open league yet. Be the first."}</p>
      </div>
    );
  }
  const { ai, human, rounds } = arena.tally;
  const share = rounds ? (ai / rounds) * 100 : 50;
  return (
    <div className="score" aria-label={`Round wins in the last 24 ${league.noun} rounds: machines ${ai}, humans ${human}`}>
      <div className="score-side machine">
        <b>{ai}</b>
        <span>machine wins</span>
      </div>
      <div className="score-bar" aria-hidden>
        <span style={{ width: `${share}%` }} />
      </div>
      <div className="score-side human">
        <b>{human}</b>
        <span>human wins</span>
      </div>
      <p className="score-note">
        {rounds
          ? `Wins in the last 24 ${league.noun} rounds where humans and agents both played.`
          : `No human has played the agents in a finished ${league.noun} round yet. Be the first.`}
      </p>
    </div>
  );
}

function LastRoundNote({ last, league }: { last: LastRound; league: League }) {
  const when = `${stamp(last.start, league)} to ${utc(last.end)}`;
  const winner = last.winnerLabel
    ? `${last.winnerLabel} won with ${pct(last.winnerPnlPct ?? 0)}${last.traders > 1 ? ` against ${last.traders - 1} other ${last.traders === 2 ? "trader" : "traders"}` : ""}.`
    : "Nobody traded, so nobody won.";
  let text: string;
  let tone = "";
  if (!last.finalized) text = `The last ${league.noun} round (${when}) is settling at the closing price.`;
  else if (last.mine?.traded && last.mine.rank === 1) {
    text = `You won the last ${league.noun} round (${when}) with ${usd(last.mine.equity)}, ${pct(last.mine.pnlPct)}.`;
    tone = "win";
  } else if (last.mine?.traded) {
    text = `Last ${league.noun} round (${when}): you finished ${ordinal(last.mine.rank ?? 0)} of ${last.traders} with ${usd(last.mine.equity)}, ${pct(last.mine.pnlPct)}. ${winner}`;
    tone = "mine";
  } else if (last.mine) text = `You joined the last ${league.noun} round but didn't trade, so you weren't ranked. ${winner}`;
  else text = `Last ${league.noun} round (${when}): ${winner}`;
  return (
    <p className={`last-round ${tone}`} role="status">
      {text}
    </p>
  );
}

function History({ rounds, league }: { rounds: PastRound[]; league: League }) {
  if (!rounds.length) return null;
  return (
    <section className="history">
      <div className="panel-head">
        <h2>Recent rounds</h2>
        <span className="hint">{league.label} winners, as recorded by the program</span>
      </div>
      <ol>
        {rounds.map((r) => {
          const ai = r.winnerKind === KIND_AGENT;
          const pnl = ((r.winnerEquity - r.startCash) / r.startCash) * 100;
          const humans = r.entrants - r.agents;
          return (
            <li key={r.roundId} className={!r.won ? "is-none" : ai ? "is-ai" : "is-human"}>
              <span className="when">{stamp(r.start, league)}</span>
              <span className="badge small" aria-hidden>
                {r.won ? badge(r.winnerLabel, ai) : "–"}
              </span>
              <span className="who">
                {r.won ? (
                  <>
                    {r.winnerLabel} won with {usd(r.winnerEquity)} <span className={pnl >= 0 ? "up" : "down"}>{pct(pnl)}</span>
                  </>
                ) : (
                  "Nobody traded, so nobody won"
                )}
              </span>
              <span className="field-size">
                {r.agents} {r.agents === 1 ? "agent" : "agents"}, {humans} {humans === 1 ? "human" : "humans"}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const span = (s: number) => (s < 120 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

function Prices({ arena }: { arena: ArenaState }) {
  // A trade fills only at a price younger than the round's limit.
  const sponsored = arena.priceShard !== SHARD_ID;
  const limit = arena.round?.maxPriceAge ?? (sponsored ? PRICE_AGE_SPONSORED : PRICE_AGE_KEEPER);
  return (
    <section className="prices" aria-label="Fill prices on chain">
      <span className="lead">Fill price</span>
      {ASSETS.map((a, i) => {
        const p = arena.prices[i];
        const age = p ? Math.max(0, arena.now - p.publishTime) : null;
        const stale = age !== null && age > limit;
        return (
          <div key={a} className="price">
            <span className="sym">{a}</span>
            <span className="num">{p ? usd(p.price, priceDp(a, p.price)) : "No price yet"}</span>
            <span className={`age ${stale ? "stale" : ""}`}>{age === null ? "" : stale ? `Stale, ${span(age)} old` : `${span(age)} ago`}</span>
          </div>
        );
      })}
      <span className="src">
        {sponsored ? "Pyth's own devnet prices, updated about every 5 minutes" : "Pyth prices, posted to devnet by the house every 10 seconds"}
      </span>
    </section>
  );
}

function TradeChart({ arena, asset, seconds, me }: { arena: ArenaState; asset: Asset; seconds: number; me: Row | undefined }) {
  const kinds = useMemo(() => new Map(arena.rows.map((r) => [r.entrant.player.toBase58(), r])), [arena.rows]);
  const myKey = me?.entrant.player.toBase58();
  const marks: ChartMark[] = useMemo(() => {
    // A close buys when it closes a short: follow each player's coins through the fills.
    const held = new Map<string, number>();
    return arena.fills.map((f) => {
      const key = f.player.toBase58();
      const slot = `${key}:${f.asset}`;
      const before = held.get(slot) ?? 0;
      const delta = f.side === SIDE_BUY ? f.qty : f.side === SIDE_SELL ? -f.qty : -before;
      held.set(slot, before + delta);
      const row = kinds.get(key);
      const who = key === myKey ? "me" : row?.entrant.kind === KIND_AGENT ? "agent" : "human";
      const name = who === "me" ? "YOU" : badge(row?.entrant.label ?? key.slice(0, 3), who === "agent");
      return { asset: f.asset, ts: f.ts, buy: delta > 0, who, text: `${name} ${kilo(f.usd)}` };
    });
  }, [arena.fills, kinds, myKey]);
  const i = ASSETS.indexOf(asset);
  const fill = arena.prices[i]?.price ?? 0;
  const book = useBook(arena, me);
  const mine = book?.[i];
  const lines: ChartLine[] = [{ price: fill, title: "Pyth fill", who: "pyth" }];
  if (mine && mine.qty !== 0 && mine.entry > 0) lines.push({ price: mine.entry, title: `Your ${mine.qty > 0 ? "long" : "short"}`, who: "me" });
  return <Chart asset={asset} seconds={seconds} marks={marks} lines={lines} />;
}

/** The player's positions with entries, replayed from their fills, or null while they load or if
 *  the replay doesn't match the coins the program holds for them. */
function useBook(arena: ArenaState, me: Row | undefined): Position[] | null {
  return useMemo(() => {
    if (!me || !arena.myFills) return null;
    const book = replayFills(arena.myFills);
    const matches = book.every((p, i) => Math.abs(p.qty - me.entrant.qty[i]) < 1e-8);
    return matches ? book : null;
  }, [arena.myFills, me]);
}

function Positions({ arena, me, phase, sender }: { arena: ArenaState; me: Row | undefined; phase: Phase; sender: Sender }) {
  const book = useBook(arena, me);
  if (!me) {
    return (
      <section className="panel positions">
        <div className="panel-head">
          <h2>Positions</h2>
          <span className="hint">{arena.league.label} round</span>
        </div>
        <p className="empty">Join this round to trade. Your positions, entry prices and profit show here.</p>
      </section>
    );
  }
  const live = phase === "live";
  const open = ASSETS.map((a, i) => ({ a, i, qty: me.entrant.qty[i] })).filter((x) => Math.abs(x.qty) > 1e-9);
  const realized = book ? book.reduce((s, p) => s + p.realized, 0) : null;
  const fees = book ? book.reduce((s, p) => s + p.fees, 0) : null;
  return (
    <section className="panel positions">
      <div className="panel-head">
        <h2>Positions</h2>
        <span className="hint">
          {arena.league.label} round · marked at the Pyth price · {me.entrant.trades} {me.entrant.trades === 1 ? "trade" : "trades"}
        </span>
      </div>
      {open.length === 0 ? (
        <p className="empty">
          {me.entrant.trades === 0
            ? "No positions yet. Only players who trade are ranked, so make your first trade to compete."
            : "You're flat: all cash. Your profit so far is locked in."}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Side</th>
                <th className="num">Size</th>
                <th className="num">Entry</th>
                <th className="num">Mark</th>
                <th className="num">Value</th>
                <th className="num">Open P&amp;L</th>
                <th aria-label="Close" />
              </tr>
            </thead>
            <tbody>
              {open.map(({ a, i, qty }) => {
                const mark = arena.prices[i]?.price ?? 0;
                const entry = book?.[i].entry ?? 0;
                const pnl = entry ? qty * (mark - entry) : null;
                const pnlPct = entry ? ((mark / entry - 1) * 100 * Math.sign(qty)) : null;
                return (
                  <tr key={a}>
                    <td className="coin">{a}</td>
                    <td className={qty > 0 ? "up" : "down"}>{qty > 0 ? "Long" : "Short"}</td>
                    <td className="num">
                      {Math.abs(qty).toFixed(coinDp[a])} {a}
                    </td>
                    <td className="num">{entry ? usd(entry, priceDp(a, entry)) : "…"}</td>
                    <td className="num">{mark ? usd(mark, priceDp(a, mark)) : "…"}</td>
                    <td className="num">{usd(Math.abs(qty * mark))}</td>
                    <td className={`num ${pnl === null ? "" : pnl >= 0 ? "up" : "down"}`}>
                      {pnl === null ? "…" : `${signedUsd(pnl)} (${pct(pnlPct ?? 0)})`}
                    </td>
                    <td>
                      <button
                        className="close-btn"
                        disabled={sender.busy || !live}
                        onClick={() => sender.trade(a, SIDE_CLOSE, 0, `Closing my ${a} ${qty > 0 ? "long" : "short"}`, `Closed your ${a} position`)}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <dl className="pos-sum">
        <div>
          <dt>Cash</dt>
          <dd>{usd(me.entrant.cash)}</dd>
        </div>
        <div>
          <dt>Taken profit</dt>
          <dd className={realized === null ? "" : realized >= 0 ? "up" : "down"}>{realized === null ? "…" : signedUsd(realized)}</dd>
        </div>
        <div>
          <dt>Fees paid</dt>
          <dd>{fees === null ? "…" : usd(fees)}</dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd>
            {usd(me.equity)} <span className={me.pnlPct >= 0 ? "up" : "down"}>{pct(me.pnlPct)}</span>
          </dd>
        </div>
      </dl>
      <p className="fine">
        You don't have to close anything before the bell: when trading stops, every open position is marked at the closing Pyth
        price, and the highest equity among players who traded wins.
      </p>
    </section>
  );
}

function Leaderboard({ arena, market, marketTo }: { arena: ArenaState; market: (from: number, to: number | null) => number | null; marketTo: number | null }) {
  const { publicKey } = useWallet();
  const prices = arena.prices.map((p) => p?.price ?? 0);
  const move = arena.round ? market(arena.start, marketTo) : null;
  let rank = 0;
  return (
    <section className="panel board-panel">
      <div className="panel-head">
        <h2>Leaderboard</h2>
        <span className="hint">
          {arena.league.label} round · equity at the live price
          {move !== null && (
            <>
              {" "}
              · market <span className={move >= 0 ? "up" : "down"}>{pct(move)}</span>
            </>
          )}
        </span>
      </div>
      {!arena.ready ? (
        <p className="empty">Loading the round…</p>
      ) : arena.deployed === false ? (
        <p className="empty">The arena's Solana program isn't on devnet yet. Rounds start as soon as it is deployed.</p>
      ) : !arena.round ? (
        <p className="empty">This round hasn't opened yet. The house opens each league's rounds on schedule.</p>
      ) : arena.rows.length === 0 ? (
        <p className="empty">No one has joined this round yet. Connect a wallet and take the first seat.</p>
      ) : (
        <ol className="board">
          <AnimatePresence initial={false}>
            {arena.rows.map((r) => {
              const traded = r.entrant.trades > 0;
              if (traded) rank++;
              const base = market(Math.max(arena.start, r.entrant.joinedTs), marketTo);
              return (
                <BoardRow
                  key={r.address}
                  row={r}
                  rank={traded ? rank : null}
                  prices={prices}
                  me={!!publicKey && r.entrant.player.equals(publicKey)}
                  alpha={base === null ? null : r.pnlPct - base}
                />
              );
            })}
          </AnimatePresence>
        </ol>
      )}
      <p className="board-note">
        Only players who trade are ranked. "vs mkt" is a player's return minus an equal mix of SOL, BTC and ETH held since they
        joined.
      </p>
    </section>
  );
}

function BoardRow({ row, rank, prices, me, alpha }: { row: Row; rank: number | null; prices: number[]; me: boolean; alpha: number | null }) {
  const ai = row.entrant.kind === KIND_AGENT;
  const name = row.entrant.label || row.entrant.player.toBase58().slice(0, 6);
  return (
    <motion.li
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ layout: { type: "spring", stiffness: 380, damping: 34 } }}
      className={`row ${ai ? "is-ai" : "is-human"} ${me ? "is-me" : ""} ${rank === null ? "unranked" : ""}`}
    >
      <span className="rank">{rank ?? "–"}</span>
      <span className="badge" aria-hidden>
        {badge(name, ai)}
      </span>
      <span className="who">
        <span className="name">{name}</span>
        <span className="kind">{rank === null ? "Hasn't traded yet" : ai ? "Claude agent" : me ? "You" : "Human"}</span>
      </span>
      <span className="holds">
        {ASSETS.map((a, i) => {
          const v = row.entrant.qty[i] * prices[i];
          if (Math.abs(v) < 0.5) return null;
          return (
            <span key={a} className={`chip ${v < 0 ? "short" : ""}`}>
              {a} {v < 0 ? "short " : ""}
              {usd(Math.abs(v), 0)}
            </span>
          );
        })}
        {row.entrant.cash >= 1 && <span className="chip cash">Cash {usd(row.entrant.cash, 0)}</span>}
      </span>
      <span className="eq">{usd(row.equity)}</span>
      <span className="pnl">
        <span className={row.pnlPct >= 0 ? "up" : "down"}>{pct(row.pnlPct)}</span>
        {alpha !== null && rank !== null && <span className={`alpha ${alpha >= 0 ? "up" : "down"}`}>{pts(alpha)} vs mkt</span>}
      </span>
    </motion.li>
  );
}

function Thoughts({ arena }: { arena: ArenaState }) {
  const [onlyThis, setOnlyThis] = useState(false);
  const shown = onlyThis ? arena.thoughts.filter((t) => arena.leagueOfRound(t.round)?.key === arena.league.key) : arena.thoughts;
  return (
    <section className="panel thoughts">
      <div className="panel-head">
        <h2>What the agents are thinking</h2>
        <span className="hint">Read straight from the chain</span>
      </div>
      <div className="feed-filter" role="radiogroup" aria-label="Which leagues">
        <button role="radio" aria-checked={!onlyThis} className={!onlyThis ? "on" : ""} onClick={() => setOnlyThis(false)}>
          All leagues
        </button>
        <button role="radio" aria-checked={onlyThis} className={onlyThis ? "on" : ""} onClick={() => setOnlyThis(true)}>
          {arena.league.label} only
        </button>
      </div>
      {shown.length === 0 && <p className="empty">Agents attach a reason to every trade. Their next one appears here.</p>}
      <div className="feed">
        <AnimatePresence initial={false}>
          {shown.map((t) => (
            <ThoughtCard key={t.sig} t={t} now={arena.now} league={arena.leagueOfRound(t.round)} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function ThoughtCard({ t, now, league }: { t: Thought; now: number; league: League | null }) {
  const at = t.price ? ` at ${usd(t.price, priceDp(t.trade.asset, t.price))}` : "";
  return (
    <motion.article layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="thought">
      <header>
        <span className="badge small" aria-hidden>
          {badge(t.label, true)}
        </span>
        <span className="who">{t.label}</span>
        {league && <span className="tag">{league.label}</span>}
        <span className="when">{ago(t.ts, now)}</span>
      </header>
      <p className={`act ${t.trade.side === SIDE_BUY ? "up" : t.trade.side === SIDE_SELL ? "down" : ""}`}>
        {t.trade.side === SIDE_CLOSE
          ? `Closed the ${t.trade.asset} position${at}`
          : `${t.trade.side === SIDE_BUY ? "Bought" : "Sold"} ${usd(t.trade.usd, 0)} of ${t.trade.asset}${at}`}
      </p>
      <blockquote>{t.reason}</blockquote>
      <footer>
        <span className={t.verified ? "ok" : "bad"} title={`SHA-256 stored by the program: ${t.hash}`}>
          {t.verified ? "Matches the hash stored on chain" : "Doesn't match the hash on chain"}{" "}
          <code>
            {t.hash.slice(0, 6)}…{t.hash.slice(-4)}
          </code>
        </span>
        <a href={explorerTx(t.sig)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      </footer>
    </motion.article>
  );
}

function Seat({
  arena,
  phase,
  asset,
  onAsset,
  sender,
  me,
}: {
  arena: ArenaState;
  phase: Phase;
  asset: Asset;
  onAsset: (a: Asset) => void;
  sender: Sender;
  me: Row | undefined;
}) {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("1000");
  const [why, setWhy] = useState("");
  const [sol, setSol] = useState<number | null>(null);
  const { busy, msg } = sender;
  const live = phase === "live";

  useEffect(() => {
    if (!publicKey) return setSol(null);
    let alive = true;
    connection
      .getBalance(publicKey)
      .then((b) => alive && setSol(b / LAMPORTS_PER_SOL))
      .catch(() => alive && setSol(null));
    return () => {
      alive = false;
    };
  }, [connection, publicKey, msg]);

  const join = () => {
    if (!publicKey || !PROGRAM_ID || !arena.roundAddress) return;
    const label = (name.trim() || publicKey.toBase58().slice(0, 6)).slice(0, 24);
    const tx = new Transaction().add(
      joinRoundIx({ programId: PROGRAM_ID, round: arena.roundAddress, player: publicKey, kind: KIND_HUMAN, label }),
    );
    sender.send(tx, `Joined the ${arena.league.label} round. Your $10,000 is ready to trade.`);
  };

  const i = ASSETS.indexOf(asset);
  const price = arena.prices[i]?.price ?? 0;
  const held = me ? me.entrant.qty[i] * price : 0;
  const cap = me ? (me.equity * MAX_ASSET_BPS) / 10_000 : 0;
  // Buying covers a short before it adds a long; selling cuts a long before it adds a short.
  const buyRoom = me ? Math.max(0, Math.min(me.entrant.cash, cap - held)) : 0;
  const sellRoom = me ? Math.max(0, cap + held) : 0;
  const traders = arena.rows.filter((r) => r.entrant.trades > 0);
  const myRank = me && me.entrant.trades > 0 ? traders.indexOf(me) + 1 : null;

  const trade = (side: number) => {
    const value = Number(amount);
    if (!(value >= 10)) return sender.setMsg({ ok: false, text: "Trades start at $10. Enter a larger amount." });
    const done =
      side === SIDE_BUY
        ? held < -0.5
          ? `Bought ${usd(value, 0)} of ${asset}${value > -held + 0.5 ? `: your short is covered and you're long` : ", covering part of your short"}`
          : `Bought ${usd(value, 0)} of ${asset}`
        : held - value < -0.5
          ? `Sold ${usd(value, 0)} of ${asset}: you're now short ${usd(value - Math.max(held, 0), 0)}`
          : `Sold ${usd(value, 0)} of ${asset}`;
    sender.trade(asset, side, value, why, done);
    setWhy("");
  };

  return (
    <section className="panel seat">
      <div className="panel-head">
        <h2>Order ticket</h2>
        <span className="hint">{arena.league.label} round · market order at the Pyth price</span>
      </div>

      {!connected && (
        <div className="seat-cta">
          <p>Connect a wallet set to devnet (Phantom, Solflare or Backpack) to take a seat. Each trade costs a fraction of a cent in devnet SOL, which is free.</p>
          <WalletMultiButton />
        </div>
      )}

      {connected && sol !== null && sol < 0.01 && (
        <p className="warn">
          This wallet has {sol.toFixed(3)} devnet SOL, not enough for fees. Get free devnet SOL at{" "}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            faucet.solana.com
          </a>
          , then come back.
        </p>
      )}

      {connected && !me && arena.round && live && (
        <div className="join">
          <label className="field">
            <span>Name on the board</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Farhan" maxLength={24} />
          </label>
          <button className="primary" disabled={busy} onClick={join}>
            {busy ? "Joining…" : `Join the ${arena.league.label} round`}
          </button>
        </div>
      )}
      {connected && !me && live && arena.ready && !arena.round && (
        <p className="empty">{arena.deployed === false ? "Seats open once the arena's program is on devnet." : "Waiting for the house to open this round."}</p>
      )}
      {connected && !me && !live && <p className="empty">This round has closed. Join the next one when the clock restarts.</p>}

      {me && (
        <>
          <dl className="mine">
            <div>
              <dt>Equity</dt>
              <dd>{usd(me.equity, 0)}</dd>
            </div>
            <div>
              <dt>Profit</dt>
              <dd className={me.pnlPct >= 0 ? "up" : "down"}>{pct(me.pnlPct)}</dd>
            </div>
            <div>
              <dt>Rank</dt>
              <dd>{myRank ? `${myRank}/${traders.length}` : "–"}</dd>
            </div>
          </dl>

          <div className="ticket">
            <div className="assets" role="radiogroup" aria-label="Coin">
              {ASSETS.map((a) => (
                <button key={a} role="radio" aria-checked={a === asset} className={a === asset ? "on" : ""} onClick={() => onAsset(a)}>
                  {a}
                </button>
              ))}
            </div>
            <label className="field amount">
              <span>Amount in dollars</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
            </label>
            <div className="quick">
              {[0.25, 0.5, 1].map((f) => (
                <button key={f} onClick={() => setAmount(String(Math.floor(buyRoom * f)))}>
                  {f === 1 ? "Max buy" : `${f * 100}% buy room`}
                </button>
              ))}
              <button onClick={() => setAmount(String(Math.floor(sellRoom)))}>Max sell</button>
            </div>
            <label className="field">
              <span>Why? Your reason goes on chain with the trade (optional)</span>
              <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. SOL is lagging BTC, it'll catch up" maxLength={200} />
            </label>
            <div className="go">
              <button className="buy" disabled={busy || !live} onClick={() => trade(SIDE_BUY)}>
                {held < -0.5 ? `Buy / cover ${asset}` : `Buy ${asset}`}
              </button>
              <button className="sell" disabled={busy || !live} onClick={() => trade(SIDE_SELL)}>
                {held > 0.5 ? `Sell ${asset}` : `Short ${asset}`}
              </button>
            </div>
            <p className="fine">
              {Math.abs(held) < 0.5 ? `No ${asset} position.` : held > 0 ? `Long ${usd(held)} of ${asset}.` : `Short ${usd(-held)} of ${asset}.`} You
              can buy up to {usd(buyRoom, 0)} and sell up to {usd(sellRoom, 0)}: no position, long or short, may pass half your
              equity ({usd(cap, 0)}). Selling more than you hold opens a short. Every trade pays a 0.1% fee.
            </p>
          </div>
        </>
      )}

      {msg && (
        <p className={msg.ok ? "note ok" : "note bad"} role="status">
          {msg.text}{" "}
          {msg.sig && (
            <a href={explorerTx(msg.sig)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </p>
      )}
    </section>
  );
}
