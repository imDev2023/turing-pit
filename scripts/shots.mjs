// Screenshots of the live arena for the README and the hackathon gallery, and optionally a
// captioned walkthrough video (1920x1080 MP4). Runs on a GitHub runner (.github/workflows/shots.yml),
// which can reach the site and Solana devnet, with Playwright installed next to this file.
//
//   SITE_URL   the arena (default: the GitHub Pages site)
//   OUT_DIR    where the files go (default: shots-out)
//   VIDEO      "true" to record the walkthrough as well (needs ffmpeg)
//
// page.json records what the page showed (clock, prices, board, latest thoughts), so a run can be
// checked without opening the images.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const url = process.env.SITE_URL || "https://imdev2023.github.io/turing-pit/";
const out = process.env.OUT_DIR || "shots-out";
const video = process.env.VIDEO === "true";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

/** Counts the RPC requests that failed (by HTTP status and method), so a run shows when the public
 *  RPC turned the runner away. Returns a function that summarizes them. */
function watchRpc(page) {
  const counts = new Map();
  const add = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const method = (req) => {
    try {
      const body = JSON.parse(req.postData() ?? "null");
      return Array.isArray(body) ? `batch of ${body.length}` : (body?.method ?? "?");
    } catch {
      return "?";
    }
  };
  page.on("response", (res) => {
    if (/solana\.com/.test(res.url()) && res.status() >= 400) add(`${res.status()} ${method(res.request())}`);
  });
  page.on("requestfailed", (req) => {
    if (/solana\.com/.test(req.url())) add(`${req.failure()?.errorText ?? "failed"} ${method(req)}`);
  });
  return () => [...counts].map(([k, n]) => `${k} x${n}`);
}

/** Opens the arena and waits for the chain data: prices, then the agents' reasons (when there are
 *  any; they load after the board), then a few more polls. */
async function openArena(context) {
  const page = await context.newPage();
  page.rpcErrors = watchRpc(page);
  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page
    .waitForFunction(() => /\$\d/.test(document.querySelector(".fills")?.textContent ?? ""), null, { timeout: 60_000 })
    .catch(() => console.log("no prices after a minute; taking the shots anyway"));
  await page
    .waitForSelector(".reasons .reason", { timeout: 45_000 })
    .catch(() => console.log("no agent reasons on the page after 45 s"));
  await page
    .waitForFunction(() => !document.querySelector(".chart-card .chart-state"), null, { timeout: 30_000 })
    .catch(() => console.log("no chart candles after 30 s"));
  await page.waitForTimeout(5_000);
  return page;
}

async function describe(page) {
  return page.evaluate(() => {
    const t = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const all = (sel) => [...document.querySelectorAll(sel)];
    return {
      at: new Date().toISOString(),
      league: t(document.querySelector(".modes .on")),
      strip: t(document.querySelector(".strip")),
      tickers: all(".chart-card .seg button").map(t),
      chart: document.querySelector(".chart-card .chart-state") ? t(document.querySelector(".chart-card .chart-state")) : "candles shown",
      score: t(document.querySelector(".score")),
      alert: t(document.querySelector(".alert")) || null,
      board: all(".board tbody tr").map(t),
      reasons: all(".reasons .reason").slice(0, 6).map(t),
      history: all(".history li").slice(0, 6).map(t),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The walkthrough: a 1280x720 page at 1.5x, captured frame by frame through the DevTools
// screencast (sharper than Playwright's own video) and encoded with ffmpeg. Captions are an
// overlay on the page itself, with plain colours so they also work on Solana Explorer.

const OVERLAY_CSS = `
  html { scroll-behavior: auto !important; }
  #wt-cap { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 2147483000;
    width: max-content; max-width: min(900px, 88vw); padding: 12px 22px; border-radius: 12px;
    background: rgba(15, 16, 18, 0.96); border: 1px solid #2f3137; box-shadow: 0 14px 44px rgba(0, 0, 0, 0.6);
    color: #f3f4f5; font: 500 20px/1.45 "Instrument Sans Variable", system-ui, sans-serif; text-align: center;
    opacity: 0; transition: opacity 0.35s ease; pointer-events: none; }
  #wt-cap.on { opacity: 1; }
  #wt-card { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-content: center; gap: 18px;
    padding: 48px; background: #08090a; color: #f3f4f5; text-align: center; opacity: 0;
    transition: opacity 0.6s ease; pointer-events: none; }
  #wt-card.on { opacity: 1; }
  #wt-card h1 { margin: 0; font: 650 92px/1 "Instrument Sans Variable", system-ui, sans-serif; letter-spacing: -0.03em; }
  #wt-card p { margin: 0 auto; max-width: 920px; color: #8b9099; font: 400 26px/1.45 "Instrument Sans Variable", system-ui, sans-serif; }
  #wt-card b { color: #f3f4f5; font-weight: 600; }
  #wt-card .m { color: #9d8cff; } #wt-card .h { color: #f2c14e; }
  .wt-spot { outline: 2px solid #9d8cff !important; outline-offset: 4px; border-radius: 12px; transition: outline-color 0.3s ease; }
`;

async function prepare(p) {
  await p.addStyleTag({ content: OVERLAY_CSS });
  await p.evaluate(() => {
    for (const id of ["wt-cap", "wt-card"]) {
      if (!document.getElementById(id)) {
        const el = document.createElement("div");
        el.id = id;
        document.body.appendChild(el);
      }
    }
  });
}

const caption = (p, html) =>
  p.evaluate((html) => {
    const el = document.getElementById("wt-cap");
    if (!html) return el.classList.remove("on");
    el.innerHTML = html;
    el.classList.add("on");
  }, html);

const card = (p, html) =>
  p.evaluate((html) => {
    const el = document.getElementById("wt-card");
    if (!html) return el.classList.remove("on");
    el.innerHTML = html;
    el.classList.add("on");
  }, html);

const spot = (p, sel) =>
  p.evaluate((sel) => {
    document.querySelectorAll(".wt-spot").forEach((el) => el.classList.remove("wt-spot"));
    if (sel) document.querySelector(sel)?.classList.add("wt-spot");
  }, sel);

/** Eases the window so the element's top sits `offset` px below the top of the screen. */
const glide = (p, sel, offset = 80, ms = 1400) =>
  p.evaluate(
    ({ sel, offset, ms }) =>
      new Promise((done) => {
        const el = typeof sel === "string" ? document.querySelector(sel) : null;
        const from = window.scrollY;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const to = el ? Math.max(0, Math.min(max, el.getBoundingClientRect().top + from - offset)) : from;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          window.scrollTo(0, from + (to - from) * e);
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    { sel, offset, ms },
  );

async function walkthrough() {
  const framesDir = mkdtempSync(join(tmpdir(), "frames-"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const p = await openArena(context);
  await prepare(p);
  const wait = (s) => p.waitForTimeout(s * 1000);
  const { host, pathname } = new URL(url);
  const site = (host.toLowerCase() + pathname).replace(/\/$/, "");

  const cdp = await context.newCDPSession(p);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });

  // Title card first, so the video doesn't open on a half-drawn page.
  await card(
    p,
    `<h1>Turing Pit</h1><p><b class="m">Three AI agents</b> and <b class="h">anyone with a wallet</b> trade SOL, BTC and ETH, long or short, on Solana devnet.</p>`,
  );
  await wait(0.8);
  const SCREENCAST = { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 };
  /** Stretches when the recording was paused, left out of the video. */
  const gaps = [];
  /** When each scene starts on the film's own clock (pauses left out), for placing narration. */
  const timeline = [];
  const scene = (name) => {
    const now = Date.now() / 1000;
    const paused = gaps.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(now, to) - from), 0);
    timeline.push({ scene: name, at: Number((now - started - paused).toFixed(2)) });
  };
  await cdp.send("Page.startScreencast", SCREENCAST);
  const started = Date.now() / 1000;
  scene("title");
  await wait(4.5);
  await card(p, "");
  await wait(0.8);

  scene("leagues");
  await spot(p, ".modes");
  await caption(p, "Pick a league: fifteen minutes, an hour, a day, a week, a month, or the Open league.");
  await wait(2.2);
  await p.locator(".modes button", { hasText: "1 week" }).click().catch(() => {});
  await wait(2.2);
  await p.locator(".modes button", { hasText: "15 min" }).click().catch(() => {});
  await wait(2);

  scene("chart");
  await spot(p, ".chart-card");
  await caption(p, "Every trade of the round is marked on the chart, read from the program's events.");
  await wait(6);

  scene("ticket");
  await spot(p, ".ticket");
  await caption(p, "Go long or short with your wallet. Trades fill on chain at the median of four exchanges, held within 1% of Pyth.");
  await wait(5.5);

  scene("board");
  await glide(p, ".lower", 70);
  await spot(p, '[aria-label="Leaderboard"]');
  await caption(p, "A Solana program keeps the books. Only players who trade are ranked, and every return is measured against the market.");
  await wait(7);

  const hasThoughts = await p.locator(".reasons .reason").count();
  scene("thoughts");
  await spot(p, ".reasons");
  await caption(
    p,
    hasThoughts
      ? "Each agent writes its reason into the trade. The program stores the reason's hash, so nobody can edit it later."
      : "Each agent writes its reason into the trade, and the program stores the reason's hash.",
  );
  await wait(7);

  scene("duels");
  await glide(p, ".app", 0, 900);
  await p.locator(".modes button", { hasText: "Duels" }).click().catch(() => {});
  await p.waitForTimeout(1500);
  await spot(p, ".duels");
  await caption(p, "Or challenge an agent to a duel: one trade each, closed whenever you like. The better return wins.");
  await wait(7);
  await p.locator(".modes button", { hasText: "15 min" }).click().catch(() => {});
  await p.waitForTimeout(600);

  scene("agents");
  await glide(p, ".agents", 70);
  await spot(p, null);
  await p.locator(".agents details summary").first().click().catch(() => {});
  await caption(p, "Each agent runs on Claude, with its own wallet and its own style. Its full prompt is on the page.");
  await wait(6.5);

  const first = p.locator(".reasons .reason").first();
  const tx = hasThoughts ? await first.locator(".foot a").getAttribute("href") : null;
  const reason = hasThoughts ? ((await first.locator("blockquote").textContent()) ?? "").trim() : "";
  const endCard = `<h1>Turing Pit</h1><p>Play at <b>${site}</b></p><p>Code at <b>github.com/imDev2023/turing-pit</b></p><p>Built for the MLH x Solana hackathon</p>`;
  if (tx) {
    // Explorer reads the transaction over the public RPC, which can take a long time to answer a
    // GitHub runner (429s). The recording pauses while Explorer loads, and the scene is left out
    // if the memo never shows, so the video never sits on a loading page.
    await caption(p, "");
    await wait(0.6);
    await cdp.send("Page.stopScreencast");
    const pausedAt = Date.now() / 1000;
    let memo = null;
    for (let attempt = 1; attempt <= 2 && !memo; attempt++) {
      try {
        await p.goto(tx, { waitUntil: "domcontentloaded", timeout: 45_000 });
        // The memo is the reason's plain text, so look for its opening words.
        const found = reason.length >= 12 ? p.getByText(reason.slice(0, 32), { exact: false }).first() : p.getByText(/memo/i).first();
        await found.waitFor({ timeout: 60_000 });
        memo = found;
      } catch (e) {
        console.log(`Explorer didn't show the memo (try ${attempt}): ${e.message.split("\n")[0]}`);
      }
    }
    // Without the memo, go back to the arena, so the end card has the arena's fonts.
    if (!memo) await p.goto(url, { waitUntil: "load", timeout: 60_000 }).catch(() => {});
    await prepare(p);
    await card(p, memo ? `<p>And every reason is in its transaction on <b>Solana Explorer</b>.</p>` : endCard);
    await p.waitForTimeout(800); // let the card fade in before the recording resumes
    await cdp.send("Page.startScreencast", SCREENCAST);
    gaps.push([pausedAt, Date.now() / 1000]);
    if (memo) {
      scene("explorer");
      await wait(2.4);
      await card(p, "");
      await wait(1);
      await memo.evaluate((el) => el.setAttribute("data-wt", "memo"));
      await glide(p, '[data-wt="memo"]', 160, 1600);
      await caption(p, "The agent's reason, as an SPL Memo in the same transaction as its trade.");
      await wait(6);
    } else {
      console.log("left the Explorer scene out of the walkthrough");
    }
  }

  await caption(p, "");
  scene("end");
  await card(p, endCard);
  await wait(5.5);
  await cdp.send("Page.stopScreencast");
  const ended = Date.now() / 1000;
  console.log(`walkthrough RPC errors: ${p.rpcErrors().join(", ") || "none"}`);
  await context.close();

  // ffmpeg's concat demuxer takes each frame for as long as the page showed it, less any pause.
  const paused = (a, b) => gaps.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
  const kept = frames.filter((f) => f.t >= started - 1 && !gaps.some(([from, to]) => f.t > from && f.t < to));
  const lines = ["ffconcat version 1.0"];
  kept.forEach((f, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].t : ended;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t - paused(f.t, next)).toFixed(4)}`);
  });
  lines.push(`file '${kept.at(-1).file}'`);
  const list = join(framesDir, "list.ffconcat");
  writeFileSync(list, lines.join("\n") + "\n");
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", join(out, "walkthrough.mp4")],
    { stdio: "inherit" },
  );
  console.log(`walkthrough.mp4: ${kept.length} frames over ${(ended - started - paused(started, ended)).toFixed(1)} s`);
  timeline.push({ scene: "length", at: Number((ended - started - paused(started, ended)).toFixed(2)) });
  writeFileSync(join(out, "timeline.json"), JSON.stringify(timeline, null, 1) + "\n");
  console.log("timeline", JSON.stringify(timeline));
}

// The walkthrough first, while the public RPC still answers this runner readily.
if (video) await walkthrough();

// Desktop: the first screen, the whole page and the main panels.
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await openArena(desk);
await page.screenshot({ path: join(out, "desktop.png") });
await page.screenshot({ path: join(out, "desktop-full.png"), fullPage: true });
for (const [name, sel] of [
  ["strip", ".strip"],
  ["terminal", ".terminal"],
  ["chart", ".chart-card"],
  ["ticket", ".ticket"],
  ["board", '[aria-label="Leaderboard"]'],
  ["reasons", ".reasons"],
  ["history", '[aria-label="Recent rounds"]'],
  ["agents", ".agents"],
]) {
  const el = page.locator(sel).first();
  if (await el.count()) await el.screenshot({ path: join(out, `${name}.png`) });
}
const facts = { ...(await describe(page)), rpcErrors: page.rpcErrors() };
// The duels screen.
await page.evaluate(() => window.scrollTo(0, 0));
await page.locator(".modes button", { hasText: "Duels" }).click().catch(() => {});
await page.waitForTimeout(6_000);
await page.screenshot({ path: join(out, "duels.png") });
writeFileSync(join(out, "page.json"), JSON.stringify(facts, null, 2) + "\n");
console.log(JSON.stringify(facts, null, 2));
await desk.close();

// Phone.
const phone = await browser.newContext({ ...devices["iPhone 13"] });
const phonePage = await openArena(phone);
await phonePage.screenshot({ path: join(out, "phone.png") });
await phonePage.screenshot({ path: join(out, "phone-full.png"), fullPage: true });
console.log(`phone page RPC errors: ${phonePage.rpcErrors().join(", ") || "none"}`);
await phone.close();

await browser.close();
