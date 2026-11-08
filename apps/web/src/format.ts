import type { Asset, League } from "@turing-pit/sdk";

export const usd = (n: number, d = 2) =>
  (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const signedUsd = (n: number, d = 2) => (n >= 0 ? "+" : "") + usd(n, d);
export const pct = (n: number) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%";
export const kilo = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `$${Math.round(n)}`);
export const priceDp = (a: Asset, p: number) => (a === "BTC" && p > 10_000 ? 0 : 2);
export const price = (a: Asset, p: number) => usd(p, priceDp(a, p));
export const coins = (a: Asset, q: number) => Math.abs(q).toFixed(a === "BTC" ? 5 : a === "ETH" ? 4 : 3);
export const ordinal = (n: number) =>
  n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

const pad = (n: number) => String(n).padStart(2, "0");

/** A countdown: mm:ss under an hour, h:mm:ss under a day, then days and hours. */
export function countdown(s: number): string {
  const v = Math.max(0, Math.floor(s));
  const d = Math.floor(v / 86_400);
  const h = Math.floor((v % 86_400) / 3_600);
  const m = Math.floor((v % 3_600) / 60);
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  if (h > 0) return `${h}:${pad(m)}:${pad(v % 60)}`;
  return `${pad(m)}:${pad(v % 60)}`;
}

/** The same, short enough for a tab. */
export function brief(s: number): string {
  const v = Math.max(0, Math.floor(s));
  const d = Math.floor(v / 86_400);
  const h = Math.floor((v % 86_400) / 3_600);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(Math.floor((v % 3_600) / 60))}m`;
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
}

export const ago = (ts: number, now: number) => {
  const s = Math.max(0, now - ts);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};

export const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A time as a league reads it: the clock for short rounds, the day as well for long ones (UTC). */
export function stamp(ts: number, league?: League): string {
  if (!league || league.key === "sprint" || league.key === "hour") return utc(ts);
  const d = new Date(ts * 1000);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${utc(ts)}`;
}

/** Pit traders wore a three-letter badge; ours come from the name on the board. */
export function badge(label: string, ai: boolean): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).filter(Boolean);
  const pick = (ai && words.length > 1 ? words[1] : words[0]) ?? "PIT";
  return pick.slice(0, 3).toUpperCase().padEnd(3, "X");
}

const NAME = "turing-pit:name";
/** The name a player last joined with, kept in this browser only. */
export function savedName(): string {
  try {
    return localStorage.getItem(NAME) ?? "";
  } catch {
    return "";
  }
}
export function saveName(name: string) {
  try {
    localStorage.setItem(NAME, name);
  } catch {
    // private windows refuse storage; the name is only a convenience
  }
}
