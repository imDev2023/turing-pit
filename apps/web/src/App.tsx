import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  ASSETS,
  KIND_AGENT,
  KIND_HUMAN,
  MAX_ASSET_BPS,
  PRICE_AGE_KEEPER,
  PERSONAS,
  ROUND_SECONDS,
  SHARD_ID,
  SIDE_BUY,
  SIDE_SELL,
  agentSystemPrompt,
  explainError,
  joinRoundIx,
  memoIx,
  reasonHash,
  tradeIx,
  type Asset,
} from "@turing-pit/sdk";
import { PROGRAM_ID, explorerAddress, explorerTx } from "./config";
import { useArena, type ArenaState, type PastRound, type Row, type Thought } from "./useArena";

type Phase = "live" | "settling";

const usd = (n: number, d = 2) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%";
const clock = (s: number) => {
  const v = Math.max(0, s);
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};
const ago = (ts: number, now: number) => {
  const s = Math.max(0, now - ts);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + " UTC";

/** Pit traders wore a three-letter badge; ours come from the name on the board. */
function badge(label: string, ai: boolean): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  const pick = (ai && words.length > 1 ? words[1] : words[0]) ?? "PIT";
  return pick.slice(0, 3).toUpperCase().padEnd(3, "X");
}

export function App() {
  const arena = useArena();
  const phase: Phase = arena.now < arena.end ? "live" : "settling";
  const left = phase === "live" ? arena.end - arena.now : arena.start + ROUND_SECONDS - arena.now;

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

        <section className="hero">
          <div className={`clock ${phase === "live" && left <= 60 ? "urgent" : ""}`}>
            <p className="clock-label">{phase === "live" ? "Trading closes in" : "Settling. Next round in"}</p>
            <p className="clock-time" aria-live="off">
              {clock(left)}
            </p>
            <p className="clock-sub">
              {phase === "live"
                ? `Round opened ${utc(arena.start)} with ${arena.rows.length} ${arena.rows.length === 1 ? "trader" : "traders"}.`
                : "Final equity is being marked at the closing price."}
            </p>
          </div>
          <div className="pitch">
            <h1>Can you out-trade the machines?</h1>
            <p>
              Three Claude agents trade SOL, BTC and ETH against anyone with a wallet. Rounds last fifteen minutes, everyone starts with
              $10,000 of paper cash, and a Solana program keeps the books.
            </p>
            <Scoreboard arena={arena} />
          </div>
        </section>

        <Prices arena={arena} />

        {arena.error && <p className="banner">{arena.error}</p>}

        <main className="grid">
          <div className="stack">
            <Leaderboard arena={arena} />
            <Seat arena={arena} phase={phase} />
            <History rounds={arena.history} />
          </div>
          <Thoughts thoughts={arena.thoughts} now={arena.now} />
        </main>

        <section className="agents" aria-labelledby="agents-title">
          <div className="panel-head">
            <h2 id="agents-title">The agents</h2>
            <span className="hint">Each one is Claude with its own wallet and its own style</span>
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
                    <p className="prompt">{agentSystemPrompt(p)}</p>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <footer className="foot">
          <h2>How a round works</h2>
          <ol className="steps">
            <li>A round opens every fifteen minutes. Humans and agents join with $10,000 of paper cash.</li>
            <li>Trades fill on chain at the latest Pyth price, with a 0.1% fee and at most half your equity in one coin.</li>
            <li>Each agent writes its reason into the trade. The program stores the reason's hash, so nobody can edit it later.</li>
            <li>After fourteen minutes trading stops, the program marks every account to market and records the winner.</li>
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
            . Built for the MLH x Solana hackathon.
          </p>
        </footer>
      </div>
    </MotionConfig>
  );
}

function Scoreboard({ arena }: { arena: ArenaState }) {
  const { ai, human, rounds } = arena.tally;
  const share = rounds ? (ai / rounds) * 100 : 50;
  return (
    <div className="score" aria-label={`Round wins in the last six hours: machines ${ai}, humans ${human}`}>
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
          ? `Rounds won in the last six hours where humans and agents both played.`
          : "No human has played the agents in the last six hours. Be the first."}
      </p>
    </div>
  );
}

function History({ rounds }: { rounds: PastRound[] }) {
  if (!rounds.length) return null;
  return (
    <section className="history">
      <div className="panel-head">
        <h2>Recent rounds</h2>
        <span className="hint">Winners as recorded by the program</span>
      </div>
      <ol>
        {rounds.map((r) => {
          const ai = r.winnerKind === KIND_AGENT;
          const pnl = ((r.winnerEquity - r.startCash) / r.startCash) * 100;
          const humans = r.entrants - r.agents;
          return (
            <li key={r.roundId} className={ai ? "is-ai" : "is-human"}>
              <span className="when">{utc(r.start)}</span>
              <span className="badge small" aria-hidden>
                {badge(r.winnerLabel, ai)}
              </span>
              <span className="who">
                {r.winnerLabel} won with {usd(r.winnerEquity)} <span className={pnl >= 0 ? "up" : "down"}>{pct(pnl)}</span>
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
  const limit = arena.round?.maxPriceAge ?? PRICE_AGE_KEEPER;
  const sponsored = arena.round ? arena.round.shardId !== SHARD_ID : false;
  return (
    <section className="prices" aria-label="Live prices">
      {ASSETS.map((a, i) => {
        const p = arena.prices[i];
        const age = p ? Math.max(0, arena.now - p.publishTime) : null;
        const stale = age !== null && age > limit;
        return (
          <div key={a} className="price">
            <span className="sym">{a}</span>
            <span className="num">{p ? usd(p.price, a === "SOL" ? 2 : 0) : "No price yet"}</span>
            <span className={`age ${stale ? "stale" : ""}`}>
              {age === null ? "" : stale ? `Stale, ${span(age)} old` : `Updated ${span(age)} ago`}
            </span>
          </div>
        );
      })}
      <span className="src">
        {sponsored
          ? "Pyth's own devnet prices, updated about every 5 minutes"
          : "Pyth prices, posted to devnet by the house every few seconds"}
      </span>
    </section>
  );
}

function Leaderboard({ arena }: { arena: ArenaState }) {
  const { publicKey } = useWallet();
  const prices = arena.prices.map((p) => p?.price ?? 0);
  return (
    <section className="panel board-panel">
      <div className="panel-head">
        <h2>Leaderboard</h2>
        <span className="hint">Equity at the live price</span>
      </div>
      {!arena.ready ? (
        <p className="empty">Loading the round…</p>
      ) : !arena.round ? (
        <p className="empty">This round hasn't opened yet. The house opens one every fifteen minutes.</p>
      ) : arena.rows.length === 0 ? (
        <p className="empty">No one has joined this round yet. Connect a wallet and take the first seat.</p>
      ) : (
        <ol className="board">
          <AnimatePresence initial={false}>
            {arena.rows.map((r, i) => (
              <BoardRow key={r.address} row={r} rank={i + 1} prices={prices} me={!!publicKey && r.entrant.player.equals(publicKey)} />
            ))}
          </AnimatePresence>
        </ol>
      )}
    </section>
  );
}

function BoardRow({ row, rank, prices, me }: { row: Row; rank: number; prices: number[]; me: boolean }) {
  const ai = row.entrant.kind === KIND_AGENT;
  const name = row.entrant.label || row.entrant.player.toBase58().slice(0, 6);
  return (
    <motion.li
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ layout: { type: "spring", stiffness: 380, damping: 34 } }}
      className={`row ${ai ? "is-ai" : "is-human"} ${me ? "is-me" : ""}`}
    >
      <span className="rank">{rank}</span>
      <span className="badge" aria-hidden>
        {badge(name, ai)}
      </span>
      <span className="who">
        <span className="name">{name}</span>
        <span className="kind">{ai ? "Claude agent" : me ? "You" : "Human"}</span>
      </span>
      <span className="holds">
        {ASSETS.map((a, i) =>
          row.entrant.qty[i] > 0 ? (
            <span key={a} className="chip">
              {a} {usd(row.entrant.qty[i] * prices[i], 0)}
            </span>
          ) : null,
        )}
        {row.entrant.cash >= 1 && <span className="chip cash">Cash {usd(row.entrant.cash, 0)}</span>}
      </span>
      <span className="eq">{usd(row.equity)}</span>
      <span className={`pnl ${row.pnlPct >= 0 ? "up" : "down"}`}>{pct(row.pnlPct)}</span>
    </motion.li>
  );
}

function Thoughts({ thoughts, now }: { thoughts: Thought[]; now: number }) {
  return (
    <section className="panel thoughts">
      <div className="panel-head">
        <h2>What the agents are thinking</h2>
        <span className="hint">Read straight from the chain</span>
      </div>
      {thoughts.length === 0 && <p className="empty">Agents attach a reason to every trade. Their next one appears here.</p>}
      <div className="feed">
        <AnimatePresence initial={false}>
          {thoughts.map((t) => (
            <motion.article key={t.sig} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="thought">
              <header>
                <span className="badge small" aria-hidden>
                  {badge(t.label, true)}
                </span>
                <span className="who">{t.label}</span>
                <span className="when">{ago(t.ts, now)}</span>
              </header>
              {t.trade && (
                <p className={`act ${t.trade.side === SIDE_BUY ? "up" : "down"}`}>
                  {t.trade.side === SIDE_BUY ? "Bought" : "Sold"} {usd(t.trade.usd, 0)} of {t.trade.asset}
                </p>
              )}
              <blockquote>{t.reason}</blockquote>
              <footer>
                <span className={t.verified ? "ok" : "bad"} title={`SHA-256 stored by the program: ${t.hash}`}>
                  {t.verified ? "Matches the hash stored on chain" : "Doesn't match the hash on chain"}{" "}
                  <code>{t.hash.slice(0, 6)}…{t.hash.slice(-4)}</code>
                </span>
                <a href={explorerTx(t.sig)} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              </footer>
            </motion.article>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Seat({ arena, phase }: { arena: ArenaState; phase: Phase }) {
  const { publicKey, sendTransaction, signTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const [name, setName] = useState("");
  const [asset, setAsset] = useState<Asset>("SOL");
  const [amount, setAmount] = useState("1000");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);
  const [sol, setSol] = useState<number | null>(null);

  const me = useMemo(
    () => (publicKey ? arena.rows.find((r) => r.entrant.player.equals(publicKey)) : undefined),
    [arena.rows, publicKey],
  );

  useEffect(() => {
    if (!publicKey) return setSol(null);
    let live = true;
    connection
      .getBalance(publicKey)
      .then((b) => live && setSol(b / LAMPORTS_PER_SOL))
      .catch(() => live && setSol(null));
    return () => {
      live = false;
    };
  }, [connection, publicKey, msg]);

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

  const join = () => {
    if (!publicKey || !PROGRAM_ID || !arena.roundAddress) return;
    const label = (name.trim() || publicKey.toBase58().slice(0, 6)).slice(0, 24);
    const tx = new Transaction().add(
      joinRoundIx({ programId: PROGRAM_ID, round: arena.roundAddress, player: publicKey, kind: KIND_HUMAN, label }),
    );
    send(tx, "Joined this round. Your $10,000 is ready to trade.");
  };

  const i = ASSETS.indexOf(asset);
  const price = arena.prices[i]?.price ?? 0;
  const held = me ? me.entrant.qty[i] * price : 0;
  const room = me ? Math.max(0, (me.equity * MAX_ASSET_BPS) / 10_000 - held) : 0;

  const trade = (side: number) => {
    if (!publicKey || !PROGRAM_ID || !arena.roundAddress) return;
    const value = Number(amount);
    if (!(value >= 10)) return setMsg({ ok: false, text: "Trades start at $10. Enter a larger amount." });
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
    const sold = side === SIDE_SELL && value >= held ? `Sold all your ${asset}` : `Sold ${usd(value, 0)} of ${asset}`;
    send(tx, side === SIDE_BUY ? `Bought ${usd(value, 0)} of ${asset}` : sold);
    setWhy("");
  };

  return (
    <section className="panel seat">
      <div className="panel-head">
        <h2>Your seat</h2>
        <span className="hint">Phantom, Solflare or Backpack, set to devnet</span>
      </div>

      {!connected && (
        <div className="seat-cta">
          <p>Connect a wallet to take a seat against the agents. Each trade costs a fraction of a cent in devnet SOL, which is free.</p>
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

      {connected && !me && arena.round && phase === "live" && (
        <div className="join">
          <label className="field">
            <span>Name on the board</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Farhan" maxLength={24} />
          </label>
          <button className="primary" disabled={busy} onClick={join}>
            {busy ? "Joining…" : "Join this round"}
          </button>
        </div>
      )}
      {connected && !me && phase === "settling" && <p className="empty">This round has closed. Join the next one when the clock restarts.</p>}

      {me && (
        <>
          <dl className="mine">
            <div>
              <dt>Equity</dt>
              <dd>{usd(me.equity)}</dd>
            </div>
            <div>
              <dt>Cash</dt>
              <dd>{usd(me.entrant.cash)}</dd>
            </div>
            <div>
              <dt>Profit</dt>
              <dd className={me.pnlPct >= 0 ? "up" : "down"}>{pct(me.pnlPct)}</dd>
            </div>
            <div>
              <dt>Rank</dt>
              <dd>
                {arena.rows.indexOf(me) + 1} of {arena.rows.length}
              </dd>
            </div>
          </dl>

          <div className="ticket">
            <div className="assets" role="radiogroup" aria-label="Coin">
              {ASSETS.map((a) => (
                <button key={a} role="radio" aria-checked={a === asset} className={a === asset ? "on" : ""} onClick={() => setAsset(a)}>
                  {a}
                </button>
              ))}
            </div>
            <label className="field amount">
              <span>Amount in dollars</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
            </label>
            <div className="quick">
              {[0.1, 0.25, 0.5].map((f) => (
                <button key={f} onClick={() => setAmount(String(Math.floor(Math.min(me.entrant.cash, room) * f)))}>
                  {f * 100}% of room
                </button>
              ))}
              <button onClick={() => setAmount(String(Math.ceil(held * 1.02) + 1))} disabled={held < 10}>
                All my {asset}
              </button>
            </div>
            <label className="field">
              <span>Why? Your reason goes on chain with the trade (optional)</span>
              <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. SOL is lagging BTC, it'll catch up" maxLength={200} />
            </label>
            <div className="go">
              <button className="buy" disabled={busy || phase !== "live"} onClick={() => trade(SIDE_BUY)}>
                Buy {asset}
              </button>
              <button className="sell" disabled={busy || phase !== "live" || held < 10} onClick={() => trade(SIDE_SELL)}>
                Sell {asset}
              </button>
            </div>
            <p className="fine">
              You hold {usd(held)} of {asset}. You can buy {usd(room, 0)} more before hitting the 50% limit. Every trade pays a 0.1% fee.
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
