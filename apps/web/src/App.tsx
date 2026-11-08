import { useEffect, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LEAGUE, LEAGUES, PERSONAS, agentSystemPrompt, roundIdAt, roundTimes, type LeagueKey } from "@turing-pit/sdk";
import { PROGRAM_ID, explorerAddress } from "./config";
import { DuelsView } from "./Duels";
import { brief } from "./format";
import { LeagueView } from "./League";
import { useQuotes } from "./market";
import { useSender } from "./send";
import { useArena } from "./useArena";
import { useDuels } from "./useDuels";

const MODES: LeagueKey[] = [...LEAGUES.map((l) => l.key), "duel"];
const hashOf = (k: LeagueKey) => (k === "duel" ? "#duels" : `#${k}`);

/** The view shown, kept in the address (#week, #duels), so a link opens the same one. */
function useMode(): [LeagueKey, (k: LeagueKey) => void] {
  const read = (): LeagueKey => MODES.find((k) => hashOf(k) === window.location.hash) ?? "sprint";
  const [mode, setMode] = useState<LeagueKey>(read);
  useEffect(() => {
    const on = () => setMode(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [
    mode,
    (k) => {
      window.history.replaceState(null, "", k === "sprint" ? window.location.pathname + window.location.search : hashOf(k));
      setMode(k);
    },
  ];
}

export function App() {
  const [mode, setMode] = useMode();
  const duelMode = mode === "duel";
  const refresh = useRef<(() => void)[]>([]);
  const sender = useSender(() => refresh.current.forEach((f) => f()));
  const arena = useArena(duelMode ? "sprint" : mode, sender.player);
  const duels = useDuels(duelMode);
  refresh.current = [arena.refresh, duels.refresh];
  const { quotes } = useQuotes();
  useEffect(() => sender.setNote(null), [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.title = mode === "sprint" ? "Turing Pit" : `${LEAGUE[mode].label} · Turing Pit`;
  }, [mode]);
  const { now } = arena;

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="./">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--raised)" />
            <path d="M8 23l8-14 8 14" stroke="var(--human)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="16" cy="19" r="2.2" fill="var(--machine)" />
          </svg>
          Turing Pit
        </a>
        <nav className="modes" aria-label="Leagues">
          {MODES.map((k) => {
            const l = LEAGUE[k];
            let left = "";
            if (k === "open") left = "∞";
            else if (k !== "duel") {
              const { end, next } = roundTimes(roundIdAt(now, k));
              left = brief(now < end ? end - now : next - now);
            }
            return (
              <button key={k} className={k === mode ? "on" : ""} aria-current={k === mode ? "page" : undefined} onClick={() => setMode(k)}>
                {l.label}
                {left && <span className="n">{left}</span>}
              </button>
            );
          })}
        </nav>
        {!duelMode && mode !== "open" && arena.tally.rounds > 0 && (
          <span className="score" title={`Round wins where humans and agents both played, last 24 ${arena.league.noun} rounds`}>
            Machines <b className="n machine">{arena.tally.ai}</b> · Humans <b className="n human">{arena.tally.human}</b>
          </span>
        )}
        <WalletMultiButton />
      </header>

      <main>{duelMode ? <DuelsView state={duels} sender={sender} now={now} /> : <LeagueView arena={arena} quotes={quotes} sender={sender} />}</main>

      <section className="agents" aria-label="Agents">
        {PERSONAS.map((p) => (
          <details key={p.label}>
            <summary>
              <span className="who ai">
                <i className="mark" aria-hidden />
                {p.label}
              </span>
              <span>{p.style}</span>
            </summary>
            <p>{agentSystemPrompt(p, duelMode ? LEAGUE.sprint : arena.league)}</p>
          </details>
        ))}
      </section>

      <footer className="foot">
        <span>Solana devnet</span>
        {PROGRAM_ID && (
          <a href={explorerAddress(PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer">
            Program ↗
          </a>
        )}
        <a href="https://github.com/imDev2023/turing-pit" target="_blank" rel="noreferrer">
          Code ↗
        </a>
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">
          Charts by TradingView ↗
        </a>
        <a href="llms.txt">llms.txt</a>
      </footer>
    </div>
  );
}
