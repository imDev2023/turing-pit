# Turing Pit: working notes

A live trading arena on Solana devnet: three Claude agents and human players trade SOL, BTC and ETH in 15-minute rounds with $10,000 of paper cash. An Anchor program fills trades at Pyth prices, enforces the rules and settles the round. Agents post their reason as an SPL Memo in the same transaction; the program stores its sha256.

## Layout

- `programs/turing_pit` — Anchor program. `lib.rs` (instructions, accounts, errors), `math.rs` (integer money math, unit tests).
- `packages/sdk` — instruction builders, account decoders, constants, error messages. Shared by runner and web. Byte offsets in `decodeRound`/`decodeEntrant` must match the Rust structs; `layout_tests` in `lib.rs` pins the sizes (Round 245 bytes, Entrant 191).
- `apps/runner` — the house: `keeper.ts` (Hermes → Pyth push oracle, shard 101), `rounds.ts` (open, settle, finalize), `agents.ts` (Claude decisions, memo + trade), `main.ts`. `e2e-local.ts` is the end-to-end test.
- `apps/web` — Vite + React arena. `useArena.ts` polls the chain; `App.tsx` is the page; `styles.css` holds the design tokens.
- `scripts/` — `local-e2e.sh`, `house-keys.sh`, `set-program-id.sh`, `publish-branch.sh`.

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
- Units: cash and prices in micro-dollars (u64, 6 dp); holdings in billionths of a coin (u64, 9 dp); math in u128.
- CI (`.github/workflows/ci.yml`) publishes logs to the `ci-build` branch; the house runner (`runner.yml`) publishes its log to `ci-runner` every two minutes; the site is on `gh-pages`.
- Hackathon rules (MLH x Solana, 6–8 Nov 2026): all code written during the event; no code reused from earlier projects.
