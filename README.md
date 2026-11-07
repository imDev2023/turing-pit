# Turing Pit

**Can you out-trade the machines?**

Turing Pit is a live trading arena on Solana. Three Claude agents and any human with a wallet trade SOL, BTC and ETH head to head in 15-minute rounds. Everyone starts with $10,000 of paper cash. A Solana program fills every trade at the live Pyth price, enforces the rules, marks every account to market when the round ends and records the winner.

Every agent trade carries its reason in the same transaction, and the program stores the reason's SHA-256 hash. Anyone can check what an AI did, at what price, and why, and that the "why" was not rewritten afterwards.

- **Play:** https://imdev2023.github.io/turing-pit/ (Solana devnet; spectating needs no wallet)
- **Program:** [`8NYspkeqiqVUKtbaUNSHTVCiyzDx4TpRnA9Rr6QXbfgX`](https://explorer.solana.com/address/8NYspkeqiqVUKtbaUNSHTVCiyzDx4TpRnA9Rr6QXbfgX?cluster=devnet) on devnet
- **Tracks:** AI, DeFi, Gaming. Built solo for the MLH x Solana hackathon, 6 to 8 November 2026. Everything here was written during the event.

## Why this exists

AI trading agents are everywhere, and nobody can check them. A track record is a screenshot, and the reasoning is whatever the bot's owner says after the fact.

Turing Pit makes both public and tamper-evident:

- **The record:** every fill happens inside a program, at an oracle price the program reads itself, under rules nobody can bend, including the house.
- **The reasoning:** each trade's reason is posted in the same transaction as the trade, and its hash is stored in program state. The arena recomputes the hash in your browser and shows whether it matches.
- **The benchmark:** humans play in the same rounds under the same rules, so "machines vs humans" is a scoreboard, not a claim.

It is also a game. Fifteen minutes is long enough to think and short enough to come back for another round.

## How a round works

1. The house opens a round every 15 minutes (`create_round`). Trading lasts 14 minutes; the last minute is for settlement.
2. Players join with $10,000 of paper cash (`join_round`). Agents need the house to co-sign their join, so the board can label which players are AI.
3. `trade` buys or sells SOL, BTC or ETH at the Pyth price. The program checks the price account's owner, address and feed id, and that the price is fresh. Fee 0.1%, minimum $10, long only, at most half of your equity in one coin.
4. When trading ends, `settle` marks each player to market. `finalize_round` takes every player of the round exactly once and records the winner, the best human and the best agent.

## Verifiable reasoning

```
one transaction
├─ SPL Memo:  "SOL up 0.8% in 5 minutes while BTC is flat. Riding relative strength…"
└─ turing_pit::trade(asset, side, usd, reason_hash = sha256(memo))
     └─ stores reason_hash on the player's account and emits it in the Traded event
```

The arena reads both instructions from the chain, hashes the memo in the browser and shows **Matches the hash stored on chain** next to each agent's reasoning, with a link to the transaction. The same works for humans: your own reason (optional) goes on chain with your trade.

## Architecture

```
          Hermes (signed Pyth prices)
                    │ every 10 s
┌───────────────────▼──────────────────┐        ┌──────────────────────────────┐
│ apps/runner  (the house)             │        │ apps/web  (the arena)        │
│  • price keeper → Pyth push oracle   │        │  React + Vite, reads chain   │
│  • round manager: open, settle,      │        │  directly; wallet adapter    │
│    finalize every 15 minutes         │        │  for human players           │
│  • 3 Claude agents, one wallet each  │        └──────────────┬───────────────┘
└───────────────────┬──────────────────┘                       │
                    │ transactions                              │ reads + trades
┌───────────────────▼───────────────────────────────────────────▼──────────────┐
│ programs/turing_pit  (Anchor, Solana devnet)                                 │
│  create_round · join_round · trade · settle · finalize_round                 │
│  Round and Entrant accounts · reads Pyth PriceUpdateV2 accounts directly     │
└──────────────────────────────────────────────────────────────────────────────┘
packages/sdk: instruction builders, account decoders and constants shared by runner and web
```

### Prices

Pyth pull oracle. The keeper fetches Wormhole-signed updates from Hermes every 10 seconds and posts them through Pyth's push oracle into the house's own shard (101) of price feed accounts. The house chooses only when to post, never the price: the program accepts only accounts owned by the Pyth receiver, at the push-oracle address for that shard and feed id, with a positive price. Trades need a price under 60 seconds old; marking the rest of a portfolio accepts up to 5 minutes.

### Agents

Three agents with different styles: Momentum, Contrarian and Degen. They run on Claude (`claude-haiku-5-5` by default, set `AGENT_MODEL` to change it). About every 45 seconds each one gets a snapshot: prices with 1- and 5-minute change, its cash and holdings, the leaderboard and the time left. It answers with a single `decide` tool call (buy, sell or hold, the coin, the size and a reason of at most 200 characters). The runner clamps the order to the program's rules and sends the memo and the trade together.

### Units

Cash and prices are micro-dollars (6 decimals); holdings are billionths of a coin (9 decimals). All program math is integer, in `u128` where products can overflow.

## Play

1. Open the arena and connect Phantom, Solflare or Backpack set to **devnet**.
2. Get free devnet SOL at [faucet.solana.com](https://faucet.solana.com). Each trade costs a fraction of a cent in fees.
3. Join the round, trade, and add your own reason if you like. Then watch the agents answer.

## Run it yourself

Needs Node 22, pnpm 10, Rust and the Solana CLI (Agave 2.3).

```bash
pnpm install
cargo test -p turing_pit --lib          # program unit tests
scripts/local-e2e.sh                     # build, start a local validator, run the end-to-end test
```

`scripts/local-e2e.sh` builds the program, starts `solana-test-validator` with three Pyth price accounts preloaded, and checks the whole game: joins, agent registration, buys and sells, the fee, the 50% cap, the $10 minimum, fake price accounts, the join cutoff, settlement, finalization and the winner, then runs the house's round manager and an agent (with a stub in place of Claude) against the live 15-minute schedule.

### Deployment

Every house key derives from one secret, `PIT_SEED` (16+ random characters): the deployer, which is also the round authority and the keeper's payer, the program address, and the three agent wallets. Nothing else is stored, and no keypair is committed.

```bash
export PIT_SEED=...                       # keep it secret
scripts/house-keys.sh                     # prints the public addresses
scripts/house-keys.sh --write ~/.config/solana/id.json /tmp/program.json
scripts/set-program-id.sh "$(scripts/house-keys.sh | node -p 'JSON.parse(require("fs").readFileSync(0)).programId')"
cargo-build-sbf --manifest-path programs/turing_pit/Cargo.toml
solana program deploy -u devnet target/deploy/turing_pit.so --program-id /tmp/program.json

ANTHROPIC_API_KEY=... pnpm --filter @turing-pit/runner start
VITE_PROGRAM_ID=... VITE_AUTHORITY=... pnpm --filter @turing-pit/web dev
```

GitHub Actions does all of this on every push to `main` (`.github/workflows/ci.yml`): typecheck, unit tests, the end-to-end test, the devnet deploy and the arena site on GitHub Pages. `.github/workflows/runner.yml` runs the house in six-hour shifts. Build and runner logs, with public addresses only, are published to the `ci-build` and `ci-runner` branches.

Repository settings it needs: secrets `PIT_SEED` and `ANTHROPIC_API_KEY` (optional `RPC_URL` for a private devnet RPC), and Settings > Pages > Source set to GitHub Actions. The deployer address needs about 1.9 devnet SOL for the first deploy (rent for the 255 KB program, plus fees), and roughly 1 SOL a day after that to post prices, open rounds and keep the agents' wallets topped up. Until it has enough, CI publishes the address and its balance to the `ci-build` branch and deploys as soon as the SOL arrives.

## Program reference

| Instruction | Who | What it checks |
| --- | --- | --- |
| `create_round(round_id, start_ts, end_ts, start_cash, fee_bps, max_asset_bps, shard_id)` | house | schedule under a day, fee ≤ 1%, cap 10–100%, sane start cash |
| `join_round(kind, label)` | player (+ house for agents) | round open, at most 24 players, joins close 30 s before the end |
| `trade(asset, side, usd, reason_hash)` | player | round live, fresh prices, cash, the 50% cap, $10 minimum |
| `settle()` | anyone | round over; marks the player's equity once |
| `finalize_round()` + every entrant | anyone | each entrant once, all settled; records winner, best human, best agent |

Accounts: `Round` (PDA `["round", authority, round_id]`) and `Entrant` (PDA `["entrant", round, player]`). Events: `RoundCreated`, `Joined`, `Traded`, `Settled`, `Finalized`.

## Limits, honestly

- Paper money on devnet. Nothing here is investment advice or a real market.
- The house runs the agents and the keeper. The program limits what it can do (it cannot set prices, fills or results), but it could decline to send an agent's trade. Reasons are tamper-evident after the fact; the agent's prompt is published in this repository, not attested on chain.
- Player accounts are not closed after a round yet, so their small rent deposit stays locked.

## What's next

- **Bring your own agent:** register any wallet as an agent, with a hash of its public prompt, and enter it in rounds.
- **Seasons with stakes:** USDC entry fees, prize pools and a small house rake, on mainnet with Pyth's sponsored feeds.
- **Agent track records:** win rate and risk-adjusted return across rounds, built from the program's own events.
- **More markets:** shorts and more assets.

## License

MIT
