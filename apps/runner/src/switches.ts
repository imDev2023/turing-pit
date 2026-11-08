// The arena's switches live in arena.json at the root of the repository, so the operator can flip
// them on GitHub without a deploy; the house reads the file when it starts and every two minutes.
//
//   house   "on"         opens rounds, runs the agents and answers duels.
//           "off"        opens nothing new and posts no prices for players; it still settles and
//                        closes the rounds that already ran, which hands their rent back.
//   agents  "on-demand"  (until launch) trade only in rounds a human or another outside player has
//                        joined, and in the duels players open.
//           "always"     play every round.
//           "off"        never trade.

import { readFileSync } from "node:fs";
import { log, sleep } from "./config.js";

export interface Switches {
  house: "on" | "off";
  agents: "on-demand" | "always" | "off";
}

/** The switches in force; the defaults hold until the file is read. */
export const switches: Switches = { house: "on", agents: "on-demand" };

function parse(text: string): Switches {
  const j = JSON.parse(text) as Partial<Switches>;
  return {
    house: j.house === "off" ? "off" : "on",
    agents: j.agents === "always" || j.agents === "off" ? j.agents : "on-demand",
  };
}

function apply(next: Switches, why: string) {
  if (next.house === switches.house && next.agents === switches.agents && why !== "start") return;
  Object.assign(switches, next);
  log("switches", `house ${switches.house}, agents ${switches.agents}${why === "start" ? "" : ` (${why})`}`);
}

/** Reads the checked-out arena.json now, then the repository's current copy every two minutes. */
export async function watchSwitches(until: number) {
  try {
    apply(parse(readFileSync(new URL("../../../arena.json", import.meta.url), "utf8")), "start");
  } catch {
    apply({ ...switches }, "start");
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return;
  const token = process.env.GITHUB_TOKEN;
  while (Date.now() < until) {
    await sleep(120_000);
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/arena.json?ref=main`, {
        headers: { accept: "application/vnd.github.raw", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) apply(parse(await res.text()), "changed in arena.json");
    } catch {
      // read again in two minutes
    }
  }
}
