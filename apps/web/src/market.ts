import { useEffect, useState } from "react";
import { ASSETS, type Asset } from "@turing-pit/sdk";

// The charts and the live quotes come from Coinbase's public market data: candles over REST and
// every trade over a websocket (or, when that is blocked, its ticker polled every few seconds).
// Trades in the arena still fill on chain at the Pyth price, which the chart draws as its own line.

const REST = "https://api.exchange.coinbase.com";
const WS = "wss://ws-feed.exchange.coinbase.com";
export const PRODUCT: Record<Asset, string> = { SOL: "SOL-USD", BTC: "BTC-USD", ETH: "ETH-USD" };

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const INTERVALS = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3_600 },
  { label: "6h", seconds: 21_600 },
  { label: "1d", seconds: 86_400 },
] as const;

const iso = (t: number) => new Date(t * 1000).toISOString();
/** Coinbase lets candle responses be cached for five minutes, which would show a stale chart or
 *  an empty minute that has since filled in; a throwaway parameter asks for fresh ones. */
const fresh = () => `&_=${Date.now()}`;

/** The latest 300 candles of a coin, oldest first. */
export async function fetchCandles(asset: Asset, seconds: number): Promise<Candle[]> {
  const res = await fetch(`${REST}/products/${PRODUCT[asset]}/candles?granularity=${seconds}${fresh()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Coinbase candles: HTTP ${res.status}`);
  const rows = (await res.json()) as number[][];
  return rows
    .map(([time, low, high, open, close]) => ({ time, open, high, low, close }))
    .sort((a, b) => a.time - b.time);
}

const opens = new Map<string, Promise<number | null>>();

/** A coin's price at the start of a minute: the open of that minute's candle. */
export function priceAt(asset: Asset, t: number): Promise<number | null> {
  const minute = Math.floor(t / 60) * 60;
  const key = `${asset}:${minute}`;
  let p = opens.get(key);
  if (!p) {
    p = fetch(`${REST}/products/${PRODUCT[asset]}/candles?granularity=60&start=${iso(minute - 60)}&end=${iso(minute + 120)}${fresh()}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? (r.json() as Promise<number[][]>) : []))
      .then((rows) => rows.find((x) => x[0] === minute)?.[3] ?? null)
      .catch(() => null);
    opens.set(key, p);
    // A failed lookup is tried again next time it is asked for.
    p.then((v) => v === null && opens.delete(key));
  }
  return p;
}

export interface Tick {
  asset: Asset;
  price: number;
  time: number;
}

export interface Quote {
  price: number;
  time: number;
  /** The price 24 hours ago, when the feed gives it. */
  open24h: number | null;
}

const listeners = new Set<(t: Tick) => void>();
const quotes: Partial<Record<Asset, Quote>> = {};
let started = false;
let streaming = false;

function emit(t: Tick, open24h: number | null) {
  quotes[t.asset] = { price: t.price, time: t.time, open24h: open24h ?? quotes[t.asset]?.open24h ?? null };
  listeners.forEach((fn) => fn(t));
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const byProduct = Object.fromEntries(ASSETS.map((a) => [PRODUCT[a], a])) as Record<string, Asset>;
  let poll: ReturnType<typeof setInterval> | undefined;
  let retry = 1_000;

  const pollOnce = () =>
    ASSETS.forEach((a) =>
      fetch(`${REST}/products/${PRODUCT[a]}/ticker`)
        .then((r) => (r.ok ? (r.json() as Promise<{ price?: string; time?: string }>) : null))
        .then((j) => {
          if (j?.price) emit({ asset: a, price: Number(j.price), time: (j.time ? Date.parse(j.time) : Date.now()) / 1000 }, null);
        })
        .catch(() => undefined),
    );
  const startPolling = () => {
    if (poll) return;
    pollOnce();
    poll = setInterval(pollOnce, 3_000);
  };
  const stopPolling = () => {
    clearInterval(poll);
    poll = undefined;
  };

  const connect = () => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS);
    } catch {
      startPolling();
      return;
    }
    // No trade within six seconds: poll the ticker until the stream delivers.
    const fallback = setTimeout(startPolling, 6_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", product_ids: Object.keys(byProduct), channels: ["ticker"] }));
    ws.onmessage = (ev) => {
      let m: { type?: string; product_id?: string; price?: string; time?: string; open_24h?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type !== "ticker" || !m.product_id) return;
      const asset = byProduct[m.product_id];
      const price = Number(m.price);
      if (!asset || !(price > 0)) return;
      if (!streaming) {
        streaming = true;
        clearTimeout(fallback);
        stopPolling();
        retry = 1_000;
      }
      emit({ asset, price, time: (m.time ? Date.parse(m.time) : Date.now()) / 1000 }, m.open_24h ? Number(m.open_24h) : null);
    };
    ws.onclose = () => {
      clearTimeout(fallback);
      streaming = false;
      startPolling();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  };
  connect();
}

/** Calls `fn` with every trade on the three coins; returns the unsubscribe. */
export function onTick(fn: (t: Tick) => void): () => void {
  start();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The latest quote per coin, refreshed for the page once a second. */
export function useQuotes(): { quotes: Partial<Record<Asset, Quote>>; streaming: boolean } {
  const [state, setState] = useState(() => ({ quotes: { ...quotes }, streaming }));
  useEffect(() => {
    start();
    const t = setInterval(() => setState({ quotes: { ...quotes }, streaming }), 1_000);
    return () => clearInterval(t);
  }, []);
  return state;
}
