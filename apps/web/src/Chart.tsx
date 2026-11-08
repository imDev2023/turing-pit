import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Asset } from "@turing-pit/sdk";
import { fetchCandles, onTick, type Candle } from "./market";

/** A trade drawn on the chart. */
export interface ChartMark {
  asset: Asset;
  ts: number;
  buy: boolean;
  who: "me" | "agent" | "human";
  text: string;
}

export interface ChartLine {
  price: number;
  title: string;
  who: "pyth" | "me";
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Candles for one coin from Coinbase, kept live tick by tick, with the round's trades and the
 *  price trades fill at drawn over them. Lightweight Charts is TradingView's open-source library;
 *  its logo stays on the chart as its licence asks. */
export function Chart({ asset, seconds, marks, lines }: { asset: Asset; seconds: number; marks: ChartMark[]; lines: ChartLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const last = useRef<Candle | null>(null);
  const first = useRef(0);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: token("--muted"),
        fontFamily: token("--font"),
        fontSize: 12,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "rgba(255, 255, 255, 0.04)" }, horzLines: { color: "rgba(255, 255, 255, 0.04)" } },
      rightPriceScale: { borderColor: token("--line") },
      timeScale: { borderColor: token("--line"), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const up = token("--up");
    const down = token("--down");
    const s = c.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    chart.current = c;
    series.current = s;
    markers.current = createSeriesMarkers(s, []);
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      markers.current = null;
      priceLines.current = [];
    };
  }, []);

  // Candles for the coin and interval, then every trade on the exchange as it happens.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let fitted = false;
    last.current = null;
    s.setData([]);
    s.applyOptions({ priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
    setState("loading");
    const load = () =>
      fetchCandles(asset, seconds)
        .then((cs) => {
          if (cancelled || !series.current) return;
          series.current.setData(cs.map((x) => ({ ...x, time: x.time as UTCTimestamp })));
          last.current = cs[cs.length - 1] ?? null;
          first.current = cs[0]?.time ?? 0;
          if (!fitted) chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - 110), to: cs.length + 6 });
          fitted = true;
          setState("ok");
        })
        .catch(() => {
          if (cancelled) return;
          setState((s) => (s === "ok" ? s : "error"));
          retry = setTimeout(load, 10_000);
        });
    load();
    const off = onTick((t) => {
      if (t.asset !== asset || !series.current || !last.current) return;
      const bucket = Math.floor(t.time / seconds) * seconds;
      const prev = last.current;
      if (bucket < prev.time) return;
      const next =
        bucket === prev.time
          ? { ...prev, high: Math.max(prev.high, t.price), low: Math.min(prev.low, t.price), close: t.price }
          : { time: bucket, open: t.price, high: t.price, low: t.price, close: t.price };
      last.current = next;
      series.current.update({ ...next, time: next.time as UTCTimestamp });
    });
    // A tab in the background can miss ticks; catch up when it is shown again.
    const shown = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", shown);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      off();
      document.removeEventListener("visibilitychange", shown);
    };
  }, [asset, seconds]);

  // The round's trades, on the candle they happened in.
  useEffect(() => {
    if (!markers.current) return;
    const color = { me: token("--human"), agent: token("--machine"), human: token("--text") };
    // Only on candles the chart has: a trade in a minute with no candle yet waits for its tick.
    const newest = last.current?.time ?? 0;
    const list: SeriesMarker<Time>[] = marks
      .filter((m) => m.asset === asset)
      .map((m) => ({ ...m, bar: Math.floor(m.ts / seconds) * seconds }))
      .filter((m) => m.bar >= first.current && m.bar <= newest)
      .sort((a, b) => a.bar - b.bar)
      .map((m) => ({
        time: m.bar as UTCTimestamp,
        position: m.buy ? "belowBar" : "aboveBar",
        shape: m.buy ? "arrowUp" : "arrowDown",
        color: color[m.who],
        text: m.text,
      }));
    markers.current.setMarkers(list);
  }, [marks, asset, seconds, state]);

  // The Pyth price trades fill at, and the player's own entry.
  const key = lines.map((l) => `${l.who}:${l.price}:${l.title}`).join("|");
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    priceLines.current.forEach((l) => s.removePriceLine(l));
    priceLines.current = lines
      .filter((l) => l.price > 0)
      .map((l) =>
        s.createPriceLine({
          price: l.price,
          color: l.who === "me" ? token("--human") : token("--machine"),
          lineWidth: 1,
          lineStyle: l.who === "me" ? LineStyle.Dashed : LineStyle.Dotted,
          axisLabelVisible: true,
          title: l.title,
        }),
      );
    // `key` stands for `lines`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="chart">
      <div ref={box} className="chart-canvas" />
      {state !== "ok" && (
        <p className="chart-state">{state === "loading" ? "Loading" : "Chart unavailable"}</p>
      )}
    </div>
  );
}
