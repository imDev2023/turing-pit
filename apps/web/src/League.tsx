import { useEffect, useMemo, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  ASSETS,
  KIND_AGENT,
  KIND_HUMAN,
  PRICE_AGE_KEEPER,
  PRICE_AGE_SPONSORED,
  SHARD_ID,
  SIDE_BUY,
  SIDE_CLOSE,
  SIDE_SELL,
  joinRoundIx,
  memoIx,
  reasonHash,
  replayFills,
  tradeIx,
  type Asset,
  type LeagueKey,
  type Position,
} from "@turing-pit/sdk";
import { Chart, type ChartLine, type ChartMark } from "./Chart";
import { PROGRAM_ID, explorerTx } from "./config";
import { ago, badge, coins, countdown, kilo, ordinal, pct, price, saveName, savedName, signedUsd, stamp, usd } from "./format";
import { INTERVALS, priceAt, type Quote } from "./market";
import type { Sender } from "./send";
import type { ArenaState, LastRound, Row, Thought } from "./useArena";

type Quotes = Partial<Record<Asset, Quote>>;
const DEFAULT_INTERVAL: Record<LeagueKey, number> = { sprint: 60, hour: 60, day: 900, week: 3_600, month: 21_600, open: 3_600, duel: 60 };

/** An equal mix of the three coins: how much it moved between two times, in percent, from
 *  Coinbase's minute candles (and its live price for "now"). */
function useMarket(quotes: Quotes, times: number[], now: number) {
  const [opens, setOpens] = useState<Record<number, number[]>>({});
  const minutes = [...new Set(times.filter((t) => t > 0 && t <= now).map((t) => Math.floor(t / 60) * 60))].sort((a, b) => a - b).slice(-12);
  const key = minutes.join(",");
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
    // `key` stands for `minutes`; a minute not there yet is asked for again every 30 seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  return (from: number, to: number | null): number | null => {
    const a = opens[Math.floor(from / 60) * 60];
    const b = to === null ? ASSETS.map((x) => quotes[x]?.price ?? 0) : opens[Math.floor(to / 60) * 60];
    if (!a || !b || b.some((x) => !x)) return null;
    return (ASSETS.reduce((s, _, i) => s + b[i] / a[i] - 1, 0) / ASSETS.length) * 100;
  };
}

/** The player's positions with entries, replayed from their fills; null until they load or if
 *  the replay doesn't match the coins the program holds. */
function useBook(arena: ArenaState, me: Row | undefined): Position[] | null {
  return useMemo(() => {
    if (!me || !arena.myFills) return null;
    const book = replayFills(arena.myFills);
    return book.every((p, i) => Math.abs(p.qty - me.entrant.qty[i]) < 1e-8) ? book : null;
  }, [arena.myFills, me]);
}

export function LeagueView({ arena, quotes, sender }: { arena: ArenaState; quotes: Quotes; sender: Sender }) {
  const { league, now } = arena;
  const [asset, setAsset] = useState<Asset>("SOL");
  const [interval, setInterval_] = useState(DEFAULT_INTERVAL[league.key]);
  useEffect(() => setInterval_(DEFAULT_INTERVAL[league.key]), [league.key]);
  const me = sender.player ? arena.rows.find((r) => r.entrant.player.equals(sender.player!)) : undefined;
  const live = now < arena.end;
  const marketTo = live ? null : arena.end;
  const market = useMarket(quotes, [arena.start, ...arena.rows.map((r) => Math.max(arena.start, r.entrant.joinedTs)), ...(marketTo ? [marketTo] : [])], now);
  const book = useBook(arena, me);

  return (
    <>
      <Strip arena={arena} live={live} />
      {arena.error && <p className="alert">{arena.error}</p>}
      <div className="terminal">
        <section className="card chart-card" aria-label="Chart">
          <header>
            <div className="seg" role="radiogroup" aria-label="Coin">
              {ASSETS.map((a) => {
                const q = quotes[a];
                const day = q?.open24h ? (q.price / q.open24h - 1) * 100 : null;
                return (
                  <button key={a} role="radio" aria-checked={a === asset} className={a === asset ? "on" : ""} onClick={() => setAsset(a)}>
                    {a} <span className="n">{q ? price(a, q.price) : "–"}</span>
                    {day !== null && <span className={`n ${day >= 0 ? "up" : "down"}`}>{pct(day)}</span>}
                  </button>
                );
              })}
            </div>
            <div className="seg small" role="radiogroup" aria-label="Candle interval">
              {INTERVALS.map((i) => (
                <button key={i.seconds} role="radio" aria-checked={i.seconds === interval} className={i.seconds === interval ? "on" : ""} onClick={() => setInterval_(i.seconds)}>
                  {i.label}
                </button>
              ))}
            </div>
          </header>
          <TradeChart arena={arena} asset={asset} seconds={interval} me={me} book={book} />
        </section>
        <Ticket arena={arena} asset={asset} onAsset={setAsset} sender={sender} me={me} book={book} live={live} />
      </div>
      <div className="lower">
        <div className="stack">
          <Board arena={arena} market={market} marketTo={marketTo} />
          <History arena={arena} />
        </div>
        <Reasons arena={arena} />
      </div>
    </>
  );
}

function Strip({ arena, live }: { arena: ArenaState; live: boolean }) {
  const { league, now } = arena;
  const open = league.key === "open";
  const exists = !arena.ready || !!arena.round;
  const sponsored = arena.priceShard !== SHARD_ID;
  const limit = arena.round?.maxPriceAge ?? (sponsored ? PRICE_AGE_SPONSORED : PRICE_AGE_KEEPER);
  let clock: string;
  let label: string;
  if (open) {
    clock = countdown(now - arena.start);
    label = "running";
  } else if (!exists) {
    clock = countdown(Math.max(0, arena.start - now));
    label = "to start";
  } else if (live) {
    clock = countdown(arena.end - now);
    label = "left";
  } else {
    clock = countdown(arena.next - now);
    label = "to next round";
  }
  return (
    <section className="strip" aria-label="Round">
      <div className={`clock ${live && !open && exists && arena.end - now <= 60 ? "urgent" : ""}`}>
        <span className="n">{clock}</span> <span className="unit">{label}</span>
      </div>
      <div className="facts">
        {arena.deployed === false ? (
          <span>Program not deployed</span>
        ) : arena.ready && !arena.round ? (
          <span>Opening soon</span>
        ) : (
          <>
            <span>{arena.rows.length} players</span>
            <span>{live ? `Since ${stamp(arena.start, league)}` : "Settling"}</span>
          </>
        )}
      </div>
      {!open && arena.lastRound && <LastResult last={arena.lastRound} />}
      <div className="fills" aria-label="Pyth fill prices">
        {ASSETS.map((a, i) => {
          const p = arena.prices[i];
          const age = p ? Math.max(0, now - p.publishTime) : null;
          const stale = age === null || age > limit;
          return (
            <span key={a} className="fill" title={age === null ? "No price" : `Pyth, ${age}s old`}>
              <i className={`dot ${stale ? "stale" : "fresh"}`} aria-label={stale ? "stale" : "fresh"} />
              {a} <span className="n">{p ? price(a, p.price) : "–"}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function LastResult({ last }: { last: LastRound }) {
  if (!last.finalized) return null;
  let text: string;
  let tone = "";
  if (last.mine?.traded && last.mine.rank === 1) {
    text = `You won the last round, ${pct(last.mine.pnlPct)}`;
    tone = "win";
  } else if (last.mine?.traded) {
    text = `Last round: ${ordinal(last.mine.rank ?? 0)} of ${last.traders}, ${pct(last.mine.pnlPct)}`;
    tone = "mine";
  } else if (last.winnerLabel) text = `Last round: ${last.winnerLabel} won, ${pct(last.winnerPnlPct ?? 0)}`;
  else text = "Last round: no trades";
  return <span className={`result ${tone}`}>{text}</span>;
}

function TradeChart({ arena, asset, seconds, me, book }: { arena: ArenaState; asset: Asset; seconds: number; me: Row | undefined; book: Position[] | null }) {
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
  const mine = book?.[i];
  const lines: ChartLine[] = [{ price: arena.prices[i]?.price ?? 0, title: "Pyth", who: "pyth" }];
  if (mine && mine.qty !== 0 && mine.entry > 0) lines.push({ price: mine.entry, title: "Entry", who: "me" });
  return <Chart asset={asset} seconds={seconds} marks={marks} lines={lines} />;
}

function Ticket({
  arena,
  asset,
  onAsset,
  sender,
  me,
  book,
  live,
}: {
  arena: ArenaState;
  asset: Asset;
  onAsset: (a: Asset) => void;
  sender: Sender;
  me: Row | undefined;
  book: Position[] | null;
  live: boolean;
}) {
  const { wallet, player, busy, note } = sender;
  const [name, setName] = useState(savedName);
  const [amount, setAmount] = useState("1000");
  const [why, setWhy] = useState("");
  const [buy, setBuy] = useState(true);

  const i = ASSETS.indexOf(asset);
  const mark = arena.prices[i]?.price ?? 0;
  const held = me ? me.entrant.qty[i] * mark : 0;
  const equity = me ? me.equity : (arena.round?.startCash ?? 10_000);
  const cash = me ? me.entrant.cash : equity;
  const cap = equity * ((arena.round?.maxAssetBps ?? 5_000) / 10_000);
  // Buying covers a short before it adds a long; selling cuts a long before it adds a short.
  const room = buy ? Math.max(0, Math.min(cash, cap - held)) : Math.max(0, cap + held);
  const traders = arena.rows.filter((r) => r.entrant.trades > 0);
  const rank = me && me.entrant.trades > 0 ? traders.indexOf(me) + 1 : null;
  const value = Number(amount);
  const canTrade = !!arena.round && live;

  const trade = (a: Asset, side: number, usdValue: number, done: string) => {
    if (!player || !PROGRAM_ID || !arena.roundAddress) return;
    const reason = why.trim().slice(0, 200) || (side === SIDE_CLOSE ? `Closing ${a}` : "No reason given");
    const ixs = [
      memoIx(reason),
      tradeIx({ programId: PROGRAM_ID, round: arena.roundAddress, player, asset: a, side, usd: usdValue, reasonHash: reasonHash(reason), shardId: arena.round?.shardId }),
    ];
    // Not in the round yet: joining is part of the same transaction.
    if (!me) {
      const label = (name.trim() || player.toBase58().slice(0, 6)).slice(0, 24);
      if (name.trim()) saveName(name.trim());
      ixs.unshift(joinRoundIx({ programId: PROGRAM_ID, round: arena.roundAddress, player, kind: KIND_HUMAN, label }));
    }
    sender.send(ixs, done).then((ok) => ok && setWhy(""));
  };
  const submit = () => {
    if (!(value >= 10)) return sender.setNote({ ok: false, text: "Minimum $10" });
    trade(asset, buy ? SIDE_BUY : SIDE_SELL, value, `${buy ? "Bought" : "Sold"} ${usd(value, 0)} of ${asset}`);
  };
  const verb = buy ? (held < -0.5 ? "Cover" : "Buy") : held > 0.5 ? "Sell" : "Short";

  return (
    <section className="card ticket" aria-label="Trade">
      {!wallet ? (
        <div className="body center">
          <WalletMultiButton />
        </div>
      ) : (
        <>
          {me && (
            <dl className="me">
              <div>
                <dt>Equity</dt>
                <dd className="n">{usd(me.equity, 0)}</dd>
              </div>
              <div>
                <dt>Return</dt>
                <dd className={`n ${me.pnlPct >= 0 ? "up" : "down"}`}>{pct(me.pnlPct)}</dd>
              </div>
              <div>
                <dt>Rank</dt>
                <dd className="n">{rank ? `${rank}/${traders.length}` : "–"}</dd>
              </div>
            </dl>
          )}
          {!me && !canTrade ? (
            <p className="lead">{arena.round ? "Round closed" : "Round opening soon"}</p>
          ) : (
            <form
              className="body order"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {sender.short && <Faucet />}
              {!me && <input aria-label="Name on the board" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={24} />}
              <div className="seg wide" role="radiogroup" aria-label="Side">
                <button type="button" role="radio" aria-checked={buy} className={buy ? "on buy" : ""} onClick={() => setBuy(true)}>
                  {held < -0.5 ? "Cover" : "Buy"}
                </button>
                <button type="button" role="radio" aria-checked={!buy} className={!buy ? "on sell" : ""} onClick={() => setBuy(false)}>
                  {held > 0.5 ? "Sell" : "Short"}
                </button>
              </div>
              <div className="seg wide" role="radiogroup" aria-label="Coin">
                {ASSETS.map((a) => (
                  <button type="button" key={a} role="radio" aria-checked={a === asset} className={a === asset ? "on" : ""} onClick={() => onAsset(a)}>
                    {a}
                  </button>
                ))}
              </div>
              <label className="amount">
                <span>$</span>
                <input aria-label="Amount in dollars" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
              </label>
              <div className="presets">
                {[0.25, 0.5, 1].map((f) => (
                  <button type="button" key={f} onClick={() => setAmount(String(Math.floor(room * f)))}>
                    {f === 1 ? `Max ${kilo(room)}` : `${f * 100}%`}
                  </button>
                ))}
              </div>
              <input aria-label="Reason, posted on chain" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Reason (on chain)" maxLength={200} />
              <button className={`btn wide ${buy ? "buy" : "sell"}`} disabled={busy || !canTrade}>
                {busy ? "Sending…" : `${me ? "" : "Join · "}${verb} ${asset} ${value >= 10 ? usd(value, 0) : ""}`}
              </button>
            </form>
          )}
          {me && <Positions me={me} book={book} prices={arena.prices.map((p) => p?.price ?? 0)} live={live} busy={busy} onClose={(a) => trade(a, SIDE_CLOSE, 0, `Closed ${a}`)} />}
        </>
      )}
      {note && (
        <p className={`toast ${note.ok ? "ok" : "bad"}`} role="status">
          {note.text}
          {note.sig && (
            <a href={explorerTx(note.sig)} target="_blank" rel="noreferrer">
              Tx ↗
            </a>
          )}
        </p>
      )}
    </section>
  );
}

/** Shown while the connected wallet can't fund its session wallet. */
export function Faucet() {
  return (
    <a className="btn ghost wide" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
      Get devnet SOL
    </a>
  );
}

function Positions({ me, book, prices, live, busy, onClose }: { me: Row; book: Position[] | null; prices: number[]; live: boolean; busy: boolean; onClose: (a: Asset) => void }) {
  const open = ASSETS.map((a, i) => ({ a, i, qty: me.entrant.qty[i] })).filter((x) => Math.abs(x.qty) > 1e-9);
  if (!open.length) return null;
  return (
    <table className="positions" aria-label="Positions">
      <tbody>
        {open.map(({ a, i, qty }) => {
          const entry = book?.[i].entry ?? 0;
          const pnl = entry ? qty * (prices[i] - entry) : null;
          return (
            <tr key={a}>
              <td>
                <b>{a}</b> <span className={qty > 0 ? "up" : "down"}>{qty > 0 ? "long" : "short"}</span>
                <div className="sub n">
                  {coins(a, qty)} @ {entry ? price(a, entry) : "…"}
                </div>
              </td>
              <td className={`n r ${pnl === null ? "" : pnl >= 0 ? "up" : "down"}`}>{pnl === null ? "…" : signedUsd(pnl)}</td>
              <td className="r">
                <button className="btn ghost small" disabled={busy || !live} onClick={() => onClose(a)}>
                  Close
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Board({ arena, market, marketTo }: { arena: ArenaState; market: (from: number, to: number | null) => number | null; marketTo: number | null }) {
  const prices = arena.prices.map((p) => p?.price ?? 0);
  const move = arena.round ? market(arena.start, marketTo) : null;
  let rank = 0;
  return (
    <section className="card" aria-label="Leaderboard">
      <header>
        <h2>Leaderboard</h2>
        {move !== null && (
          <span className="aside">
            Market <span className={`n ${move >= 0 ? "up" : "down"}`}>{pct(move)}</span>
          </span>
        )}
      </header>
      {arena.rows.length === 0 ? (
        <p className="empty">{!arena.ready ? "Loading" : "No players yet"}</p>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th className="r">#</th>
              <th>Player</th>
              <th>Positions</th>
              <th className="r">Equity</th>
              <th className="r">Return</th>
              <th className="r">vs market</th>
            </tr>
          </thead>
          <tbody>
            {arena.rows.map((r) => {
              const traded = r.entrant.trades > 0;
              if (traded) rank++;
              const ai = r.entrant.kind === KIND_AGENT;
              const base = market(Math.max(arena.start, r.entrant.joinedTs), marketTo);
              const name = r.entrant.label || r.entrant.player.toBase58().slice(0, 6);
              return (
                <tr key={r.address} className={`${traded ? "" : "idle"} ${ai ? "ai" : "human"}`}>
                  <td className="r n rank">{traded ? rank : "–"}</td>
                  <td>
                    <span className="who" title={ai ? "Agent" : "Human"}>
                      <i className="mark" aria-label={ai ? "Agent" : "Human"} />
                      {name}
                    </span>
                  </td>
                  <td className="pos">
                    <div className="chips">
                      {ASSETS.map((a, i) => {
                        const v = r.entrant.qty[i] * prices[i];
                        return Math.abs(v) < 0.5 ? null : (
                          <span key={a} className={`chip ${v < 0 ? "short" : ""}`}>
                            {a} {kilo(Math.abs(v))}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="r n">{usd(r.equity)}</td>
                  <td className={`r n ${r.pnlPct >= 0 ? "up" : "down"}`}>{pct(r.pnlPct)}</td>
                  <td className={`r n ${base === null || !traded ? "" : r.pnlPct - base >= 0 ? "up" : "down"}`}>
                    {base === null || !traded ? "–" : pct(r.pnlPct - base)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function History({ arena }: { arena: ArenaState }) {
  if (!arena.history.length) return null;
  return (
    <section className="card" aria-label="Recent rounds">
      <header>
        <h2>Recent rounds</h2>
      </header>
      <ol className="history">
        {arena.history.map((r) => {
          const ai = r.winnerKind === KIND_AGENT;
          const pnl = ((r.winnerEquity - r.startCash) / r.startCash) * 100;
          return (
            <li key={r.roundId} className={!r.won ? "" : ai ? "ai" : "human"}>
              <span className="n when">{stamp(r.start, arena.league)}</span>
              <span className="who">
                {r.won && <i className="mark" aria-label={ai ? "Agent" : "Human"} />}
                {r.won ? r.winnerLabel : "No trades"}
              </span>
              {r.won && <span className={`n r ${pnl >= 0 ? "up" : "down"}`}>{pct(pnl)}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Reasons({ arena }: { arena: ArenaState }) {
  const [onlyThis, setOnlyThis] = useState(false);
  const shown = onlyThis ? arena.thoughts.filter((t) => arena.leagueOfRound(t.round)?.key === arena.league.key) : arena.thoughts;
  return (
    <section className="card reasons" aria-label="Agent reasons">
      <header>
        <h2>Reasons</h2>
        <div className="seg small" role="radiogroup" aria-label="Leagues">
          <button role="radio" aria-checked={!onlyThis} className={!onlyThis ? "on" : ""} onClick={() => setOnlyThis(false)}>
            All
          </button>
          <button role="radio" aria-checked={onlyThis} className={onlyThis ? "on" : ""} onClick={() => setOnlyThis(true)}>
            {arena.league.label}
          </button>
        </div>
      </header>
      {shown.length === 0 && <p className="empty">Loading</p>}
      <ol className="feed">
        {shown.map((t) => (
          <ReasonItem key={t.sig} t={t} now={arena.now} league={arena.leagueOfRound(t.round)?.label ?? null} />
        ))}
      </ol>
    </section>
  );
}

function ReasonItem({ t, now, league }: { t: Thought; now: number; league: string | null }) {
  const at = t.price ? ` at ${price(t.trade.asset, t.price)}` : "";
  const act =
    t.trade.side === SIDE_CLOSE ? `Closed ${t.trade.asset}${at}` : `${t.trade.side === SIDE_BUY ? "Bought" : "Sold"} ${usd(t.trade.usd, 0)} ${t.trade.asset}${at}`;
  return (
    <li className="reason">
      <div className="head">
        <span className="who ai">
          <i className="mark" aria-label="Agent" />
          {t.label}
        </span>
        {league && <span className="tag">{league}</span>}
        <span className="when n">{ago(t.ts, now)}</span>
      </div>
      <p className={`act ${t.trade.side === SIDE_BUY ? "up" : t.trade.side === SIDE_SELL ? "down" : ""}`}>{act}</p>
      <blockquote>{t.reason}</blockquote>
      <div className="foot">
        <span className={t.verified ? "ok" : "bad"} title={`SHA-256 stored by the program: ${t.hash}`}>
          {t.verified ? "✓ Hash matches" : "✗ Hash differs"}
        </span>
        <a href={explorerTx(t.sig)} target="_blank" rel="noreferrer">
          Tx ↗
        </a>
      </div>
    </li>
  );
}
