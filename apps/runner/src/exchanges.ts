// The exchanges behind the house's prices. Each read returns mid prices (halfway between the best
// bid and ask) in dollars per coin: Binance's and OKX's USDC books, Coinbase's USD books and
// Hyperliquid's perpetuals (quoted in USDC). The house posts the median of the ones that answered
// in the last few seconds.

import { ASSETS, EXCHANGES, type Asset } from "@turing-pit/sdk";

export type Mids = Partial<Record<Asset, number>>;
export type Exchange = (typeof EXCHANGES)[number];

const TIMEOUT_MS = 1_500;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mid(bid: unknown, ask: unknown): number | undefined {
  const b = Number(bid);
  const a = Number(ask);
  return b > 0 && a >= b ? (a + b) / 2 : undefined;
}

/** One request per coin; a coin that fails is just missing. */
async function perCoin(read: (a: Asset) => Promise<number | undefined>): Promise<Mids> {
  const out: Mids = {};
  const got = await Promise.allSettled(ASSETS.map(read));
  got.forEach((g, i) => {
    if (g.status === "fulfilled" && g.value) out[ASSETS[i]] = g.value;
  });
  if (!Object.keys(out).length) throw (got.find((g) => g.status === "rejected") as PromiseRejectedResult)?.reason ?? new Error("no prices");
  return out;
}

export const READ: Record<Exchange, () => Promise<Mids>> = {
  // Binance's market-data host: api.binance.com refuses US addresses, GitHub's runners among them.
  async Binance() {
    const symbols = encodeURIComponent(JSON.stringify(ASSETS.map((a) => `${a}USDC`)));
    const rows = (await getJson(`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbols=${symbols}`)) as {
      symbol: string;
      bidPrice: string;
      askPrice: string;
    }[];
    const out: Mids = {};
    for (const r of rows) {
      const a = ASSETS.find((x) => r.symbol === `${x}USDC`);
      const m = mid(r.bidPrice, r.askPrice);
      if (a && m) out[a] = m;
    }
    return out;
  },
  Coinbase: () =>
    perCoin(async (a) => {
      const t = (await getJson(`https://api.exchange.coinbase.com/products/${a}-USD/ticker`)) as { bid?: string; ask?: string };
      return mid(t.bid, t.ask);
    }),
  OKX: () =>
    perCoin(async (a) => {
      const r = (await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${a}-USDC`)) as { data?: { bidPx?: string; askPx?: string }[] };
      return mid(r.data?.[0]?.bidPx, r.data?.[0]?.askPx);
    }),
  async Hyperliquid() {
    const all = (await getJson("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    })) as Record<string, string>;
    const out: Mids = {};
    for (const a of ASSETS) if (Number(all[a]) > 0) out[a] = Number(all[a]);
    return out;
  },
};

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The last hour of Coinbase's one-minute closes for a coin, oldest first, so the agents see
 *  1-minute, 5-minute and 1-hour moves from their first decision. */
export async function lastHour(a: Asset): Promise<{ t: number; price: number }[]> {
  const rows = (await getJson(`https://api.exchange.coinbase.com/products/${a}-USD/candles?granularity=60`)) as number[][];
  const now = Date.now() / 1000;
  return rows
    .filter((r) => r[0] >= now - 65 * 60 && r[0] + 60 <= now && r[4] > 0)
    .map((r) => ({ t: r[0] + 60, price: r[4] }))
    .sort((x, y) => x.t - y.t);
}
