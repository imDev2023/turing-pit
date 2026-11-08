# Turing Pit: working notes

A live trading arena on Solana devnet: three Claude agents and human players trade SOL, BTC and ETH, long or short, in six leagues (15 minutes, 1 hour, 1 day, 1 week, 1 month and an Open league with no end) with $10,000 of paper cash. An Anchor program fills trades at Pyth prices, enforces the rules and settles the round. Agents post their reason as an SPL Memo in the same transaction; the program stores its sha256.

## Layout

- `programs/turing_pit` — Anchor program. `lib.rs` (instructions, accounts, errors), `math.rs` (integer money math, unit tests).
- `packages/sdk` — instruction builders, account and `Traded` event decoders, `replayFills` (positions with average entry), leagues (`roundIdAt`, `roundTimes`), constants, error messages. Shared by runner and web. Byte offsets in `decodeRound`/`decodeEntrant` must match the Rust structs; `layout_tests` in `lib.rs` pins the sizes (Round 251 bytes, Entrant 191).
- `apps/runner` — the house: `keeper.ts` (with `PYTH_API_KEY`: Hermes → Pyth push oracle, shard 101; without: reads Pyth's sponsored devnet feeds, shard 0), `rounds.ts` (open on the keeper's price source, settle, finalize, close old player accounts and then old rounds), `agents.ts` (Claude decisions in every league, memo + trade), `rpc.ts` (the paced fetch every devnet request goes through, and `land`, which confirms by polling instead of websockets), `main.ts`. `e2e-local.ts` is the end-to-end test; `live-local.ts` (via `scripts/live-local.sh`, needs devnet and Hermes access) runs the real keeper and Claude against copies of Pyth's devnet programs.
- `apps/web` — Vite + React arena. `useArena.ts` polls the chain for the chosen league (board, fills, the player's own fills, last round); `market.ts` reads Coinbase candles and its live ticker for the chart; `Chart.tsx` wraps Lightweight Charts (keep its TradingView logo); `App.tsx` is the page; `styles.css` holds the design tokens.
- `scripts/` — `local-e2e.sh`, `live-local.sh`, `house-shift.sh`, `house-keys.sh`, `set-program-id.sh`, `publish-branch.sh`, `shots.mjs` (Playwright screenshots and a captioned walkthrough of the live site; run by `shots.yml`, published to `ci-shots`).

## Commands

```bash
pnpm install
pnpm -r typecheck
cargo test -p turing_pit --lib
scripts/local-e2e.sh                     # needs cargo-build-sbf and solana-test-validator on PATH
pnpm --filter @turing-pit/web build      # needs VITE_PROGRAM_ID and VITE_AUTHORITY for a working site
```

## Rules of the road

- Every house key derives from the `PIT_SEED` secret (`apps/runner/src/keys.ts`). Never print, log or commit private keys or keypair files. Only public addresses go into logs and the `ci-*` branches.
- `declare_id!` is written at build time by `scripts/set-program-id.sh`; the committed value is the devnet program id once known.
- Toolchain: Agave 2.3.13, whose platform-tools v1.48 ship cargo 1.84. Keep `rust-version = "1.84"` in the program's Cargo.toml and the fallback resolver in `.cargo/config.toml`, so `cargo update` never pulls edition-2024 crates the SBF build can't parse.
- Anchor errors are numbered from 6000 in enum order and mirrored by `PIT_ERRORS` in the SDK: append new errors at the end of both.
- Units: cash and prices in micro-dollars (u64, 6 dp); positions in billionths of a coin (i64, 9 dp, negative for a short); math in u128/i128.
- The house shares the public devnet RPC with every GitHub runner on its address: keep its requests going through `politeFetch` and confirm with `land` (no websocket subscriptions); six leagues starting at once without them tripped the 429 limits for good.
- CI (`.github/workflows/ci.yml`) publishes logs to the `ci-build` branch; the house runner (`runner.yml`, one shift = `scripts/house-shift.sh`; CI's deploy job dispatches a shift, each shift dispatches the next, the cron is only a watchdog) publishes its log to `ci-runner` every two minutes; while the house has no SOL for the first deploy (or the deploy job fails), each CI run waits up to 5 hours and dispatches the next (up to 10); deploys write through a buffer whose keypair derives from `PIT_SEED`, so an interrupted deploy carries on where it stopped, and send the writes over QUIC, not `--use-rpc` (the public RPC rate-limits GitHub's runners); a bigger build first grows the program's data account with `solana program extend` by its shortfall plus 16 KiB, because devnet (solana-core 4.x) refuses extends under 10 KiB, which breaks the deploy's own auto-extend; the site deploys to GitHub Pages through Actions.
- Hackathon rules (MLH x Solana, 6–8 Nov 2026): all code written during the event; no code reused from earlier projects.
