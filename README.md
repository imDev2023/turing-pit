# Turing Pit

**Can you out-trade the machines?**

Turing Pit is a live trading arena on Solana. Three Claude agents and any human with a wallet trade SOL, BTC and ETH, long or short, head to head. Pick a league (rounds of 15 minutes, an hour, a day, a week or a month, or the Open league that never ends), or challenge an agent to a duel: one trade each, closed whenever each side likes, and the better return wins. Everyone starts with $10,000 of paper cash. A Solana program fills every trade at the live price (the median of Binance, Coinbase, OKX and Hyperliquid, which the program keeps only within 1% of Pyth), enforces the rules, marks every account to market and records every winner.

Every agent trade carries its reason in the same transaction, and the program stores the reason's SHA-256 hash. Anyone can check what an AI did, at what price, and why, and that the "why" was not rewritten afterwards.

- **Play:** https://imdev2023.github.io/turing-pit/ (Solana devnet; spectating needs no wallet)
- **Demo:** [a one-minute narrated walkthrough](https://imdev2023.github.io/turing-pit/demo.mp4) of the live arena
- **Program:** [`8NYspkeqiqVUKtbaUNSHTVCiyzDx4TpRnA9Rr6QXbfgX`](https://explorer.solana.com/address/8NYspkeqiqVUKtbaUNSHTVCiyzDx4TpRnA9Rr6QXbfgX?cluster=devnet) on devnet
- **Tracks:** AI, DeFi, Gaming. Built solo for the MLH x Solana hackathon, 6 to 8 November 2026. Everything here was written during the event.

![The live arena on devnet, 8 November 2026: league tabs, the round clock and fill prices, the chart with the round's trades, the ticket, the leaderboard and the agents' reasons](docs/arena.png)

## Why this exists

AI trading agents are everywhere, and nobody can check them. A track record is a screenshot, and the reasoning is whatever the bot's owner says after the fact.

Turing Pit makes both public and tamper-evident:

- **The record:** every fill happens inside a program, at a price the program reads itself and holds to Pyth, under rules nobody can bend, including the house.
- **The reasoning:** each trade's reason is posted in the same transaction as the trade, and its hash is stored in program state. The arena recomputes the hash in your browser and shows whether it matches.
- **The benchmark:** humans play in the same rounds under the same rules, so "machines vs humans" is a scoreboard, not a claim. The board also shows each player's return against simply holding the market.

It is also a game: a 15-minute round is long enough to think and short enough to come back for another, and the week and month leagues are for swing traders.

## How it plays

| League | A round runs | Trading stops |
| --- | --- | --- |
| 15 min | every quarter hour | after 14 minutes |
| 1 hour | every hour, on the hour (UTC) | a minute before the hour |
| 1 day | 00:00 to 24:00 UTC | a minute before midnight |
| 1 week | Monday to Sunday, UTC | a minute before Monday |
| 1 month | the calendar month, UTC | a minute before the 1st |
| Open | from 8 November 2026, with no end | never (on chain, a ten-year round) |

- **Long or short.** Buy to go long (or to cover a short), sell to cut a long, and sell more than you hold to go short. Close flattens a whole position at once. A trade costs 0.1% and starts at $10.
- **Risk limits.** No position, long or short, may be worth more than half your equity, and an account whose equity is gone can only reduce or close positions. Final equity can't go below zero.
- **No need to close.** When trading stops, every open position is marked at the closing price.
- **Only traders win.** The program ranks only players who traded, so sitting on $10,000 of cash never wins. If nobody traded, nobody wins.
- **Join any time** until 30 seconds before trading stops; you start with $10,000 like everyone else. The Open league takes any number of players, the others 24 per round.
- **The Open league** never ends, so it has standings rather than a winner: whoever has the highest equity among players who traded leads. For a decided result on your own timeline, play a duel.

### Duels

A duel is decided by one trade, not by a clock.

1. Pick a style and an opponent: **Scalp** (a trade may stay open up to 15 minutes), **Swing** (7 days) or **Long-term** (30 days), against Momentum, Contrarian, Degen or any of them.
2. Open your trade: a coin, long or short, up to $9,900 of a $10,000 stake. The agent opens its own, with its reason on chain.
3. Each side closes its trade when it likes; a closed trade is final. A trade still open at the style's limit is marked at the closing price.
4. The program decides the duel as soon as both trades are closed: the higher return wins, and the result is recorded on chain.

![The duel screen: the new-duel form, and each duel's two trades side by side](docs/duels.png)

## The arena

One screen per league: the round's clock and the prices trades fill at; a candle chart (TradingView's Lightweight Charts, Coinbase candles updated trade by trade) with every fill of the round marked from the program's `Traded` events; the ticket with your equity, return, rank and positions (entries rebuilt in the browser from your fills, shown only when the replay matches the chain); the leaderboard with each return against an equal mix of SOL, BTC and ETH held since joining; and the agents' reasons, each checked against the hash on chain. The Duels screen holds the duel form and every duel's two trades side by side.

The design follows one rule: no taglines, helper text or secondary labels. Gold squares are humans, violet dots are agents, green and red only mean up and down, and a screen that needed an explanation got a better layout instead. For agents there is [`llms.txt`](https://imdev2023.github.io/turing-pit/llms.txt): the program, the accounts and how to play, in plain text.

## How a round works on chain

1. The house opens each league's rounds on schedule (`create_round`, up to ten years long). Each round names its price source when it is created.
2. Players join with $10,000 of paper cash (`join_round`). Agents need the house to co-sign their join, so the board can label which players are AI.
3. `trade` buys, sells or closes SOL, BTC or ETH at the round's live price. The program checks the price account's owner and address (and a Pyth account's feed id), and that the price is within the round's age limit, then the cash, the 50% cap on either side and the bust rule.
4. When trading ends, `settle` marks each player to market. `finalize_round` takes every player of the round exactly once and records the winner among those who traded, the best human and the best agent.
5. `close_entrant` returns a finished player account's rent to the player: the player can close it as soon as the round is final, anyone else three hours later. Six hours after a round ends, once every player account is closed, `close_round` returns the round's own rent to the house. Every result stays in the round's transactions and events.

Long rounds outlive any one price source, so the house can move a running round to another source (`set_price_source`); it can't touch prices, fills or results. A round that ended on a source that has since stopped is moved the same way ten minutes after its end, so it can still be settled; its open positions are then marked at the new source's price.

## Verifiable reasoning

```
one transaction
├─ SPL Memo:  "SOL up 0.8% in 5 minutes while BTC is flat. Riding relative strength…"
└─ turing_pit::trade(asset, side, usd, reason_hash = sha256(memo))
     └─ stores reason_hash on the player's account and emits it in the Traded event
```

The arena reads both instructions from the chain, hashes the memo in the browser and shows **Matches the hash stored on chain** next to each agent's reasoning, with the price it filled at and a link to the transaction. The same works for humans: your own reason (optional) goes on chain with your trade.

<p align="center"><img src="docs/reasons.png" width="420" alt="The arena's feed of agent reasons, each marked as matching the hash stored on chain"></p>

The first of those reasons in its transaction on Solana Explorer: the SPL Memo (#3) right before the arena's trade instruction (#4, which logs `Instruction: Trade`; Explorer calls it an unknown program because the IDL isn't published on chain).

![An agent's trade on Solana Explorer: the reason as an SPL Memo, followed by the Turing Pit trade instruction](docs/explorer-memo.png)

## Architecture

```
  Binance · Coinbase · OKX · Hyperliquid                           Coinbase market data
  (every 2 s, free; on chain only during play)               (chart candles, live ticks)
┌───────────────────▼──────────────────┐        ┌──────────────────▼───────────┐
│ apps/runner  (the house)             │        │ apps/web  (the arena)        │
│  • price keeper → house feed         │        │  React + Vite, reads chain   │
│  • round manager: open, settle and   │        │  directly; wallet adapter    │
│    finalize six leagues              │        │  for human players; charts   │
│  • 3 Claude agents, one wallet each, │        │  by Lightweight Charts       │
│    in every league and every duel    │        └──────────────┬───────────────┘
└───────────────────┬──────────────────┘                       │
                    │ transactions                              │ reads + trades
┌───────────────────▼───────────────────────────────────────────▼──────────────┐
│ programs/turing_pit  (Anchor, Solana devnet)                                 │
│  create_round · open_duel · join_round · trade · settle · finalize_round ·   │
│  post_prices · set_price_source · close_*                                    │
│  Round, Entrant and HouseFeed accounts · reads Pyth accounts directly        │
└──────────────────────────────────────────────────────────────────────────────┘
packages/sdk: instruction builders, account and event decoders, leagues and constants shared by runner and web
```

### Prices

Each round names its price source when it opens: the three accounts it reads and the oldest price a trade may fill at.

- **The house's prices (the default).** Every 2 seconds the house reads the best bid and ask of SOL, BTC and ETH on Binance and OKX (USDC books), Coinbase (USD) and Hyperliquid (perpetuals), for free, and takes the median of the mids. It puts that median on chain (`post_prices`, into its `HouseFeed` account) only when a game needs a price, so a quiet arena spends nothing on prices:
  - first in each of its agents' trades and in every settlement, so those transactions carry their own fresh price;
  - every 2 seconds while a player is trading: any player's transaction on the feed account (every trade on these prices reads it) keeps the house posting for ten minutes. When a trade finds the price stale, the site sends a tiny transaction on the feed account, waits a few seconds for a fresh price and sends the trade again.

  The program keeps a posted price only within 1% of a verified Pyth price at most 10 minutes old, so the house can't post a price far from the market; a price that fails keeps the coin's last one. Trades need a house price under 20 seconds old.
- **Pyth's sponsored feeds (shard 0).** The 1% check reads the feeds Pyth updates itself on devnet, about every 5 minutes, which cost the arena nothing. Rounds fall back to them (prices up to 7 minutes old) if no exchange answers.
- **The house's Pyth shard (101), optional.** With `PYTH_PUSH=1` and a Pyth API key (Hermes needs one since Pyth's Core upgrade in August 2026), the keeper also posts Wormhole-signed updates every 10 seconds into its own shard of push-oracle accounts, which the 1% check and the fallback then read. It's off by default because it costs SOL around the clock.

New rounds and duels start on the house's prices while the exchanges answer, and running rounds of a day or more follow the source once it has been stable for ten minutes. Marking the rest of a portfolio, and settlement, accept prices up to 5 minutes old, or the round's own limit if that is longer. Between trades the arena marks positions at Coinbase's live quotes; nothing fills at them.

### Agents

Three agents with different styles: Agent Momentum, Agent Contrarian and Agent Degen. They run on Claude (`claude-haiku-5-5` by default, set `AGENT_MODEL` to change it). They play every league and answer every duel, deciding about every 2 minutes in the 15-minute league, every 10 minutes in the hourly one, hourly in the daily one, every 4 hours in the weekly one, every 12 hours in the monthly one and every 6 hours in the Open league. Each decision gets a snapshot: prices with their 1-minute, 5-minute and 1-hour change (and the 24-hour range in the long leagues), its cash and positions, how much it can still buy or sell under the cap, the leaderboard and the time left. It answers with a single `decide` tool call (buy, sell, close or hold, the coin, the size and a reason of at most 200 characters). The runner clamps the order to the program's rules and sends the memo and the trade together.

### Units

Cash and prices are micro-dollars (6 decimals); positions are billionths of a coin (9 decimals), signed, negative for a short. All program math is integer, in `u128` and `i128` where products can overflow.

### Living with the public RPC

The house talks to the public devnet endpoint, which allows an address 100 requests and 40 new connections per 10 seconds, and GitHub's runners share addresses. All of the house's requests go through one paced queue (four in flight, one every 110 ms at most, every 429 pausing the queue), and transactions are confirmed by polling rather than over websockets, whose reconnects after a 429 use up the connection allowance on their own. The site reads transactions one at a time, a few a second.

## Play

1. Open the arena and connect Phantom, Solflare or Backpack set to **devnet**.
2. Get free devnet SOL at [faucet.solana.com](https://faucet.solana.com). Each trade costs a fraction of a cent in fees.
3. Pick a league and place a trade, long or short, with your own reason if you like. Your first trade joins the round and funds a session wallet kept in your browser, in one approval; after that the session wallet signs every trade, close and duel, so your wallet doesn't ask again.

## Run it yourself

Needs Node 22, pnpm 10, Rust and the Solana CLI (Agave 2.3).

```bash
pnpm install
cargo test -p turing_pit --lib          # program unit tests
scripts/local-e2e.sh                     # build, start a local validator, run the end-to-end test
```

`scripts/local-e2e.sh` builds the program, starts `solana-test-validator` with Pyth price accounts preloaded, and checks the whole game: joins, agent registration, buys, sells, shorts and closes, the fee, the 50% cap on both sides, the $10 minimum, price age limits, fake price accounts, the house's prices (the 1% check against Pyth, a dropped price, fills, staleness, a duel opened on them), the join cutoff, week-long and ten-year rounds, moving a round's price source, settlement, finalization (only traders win), positions rebuilt from `Traded` events, duels (one trade each, early settlement and an early decision, one seat per side) and closing player accounts, then runs the house's duel manager, round manager and an agent (with a stub in place of Claude) against the live schedule of every league.

`scripts/live-local.sh` checks what that test fakes. It starts a local validator with copies of Pyth's receiver, push oracle and Wormhole programs and Pyth's sponsored price accounts from devnet, trades on those accounts, runs the real keeper against Hermes when `PYTH_API_KEY` is set, and has each agent make one real Claude decision when `ANTHROPIC_API_KEY` is set. It needs network access to devnet and Hermes, and spends no devnet SOL. CI runs it on every push (`.github/workflows/live.yml`, log on the `ci-live` branch).

### Switches

`arena.json` at the root of the repository holds two switches, which the house reads when it starts and every two minutes after, so they take effect without a deploy:

| Switch | Values |
| --- | --- |
| `house` | `on` opens rounds, runs the agents and answers duels; `off` opens nothing new and posts no prices for players, but still settles and closes the rounds that already ran, which hands their rent back |
| `agents` | `always` (the current setting): play every round and every duel; `on-demand`: trade only in rounds a human or another outside player has joined, and in duels; `off`: never trade |

### Deployment

Every house key derives from one secret, `PIT_SEED` (16+ random characters): the deployer, which is also the round authority and the keeper's payer, the program address, the deploy buffer and the three agent wallets. Nothing else is stored, and no keypair is committed.

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

GitHub Actions does all of this on every push to `main` (`.github/workflows/ci.yml`): typecheck, unit tests, the end-to-end test, the devnet deploy and the arena site on GitHub Pages. `.github/workflows/runner.yml` runs the house in shifts of about 5 h 40 min (`scripts/house-shift.sh`): CI starts one after each deploy that changed the house's code, and each shift starts the next. Build and runner logs, with public addresses only, are published to the `ci-build` and `ci-runner` branches.

Repository settings it needs: secrets `PIT_SEED` and `ANTHROPIC_API_KEY`, optionally `PYTH_API_KEY` (from [Pyth](https://app.pyth.com/signup); used only with the variable `PYTH_PUSH=1`, for a Pyth check every 10 seconds instead of every 5 minutes) and `RPC_URL` (a private devnet RPC), and Settings > Pages > Source set to GitHub Actions. CI starts the first deploy once the deployer address holds about 1.95 devnet SOL; on devnet in November 2026 the deploy spent 1.36 SOL, the rent for the 260 KB program plus fees. After that the house mostly pays fees, a few hundredths of a SOL a day including the agents' trades, because player accounts are closed three hours after their round and round accounts six hours after it, so their rent comes back. Prices cost nothing while nobody plays: they ride in the agents' trades and the settlements, and the house posts on its own (about 0.0015 SOL per ten minutes) only while a player is trading. Posting Pyth updates every 10 seconds (`PYTH_PUSH=1`) would add roughly 0.15 SOL a day. Until it has enough, CI publishes the address and its balance to the `ci-build` branch, keeps waiting (a new run takes over every five hours, for up to two days) and deploys as soon as the SOL arrives.

The deploy writes through a buffer at a fixed address derived from `PIT_SEED`, so if devnet drops it partway, the next try carries on from what was already written. Its ~270 writes go straight to the leaders over QUIC: the public RPC rate-limits GitHub's shared runner addresses, and sending the writes through it stalled the first deploy after ten. Devnet (solana-core 4.x) refuses to grow a program by less than 10 KiB at a time, which breaks the CLI's own auto-extend when a new build is a few KB bigger, so CI grows the program's data account first, by the shortfall plus 16 KiB.

## Program reference

| Instruction | Who | What it checks |
| --- | --- | --- |
| `create_round(round_id, start_ts, end_ts, start_cash, fee_bps, max_asset_bps, shard_id, max_price_age)` | house | schedule up to ten years, fee ≤ 1%, cap 10–100%, sane start cash, price age 10 s to 15 min |
| `open_duel(round_id, style, shard_id, max_price_age)` | any player (pays the rent) | a duel id carrying its style; the round runs from now for the style's limit, $10,000 each, one position may use the whole stake |
| `join_round(kind, label)` | player (+ house for agents) | round open, at most 24 players (no limit in rounds over 40 days; a duel seats one human and one agent), joins close 30 s before the end |
| `trade(asset, side, usd, reason_hash)` | player | round live, fresh prices; buy: cash; sell: past the holding opens a short; close: a position to close; anything that adds risk: equity above zero and the position, long or short, within 50% of equity; $10 minimum; in a duel, one opening trade and then one close |
| `settle()` | anyone | round over, or in a duel once the player's trade is closed; marks the player's equity once, floored at zero; a flat account needs no prices |
| `finalize_round()` + every entrant | anyone | each entrant once, all settled; round over, or a duel whose two trades are both settled; records the winner among traders, best human, best agent |
| `set_price_source(shard_id, max_price_age)` | house | round not finalized; a valid age limit; shard 65535 is the house's feed |
| `post_prices(prices, sources)` + a Pyth account per coin | house | keeps each price within 1% of its coin's verified Pyth price at most 10 minutes old, the others keep their last price; fails if none is kept |
| `close_entrant()` | the player, or anyone 3 h after the round | round finalized; the rent goes back to the player |
| `close_round()` | house | round finalized, every player account closed, 6 h after the end; the rent goes back to the house |

Accounts: `Round` (PDA `["round", authority, round_id]`), `Entrant` (PDA `["entrant", round, player]`) and `HouseFeed` (PDA `["house_feed", authority]`: a price, the time it was kept and how many exchanges it came from, per coin). Round ids: 15-minute rounds use `unix_time / 900`; every other league's ids start at `league × 2^40` (see `roundIdAt` in the SDK), and duels at `6 × 2^40`, with the style and the challenged agent in the id. Events: `RoundCreated`, `Joined`, `Traded`, `Settled`, `Finalized`, `PriceSourceChanged`.

## Limits, honestly

- Paper money on devnet. Nothing here is investment advice or a real market.
- Shorts are simple: no borrow cost and no funding, and a short that runs against you is limited only by the 50% cap and the bust rule, not by liquidation.
- Trades fill at the posted price with a flat fee: no order book, no slippage, no spread. Market orders only for now.
- The house posts the prices trades fill at. The program holds each to 1% of Pyth, but within that band the house is trusted to post the true median, and a player who sees the exchanges move can trade on a price up to a few seconds old. A player's first trade after a quiet spell waits a few seconds for a fresh price. Verifiable exchange prices (Switchboard On-Demand) would remove the trust.
- The house runs the agents and the keeper. The program limits what it can do (it cannot set fills or results, or prices beyond the band), but it could decline to send an agent's trade or let its keeper stall. Reasons are tamper-evident after the fact; the agent's prompt is published in this repository, not attested on chain.
- The 1% check reads Pyth's sponsored devnet feeds, which move about every 5 minutes, so a fast market can briefly push the median outside the band; that coin then keeps its last price until Pyth catches up.
- Players who join a long round late start with fresh cash, and anyone can see the board before joining, so a late joiner knows the score to beat. Risk-adjusted scoring (below) is the fix.
- Player accounts are closed three hours after their round and round accounts after six, so their rent comes back. Older results live in each round's transactions and events, not in account state.

## Roadmap

What it would take to turn the arena into a serious trading venue, roughly in order.

### Trading

- **Perpetuals with leverage.** Margin per position, a maintenance margin, liquidations by permissionless keepers who earn a fee, and funding paid between longs and shorts every hour from the gap between the perp's mark and the oracle.
- **Order types.** Limit, stop, take-profit, trailing stop and bracket (one-cancels-other) orders stored on chain and executed by keepers when the Pyth price crosses, with the program checking the price itself.
- **Fair fills.** Fill at the first oracle update after the order rather than the last one before it, so nobody trades on a price they already know; use Pyth's confidence interval as the spread, and add size-dependent slippage.
- **More markets.** Every Pyth feed: majors, SOL ecosystem tokens, FX, gold and equities, with per-market caps.

### Scoring and competition

- **Risk-adjusted rankings.** Sharpe and Sortino ratios from equity snapshots taken through the round, maximum drawdown and return against the market, so a lucky all-in gamble doesn't beat steady skill.
- **Ratings, seasons and divisions.** A Glicko-2 rating per player across rounds, monthly seasons, and divisions with promotion and relegation.
- **Challenges.** Prop-firm style evaluations: reach +8% without breaching a 5% daily loss or a 10% overall drawdown.
- **Duels and tournaments.** One-on-one matches against a chosen agent, brackets, and private leagues for a group of friends or a trading desk.
- **Settlement on a time-weighted price** over the last minutes, so a last-second spike can't decide a round.

### Agents

- **Duels with stakes.** A USDC pot per duel, the winner taking it less a small rake, once there is legal footing for it.
- **Bring your own agent.** An on-chain registry where anyone can enter an agent: its wallet, its model and a commit-reveal hash of its prompt, revealed at the end of the season.
- **Structured calls.** Each trade carries a direction, a target, a stop and a probability, scored for calibration (Brier score) as well as profit.
- **Model leaderboard.** The same strategy prompt run on different models, ranked on chain.
- **Copy trading and vaults.** Follow an agent's trades, with your own limits, once there is real money and the legal footing for it.

### Terminal

- Multiple charts and indicators, price alerts, an equity curve for each player, trade history with export, keyboard shortcuts and a mobile layout built for one-handed trading.

### Integrity

- **One human, one seat** for prize rounds, with proof of personhood or Solana attestations, and bot detection for seats labelled human.
- **An open keeper.** Anyone can post Pyth updates and run settlement, so the arena never depends on the house.
- **Verifiable exchange prices.** Switchboard On-Demand feeds built from the same exchanges, so fills need neither the house's word nor Pyth.

### Business

- Free leagues with sponsored prizes, then paid-entry tournaments with USDC prize pools and a small rake where that is legal.
- Agent benchmarking as a service: AI trading teams prove a model's record in public, under rules nobody can bend.
- A data feed of agent decisions and reasons for researchers.

## License

MIT
