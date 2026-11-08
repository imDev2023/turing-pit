//! Turing Pit: AI agents and humans trade the same live markets in short rounds.
//!
//! Every entrant starts a round with the same paper cash. Trades fill on chain at the
//! Pyth price for SOL, BTC or ETH, read from verified Pyth price accounts, long or short. The
//! program enforces the rules (round window, cash, a cap on any one position), records each trade
//! with a hash of the trader's stated reason, marks every entrant to market when the
//! round ends, and names the winner.

use anchor_lang::prelude::*;

pub mod math;
use math::*;

declare_id!("8NYspkeqiqVUKtbaUNSHTVCiyzDx4TpRnA9Rr6QXbfgX");

/// Pyth Solana Receiver: owns every verified PriceUpdateV2 account.
pub const PYTH_RECEIVER_ID: Pubkey =
    pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Pyth push oracle: price feed accounts live at PDAs of [shard_id (u16 LE), feed_id].
pub const PYTH_PUSH_ORACLE_ID: Pubkey =
    pubkey!("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/// First 8 bytes of sha256("account:PriceUpdateV2"), the Anchor discriminator of Pyth's
/// price update account.
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

pub const NUM_ASSETS: usize = 3;
/// Pyth feed ids for SOL/USD, BTC/USD and ETH/USD, in asset index order.
pub const FEED_IDS: [[u8; 32]; NUM_ASSETS] = [
    [
        239, 13, 139, 111, 218, 44, 235, 164, 29, 161, 93, 64, 149, 209, 218, 57, 42, 13, 47,
        142, 208, 198, 199, 188, 15, 76, 250, 200, 194, 128, 181, 109,
    ],
    [
        230, 45, 246, 200, 180, 168, 95, 225, 166, 125, 180, 77, 193, 45, 229, 219, 51, 15, 122,
        198, 107, 114, 220, 101, 138, 254, 223, 15, 74, 65, 91, 67,
    ],
    [
        255, 97, 73, 26, 147, 17, 18, 221, 241, 189, 129, 71, 205, 27, 100, 19, 117, 247, 159,
        88, 37, 18, 109, 102, 84, 128, 135, 70, 52, 253, 10, 206,
    ],
];

pub const KIND_HUMAN: u8 = 0;
pub const KIND_AGENT: u8 = 1;
/// Buy `usd` of cash worth: adds to a long, or covers a short.
pub const SIDE_BUY: u8 = 0;
/// Sell `usd` worth: reduces a long, and past zero opens or adds to a short.
pub const SIDE_SELL: u8 = 1;
/// Close the whole position in the asset, long or short (`usd` is ignored).
pub const SIDE_CLOSE: u8 = 2;

/// Longest round: ten years, which is how the Open league (a round with no practical end) is
/// made. The other leagues run from fifteen minutes to a month.
pub const MAX_ROUND_SECS: i64 = 10 * 366 * 86_400;
/// Rounds longer than this are open-ended: they take any number of players and are never
/// finalized (finalizing needs every entrant in one transaction).
pub const OPEN_ROUND_SECS: i64 = 40 * 86_400;

/// Smallest trade: $10, in micro-USD.
pub const MIN_TRADE_USD: u64 = 10_000_000;
/// How old the traded asset's price may be is set per round (`Round::max_price_age`): about a
/// minute when the house posts fresh Pyth updates every few seconds, longer on Pyth's sponsored
/// devnet feeds, which update every five minutes or so. Allowed range, in seconds:
pub const MIN_PRICE_AGE: u16 = 10;
pub const MAX_PRICE_AGE: u16 = 900;
/// Marking a portfolio (other assets in a trade, settlement) accepts prices up to 5 minutes old,
/// or the round's own limit if that is longer.
pub const MAX_PRICE_AGE_MARK: i64 = 300;
/// Entrants per round, kept small so one transaction can finalize the round.
pub const MAX_ENTRANTS: u32 = 24;
/// Joining closes 30 seconds before the round ends.
pub const JOIN_CUTOFF_SECS: i64 = 30;
/// Anyone may close a player's account (refunding its rent to the player) this long after the
/// round ends, so recent results stay readable; the player may close it as soon as it's final.
pub const CLOSE_DELAY_SECS: i64 = 3 * 60 * 60;
/// The house may close a round's account (its rent goes back to the house) this long after the
/// round ends, once every player's account is closed. The arena shows the last six hours.
pub const ROUND_CLOSE_DELAY_SECS: i64 = 6 * 60 * 60;

#[program]
pub mod turing_pit {
    use super::*;

    /// Opens a round. The authority is the house: it runs the price keeper and registers agents.
    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        start_ts: i64,
        end_ts: i64,
        start_cash: u64,
        fee_bps: u16,
        max_asset_bps: u16,
        shard_id: u16,
        max_price_age: u16,
    ) -> Result<()> {
        require!(end_ts > start_ts, PitError::BadSchedule);
        require!(end_ts - start_ts <= MAX_ROUND_SECS, PitError::BadSchedule);
        require!(fee_bps <= 100, PitError::BadParams);
        require!(
            (1_000..=10_000).contains(&max_asset_bps),
            PitError::BadParams
        );
        require!(
            (1_000_000_000..=1_000_000_000_000).contains(&start_cash),
            PitError::BadParams
        );
        require!(
            (MIN_PRICE_AGE..=MAX_PRICE_AGE).contains(&max_price_age),
            PitError::BadParams
        );

        let round = &mut ctx.accounts.round;
        round.authority = ctx.accounts.authority.key();
        round.round_id = round_id;
        round.start_ts = start_ts;
        round.end_ts = end_ts;
        round.start_cash = start_cash;
        round.fee_bps = fee_bps;
        round.max_asset_bps = max_asset_bps;
        round.shard_id = shard_id;
        for (i, feed) in FEED_IDS.iter().enumerate() {
            round.feeds[i] = price_feed_account(shard_id, feed);
        }
        round.entrants = 0;
        round.agents = 0;
        round.settled = 0;
        round.finalized = false;
        round.winner = Pubkey::default();
        round.winner_equity = 0;
        round.winner_kind = 0;
        round.best_human_equity = 0;
        round.best_agent_equity = 0;
        round.bump = ctx.bumps.round;
        round.max_price_age = max_price_age;
        round.closed = 0;

        emit!(RoundCreated {
            round: round.key(),
            round_id,
            start_ts,
            end_ts,
            start_cash,
        });
        Ok(())
    }

    /// Moves an unfinished round to another Pyth price source: the house's own shard, or Pyth's
    /// sponsored feeds. Long rounds outlive any one source, so the house switches them when its
    /// keeper starts or stops posting and trades keep filling. House only; emitted as an event.
    pub fn set_price_source(
        ctx: Context<SetPriceSource>,
        shard_id: u16,
        max_price_age: u16,
    ) -> Result<()> {
        require!(
            (MIN_PRICE_AGE..=MAX_PRICE_AGE).contains(&max_price_age),
            PitError::BadParams
        );
        let round = &mut ctx.accounts.round;
        require!(!round.finalized, PitError::AlreadyFinalized);
        round.shard_id = shard_id;
        for (i, feed) in FEED_IDS.iter().enumerate() {
            round.feeds[i] = price_feed_account(shard_id, feed);
        }
        round.max_price_age = max_price_age;
        emit!(PriceSourceChanged {
            round: round.key(),
            shard_id,
            max_price_age,
        });
        Ok(())
    }

    /// Joins a round with the round's starting cash. Agents must be co-signed by the house.
    pub fn join_round(ctx: Context<JoinRound>, kind: u8, label: [u8; 24]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round_key = ctx.accounts.round.key();
        let player_key = ctx.accounts.player.key();
        let round = &mut ctx.accounts.round;

        require!(now < round.end_ts - JOIN_CUTOFF_SECS, PitError::RoundClosed);
        require!(
            round.entrants < MAX_ENTRANTS || round.end_ts - round.start_ts > OPEN_ROUND_SECS,
            PitError::RoundFull
        );
        require!(kind == KIND_HUMAN || kind == KIND_AGENT, PitError::BadParams);
        if kind == KIND_AGENT {
            let registrar = ctx
                .accounts
                .registrar
                .as_ref()
                .ok_or(PitError::AgentNeedsRegistrar)?;
            require_keys_eq!(
                registrar.key(),
                round.authority,
                PitError::AgentNeedsRegistrar
            );
            round.agents += 1;
        }
        round.entrants += 1;

        let entrant = &mut ctx.accounts.entrant;
        entrant.round = round_key;
        entrant.player = player_key;
        entrant.kind = kind;
        entrant.label = label;
        entrant.cash = round.start_cash;
        entrant.qty = [0; NUM_ASSETS];
        entrant.trades = 0;
        entrant.joined_ts = now;
        entrant.last_trade_ts = 0;
        entrant.last_reason_hash = [0; 32];
        entrant.final_equity = 0;
        entrant.settled = false;
        entrant.bump = ctx.bumps.entrant;

        emit!(Joined {
            round: round_key,
            entrant: entrant.key(),
            player: player_key,
            kind,
            label,
        });
        Ok(())
    }

    /// Trades one asset at the live Pyth price, long or short. `usd` is micro-USD: cash to
    /// spend on a buy (which covers a short before it adds to a long), or value to sell on a
    /// sell (which past the holding opens a short). `SIDE_CLOSE` closes the whole position.
    /// Any trade that adds risk must leave the position, long or short, within the round's cap
    /// of the player's equity, and needs equity above zero; closing and reducing always work.
    /// `reason_hash` is the sha256 of the trader's stated reason, which agents post as a memo
    /// in the same transaction.
    pub fn trade(
        ctx: Context<Trade>,
        asset: u8,
        side: u8,
        usd: u64,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = asset as usize;
        require!(a < NUM_ASSETS, PitError::BadAsset);
        require!(
            side == SIDE_BUY || side == SIDE_SELL || side == SIDE_CLOSE,
            PitError::BadParams
        );
        require!(side == SIDE_CLOSE || usd >= MIN_TRADE_USD, PitError::TradeTooSmall);

        let round = &ctx.accounts.round;
        require!(
            now >= round.start_ts && now < round.end_ts,
            PitError::RoundNotLive
        );
        let prices = load_prices(
            round,
            [
                &ctx.accounts.price_sol.to_account_info(),
                &ctx.accounts.price_btc.to_account_info(),
                &ctx.accounts.price_eth.to_account_info(),
            ],
            now,
            Some(a),
        )?;
        let price = prices[a];
        let fee_bps = round.fee_bps as u64;
        let max_asset_bps = round.max_asset_bps as u64;
        let round_key = round.key();

        let entrant_key = ctx.accounts.entrant.key();
        let entrant = &mut ctx.accounts.entrant;
        let old = entrant.qty[a];
        // Each branch moves cash and returns the coins bought (+) or sold (-), the coins moved,
        // the dollars moved and the fee.
        let (delta, qty_moved, usd_moved, fee) = match side {
            SIDE_BUY => {
                // `usd` is the whole spend; the fee comes out of it.
                require!(entrant.cash >= usd, PitError::NotEnoughCash);
                let fee = mul_div(usd, fee_bps, 10_000)?;
                let qty = usd_to_qty(usd - fee, price)?;
                require!(qty > 0, PitError::TradeTooSmall);
                entrant.cash -= usd;
                (to_signed(qty)?, qty, usd, fee)
            }
            SIDE_SELL => {
                // Proceeds come in less the fee; selling past the holding opens a short.
                let qty = usd_to_qty(usd, price)?;
                require!(qty > 0, PitError::TradeTooSmall);
                let proceeds = qty_to_usd(qty, price)?;
                let fee = mul_div(proceeds, fee_bps, 10_000)?;
                entrant.cash = entrant
                    .cash
                    .checked_add(proceeds - fee)
                    .ok_or(PitError::MathOverflow)?;
                (-to_signed(qty)?, qty, proceeds, fee)
            }
            _ => {
                require!(old != 0, PitError::NothingToSell);
                let qty = old.unsigned_abs();
                let value = qty_to_usd(qty, price)?;
                let fee = mul_div(value, fee_bps, 10_000)?;
                if old > 0 {
                    entrant.cash = entrant
                        .cash
                        .checked_add(value - fee)
                        .ok_or(PitError::MathOverflow)?;
                } else {
                    // Buying a short back costs its value and the fee.
                    let cost = value.checked_add(fee).ok_or(PitError::MathOverflow)?;
                    require!(entrant.cash >= cost, PitError::NotEnoughCash);
                    entrant.cash -= cost;
                }
                (old.checked_neg().ok_or(PitError::MathOverflow)?, qty, value, fee)
            }
        };
        entrant.qty[a] = old.checked_add(delta).ok_or(PitError::MathOverflow)?;
        if adds_risk(old, entrant.qty[a]) {
            let equity = equity_of(entrant.cash, &entrant.qty, &prices)?;
            require!(equity > 0, PitError::Bust);
            require!(
                within_cap(position_value(entrant.qty[a], price)?, equity, max_asset_bps),
                PitError::PositionTooLarge
            );
        }
        entrant.trades += 1;
        entrant.last_trade_ts = now;
        entrant.last_reason_hash = reason_hash;

        emit!(Traded {
            round: round_key,
            entrant: entrant_key,
            player: entrant.player,
            asset,
            side,
            usd: usd_moved,
            qty: qty_moved,
            price,
            fee,
            reason_hash,
            ts: now,
        });
        Ok(())
    }

    /// Marks one entrant to market after the round ends. Anyone can call it.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let prices = {
            let round = &ctx.accounts.round;
            require!(now >= round.end_ts, PitError::RoundNotOver);
            load_prices(
                round,
                [
                    &ctx.accounts.price_sol.to_account_info(),
                    &ctx.accounts.price_btc.to_account_info(),
                    &ctx.accounts.price_eth.to_account_info(),
                ],
                now,
                None,
            )?
        };
        let entrant_key = ctx.accounts.entrant.key();
        let entrant = &mut ctx.accounts.entrant;
        require!(!entrant.settled, PitError::AlreadySettled);
        // A player wiped out by shorts finishes at zero.
        let equity = equity_of(entrant.cash, &entrant.qty, &prices)?.max(0);
        entrant.final_equity = u64::try_from(equity).map_err(|_| error!(PitError::MathOverflow))?;
        entrant.settled = true;
        let final_equity = entrant.final_equity;

        let round = &mut ctx.accounts.round;
        round.settled += 1;
        emit!(Settled {
            round: round.key(),
            entrant: entrant_key,
            final_equity,
        });
        Ok(())
    }

    /// Names the winner once every entrant is settled. Anyone can call it, but it must be
    /// given every entrant of the round, each once. Only players who traded can win or place;
    /// when nobody traded, the round has no winner.
    pub fn finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round_key = ctx.accounts.round.key();
        let round = &mut ctx.accounts.round;
        require!(now >= round.end_ts, PitError::RoundNotOver);
        require!(!round.finalized, PitError::AlreadyFinalized);
        require!(
            ctx.remaining_accounts.len() as u32 == round.entrants,
            PitError::MissingEntrants
        );

        let mut seen: Vec<Pubkey> = Vec::with_capacity(ctx.remaining_accounts.len());
        let mut winner = Pubkey::default();
        let mut winner_equity = 0u64;
        let mut winner_kind = 0u8;
        let mut best_human = 0u64;
        let mut best_agent = 0u64;
        for info in ctx.remaining_accounts.iter() {
            require_keys_eq!(*info.owner, crate::ID, PitError::BadEntrant);
            require!(!seen.contains(info.key), PitError::DuplicateEntrant);
            seen.push(*info.key);
            let data = info.try_borrow_data()?;
            let entrant = Entrant::try_deserialize(&mut &data[..])?;
            require_keys_eq!(entrant.round, round_key, PitError::BadEntrant);
            require!(entrant.settled, PitError::NotSettled);
            // Only players who traded can win or place: sitting in cash all round is no win.
            if entrant.trades == 0 {
                continue;
            }
            if winner == Pubkey::default() || entrant.final_equity > winner_equity {
                winner = entrant.player;
                winner_equity = entrant.final_equity;
                winner_kind = entrant.kind;
            }
            if entrant.kind == KIND_AGENT {
                best_agent = best_agent.max(entrant.final_equity);
            } else {
                best_human = best_human.max(entrant.final_equity);
            }
        }

        round.finalized = true;
        round.winner = winner;
        round.winner_equity = winner_equity;
        round.winner_kind = winner_kind;
        round.best_human_equity = best_human;
        round.best_agent_equity = best_agent;
        emit!(Finalized {
            round: round_key,
            winner,
            winner_equity,
            winner_kind,
            best_human_equity: best_human,
            best_agent_equity: best_agent,
        });
        Ok(())
    }

    /// Closes a player's account once its round is finalized; the rent always goes back to the
    /// player. The player can do it straight away, anyone else after `CLOSE_DELAY_SECS`. The
    /// round keeps its results and counts.
    pub fn close_entrant(ctx: Context<CloseEntrant>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(round.finalized, PitError::NotFinalized);
        if ctx.accounts.closer.key() != ctx.accounts.player.key() {
            let now = Clock::get()?.unix_timestamp;
            require!(
                now >= round.end_ts.saturating_add(CLOSE_DELAY_SECS),
                PitError::TooEarlyToClose
            );
        }
        round.closed = round.closed.checked_add(1).ok_or(PitError::MathOverflow)?;
        Ok(())
    }

    /// Closes a round's account once every player's account is closed and
    /// `ROUND_CLOSE_DELAY_SECS` have passed; the rent goes back to the house. The results stay
    /// in the round's transactions and events.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        let round = &ctx.accounts.round;
        require!(round.finalized, PitError::NotFinalized);
        require!(round.closed == round.entrants, PitError::PlayersStillOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= round.end_ts.saturating_add(ROUND_CLOSE_DELAY_SECS),
            PitError::RoundTooRecent
        );
        Ok(())
    }
}

/// Address of the Pyth push-oracle price feed account for a shard and feed id.
pub fn price_feed_account(shard_id: u16, feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[&shard_id.to_le_bytes(), feed_id], &PYTH_PUSH_ORACLE_ID).0
}

/// Reads all three prices (micro-USD per whole coin). `fresh` marks the asset being traded,
/// whose price must be within the round's `max_price_age`; the others are only marked.
fn load_prices(
    round: &Round,
    accounts: [&AccountInfo; NUM_ASSETS],
    now: i64,
    fresh: Option<usize>,
) -> Result<[u64; NUM_ASSETS]> {
    let mut out = [0u64; NUM_ASSETS];
    let trade_age = round.max_price_age as i64;
    for i in 0..NUM_ASSETS {
        let info = accounts[i];
        require_keys_eq!(*info.key, round.feeds[i], PitError::BadPriceAccount);
        let max_age = if fresh == Some(i) {
            trade_age
        } else {
            MAX_PRICE_AGE_MARK.max(trade_age)
        };
        out[i] = read_pyth_price(info, &FEED_IDS[i], now, max_age)?;
    }
    Ok(out)
}

/// Parses a Pyth `PriceUpdateV2` account by hand, so the program needs no Pyth crate:
/// 8-byte discriminator, write authority (32), verification level (1 or 2 bytes), then the
/// price message: feed id (32), price i64, conf u64, exponent i32, publish time i64, ...
fn read_pyth_price(info: &AccountInfo, feed_id: &[u8; 32], now: i64, max_age: i64) -> Result<u64> {
    require_keys_eq!(*info.owner, PYTH_RECEIVER_ID, PitError::BadPriceAccount);
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= 8 + 32 + 1 && data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        PitError::BadPriceAccount
    );
    let mut o = 8 + 32;
    match data[o] {
        0 => o += 2, // Partial { num_signatures: u8 }
        1 => o += 1, // Full
        _ => return err!(PitError::BadPriceAccount),
    }
    require!(data.len() >= o + 84, PitError::BadPriceAccount);
    require!(&data[o..o + 32] == feed_id, PitError::BadPriceAccount);
    o += 32;
    let price = read_i64(&data, o);
    o += 16; // price, conf
    let exponent = read_i32(&data, o);
    o += 4;
    let publish_time = read_i64(&data, o);
    require!(price > 0, PitError::BadPrice);
    require!(now.saturating_sub(publish_time) <= max_age, PitError::StalePrice);
    to_micro(price as u64, exponent)
}

fn read_i64(data: &[u8], at: usize) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[at..at + 8]);
    i64::from_le_bytes(b)
}

fn read_i32(data: &[u8], at: usize) -> i32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&data[at..at + 4]);
    i32::from_le_bytes(b)
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Round::INIT_SPACE,
        seeds = [b"round", authority.key().as_ref(), &round_id.to_le_bytes()],
        bump
    )]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPriceSource<'info> {
    #[account(mut, has_one = authority)]
    pub round: Account<'info, Round>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct JoinRound<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(
        init,
        payer = player,
        space = 8 + Entrant::INIT_SPACE,
        seeds = [b"entrant", round.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub entrant: Account<'info, Entrant>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// The house co-signs agent entries.
    pub registrar: Option<Signer<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"entrant", round.key().as_ref(), player.key().as_ref()],
        bump = entrant.bump,
        has_one = round,
        has_one = player
    )]
    pub entrant: Account<'info, Entrant>,
    pub player: Signer<'info>,
    /// CHECK: must equal round.feeds[0]; parsed as a Pyth PriceUpdateV2 account.
    pub price_sol: UncheckedAccount<'info>,
    /// CHECK: must equal round.feeds[1]; parsed as a Pyth PriceUpdateV2 account.
    pub price_btc: UncheckedAccount<'info>,
    /// CHECK: must equal round.feeds[2]; parsed as a Pyth PriceUpdateV2 account.
    pub price_eth: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(mut, has_one = round)]
    pub entrant: Account<'info, Entrant>,
    /// CHECK: must equal round.feeds[0]; parsed as a Pyth PriceUpdateV2 account.
    pub price_sol: UncheckedAccount<'info>,
    /// CHECK: must equal round.feeds[1]; parsed as a Pyth PriceUpdateV2 account.
    pub price_btc: UncheckedAccount<'info>,
    /// CHECK: must equal round.feeds[2]; parsed as a Pyth PriceUpdateV2 account.
    pub price_eth: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FinalizeRound<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct CloseEntrant<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    #[account(mut, has_one = round, has_one = player, close = player)]
    pub entrant: Account<'info, Entrant>,
    /// CHECK: the entrant's player (checked by `has_one`); receives the rent.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub closer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut, has_one = authority, close = authority)]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub authority: Pubkey,
    pub round_id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    /// Starting cash per entrant, micro-USD.
    pub start_cash: u64,
    pub fee_bps: u16,
    /// Most of an entrant's equity one asset may hold, in basis points.
    pub max_asset_bps: u16,
    pub shard_id: u16,
    pub feeds: [Pubkey; NUM_ASSETS],
    pub entrants: u32,
    pub agents: u32,
    pub settled: u32,
    pub finalized: bool,
    pub winner: Pubkey,
    pub winner_equity: u64,
    pub winner_kind: u8,
    pub best_human_equity: u64,
    pub best_agent_equity: u64,
    pub bump: u8,
    /// Seconds: the oldest price a trade may fill at (see `MIN_PRICE_AGE`..`MAX_PRICE_AGE`).
    pub max_price_age: u16,
    /// Player accounts closed so far; the house can close the round once this equals `entrants`.
    pub closed: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Entrant {
    pub round: Pubkey,
    pub player: Pubkey,
    pub kind: u8,
    pub label: [u8; 24],
    /// Cash, micro-USD.
    pub cash: u64,
    /// Position per asset, in billionths of a coin: positive long, negative short. Same bytes as
    /// the unsigned holdings of accounts made before shorts existed.
    pub qty: [i64; NUM_ASSETS],
    pub trades: u32,
    pub joined_ts: i64,
    pub last_trade_ts: i64,
    pub last_reason_hash: [u8; 32],
    pub final_equity: u64,
    pub settled: bool,
    pub bump: u8,
}

#[event]
pub struct RoundCreated {
    pub round: Pubkey,
    pub round_id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub start_cash: u64,
}

#[event]
pub struct PriceSourceChanged {
    pub round: Pubkey,
    pub shard_id: u16,
    pub max_price_age: u16,
}

#[event]
pub struct Joined {
    pub round: Pubkey,
    pub entrant: Pubkey,
    pub player: Pubkey,
    pub kind: u8,
    pub label: [u8; 24],
}

#[event]
pub struct Traded {
    pub round: Pubkey,
    pub entrant: Pubkey,
    pub player: Pubkey,
    pub asset: u8,
    pub side: u8,
    pub usd: u64,
    pub qty: u64,
    pub price: u64,
    pub fee: u64,
    pub reason_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct Settled {
    pub round: Pubkey,
    pub entrant: Pubkey,
    pub final_equity: u64,
}

#[event]
pub struct Finalized {
    pub round: Pubkey,
    pub winner: Pubkey,
    pub winner_equity: u64,
    pub winner_kind: u8,
    pub best_human_equity: u64,
    pub best_agent_equity: u64,
}

#[error_code]
pub enum PitError {
    #[msg("The round must end after it starts and last at most ten years")]
    BadSchedule,
    #[msg("A parameter is out of range")]
    BadParams,
    #[msg("Joining is closed for this round")]
    RoundClosed,
    #[msg("This round is full")]
    RoundFull,
    #[msg("Agents must be registered by the house")]
    AgentNeedsRegistrar,
    #[msg("The round is not live")]
    RoundNotLive,
    #[msg("The round has not ended")]
    RoundNotOver,
    #[msg("Unknown asset")]
    BadAsset,
    #[msg("Trade is below the $10 minimum")]
    TradeTooSmall,
    #[msg("Not enough cash")]
    NotEnoughCash,
    #[msg("Nothing to sell")]
    NothingToSell,
    #[msg("That would put too much of your equity in one asset")]
    PositionTooLarge,
    #[msg("Wrong or malformed price account")]
    BadPriceAccount,
    #[msg("Price must be positive")]
    BadPrice,
    #[msg("Price is too old")]
    StalePrice,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Entrant already settled")]
    AlreadySettled,
    #[msg("Round already finalized")]
    AlreadyFinalized,
    #[msg("Finalize needs every entrant of the round")]
    MissingEntrants,
    #[msg("Not an entrant of this round")]
    BadEntrant,
    #[msg("Entrant listed twice")]
    DuplicateEntrant,
    #[msg("Every entrant must be settled first")]
    NotSettled,
    #[msg("The round is not finalized yet")]
    NotFinalized,
    #[msg("Only the player can close this account until three hours after the round")]
    TooEarlyToClose,
    #[msg("Every player's account must be closed first")]
    PlayersStillOpen,
    #[msg("A round can be closed six hours after it ends")]
    RoundTooRecent,
    #[msg("Your equity is gone: you can only close or reduce positions")]
    Bust,
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    /// The TypeScript client decodes accounts at fixed offsets; these sizes pin the layout.
    #[test]
    fn account_sizes_match_client() {
        assert_eq!(8 + Round::INIT_SPACE, 251);
        assert_eq!(8 + Entrant::INIT_SPACE, 191);
    }
}
