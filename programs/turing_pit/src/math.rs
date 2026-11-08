//! Fixed-point helpers. Cash and prices are micro-USD (6 decimals); holdings are billionths
//! of a coin (9 decimals). Every step goes through u128 and fails instead of wrapping.

use crate::{PitError, NUM_ASSETS};
use anchor_lang::prelude::*;

const QTY_SCALE: u128 = 1_000_000_000;

pub fn mul_div(a: u64, b: u64, d: u64) -> Result<u64> {
    require!(d > 0, PitError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(PitError::MathOverflow)?
        / d as u128;
    u64::try_from(v).map_err(|_| error!(PitError::MathOverflow))
}

/// Coins (in billionths) that `usd` micro-USD buys at `price` micro-USD per coin.
pub fn usd_to_qty(usd: u64, price: u64) -> Result<u64> {
    require!(price > 0, PitError::BadPrice);
    let v = (usd as u128)
        .checked_mul(QTY_SCALE)
        .ok_or(PitError::MathOverflow)?
        / price as u128;
    u64::try_from(v).map_err(|_| error!(PitError::MathOverflow))
}

/// Micro-USD value of `qty` billionths of a coin at `price` micro-USD per coin.
pub fn qty_to_usd(qty: u64, price: u64) -> Result<u64> {
    let v = (qty as u128)
        .checked_mul(price as u128)
        .ok_or(PitError::MathOverflow)?
        / QTY_SCALE;
    u64::try_from(v).map_err(|_| error!(PitError::MathOverflow))
}

/// Micro-USD value of a signed position: positive for a long, negative for a short.
pub fn position_value(qty: i64, price: u64) -> Result<i128> {
    let v = (qty.unsigned_abs() as u128)
        .checked_mul(price as u128)
        .ok_or(PitError::MathOverflow)?
        / QTY_SCALE;
    let v = i128::try_from(v).map_err(|_| error!(PitError::MathOverflow))?;
    Ok(if qty < 0 { -v } else { v })
}

/// Cash plus the value of every position, longs adding and shorts subtracting. It can go
/// below zero when shorts run against the player.
pub fn equity_of(cash: u64, qty: &[i64; NUM_ASSETS], prices: &[u64; NUM_ASSETS]) -> Result<i128> {
    let mut total = cash as i128;
    for i in 0..NUM_ASSETS {
        total = total
            .checked_add(position_value(qty[i], prices[i])?)
            .ok_or(PitError::MathOverflow)?;
    }
    Ok(total)
}

/// True when a position worth `position` (either side) is at most `cap_bps` of `equity`, and
/// there is equity left at all.
pub fn within_cap(position: i128, equity: i128, cap_bps: u64) -> bool {
    equity > 0
        && position
            .unsigned_abs()
            .checked_mul(10_000)
            .is_some_and(|p| p <= (equity as u128).saturating_mul(cap_bps as u128))
}

/// True when `price` is within `bps` basis points of a positive `reference` (both micro-USD).
pub fn near(price: u64, reference: u64, bps: u64) -> bool {
    reference > 0
        && (price.abs_diff(reference) as u128) * 10_000 <= (reference as u128) * (bps as u128)
}

/// Coins as a signed quantity.
pub fn to_signed(qty: u64) -> Result<i64> {
    i64::try_from(qty).map_err(|_| error!(PitError::MathOverflow))
}

/// True when going from `old` to `new` adds risk: the position grows, or flips to the other side.
pub fn adds_risk(old: i64, new: i64) -> bool {
    new.unsigned_abs() > old.unsigned_abs() || (old != 0 && new != 0 && (old < 0) != (new < 0))
}

/// Converts a Pyth price with its exponent to micro-USD per coin.
pub fn to_micro(price: u64, exponent: i32) -> Result<u64> {
    let shift = exponent + 6;
    require!((-18..=18).contains(&shift), PitError::BadPrice);
    let v: u128 = if shift >= 0 {
        (price as u128)
            .checked_mul(10u128.pow(shift as u32))
            .ok_or(PitError::MathOverflow)?
    } else {
        (price as u128) / 10u128.pow((-shift) as u32)
    };
    require!(v > 0, PitError::BadPrice);
    u64::try_from(v).map_err(|_| error!(PitError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u64 = 1_000_000;

    #[test]
    fn pyth_exponent_to_micro() {
        // SOL at $150.12345678 with exponent -8
        assert_eq!(to_micro(15_012_345_678, -8).unwrap(), 150_123_456);
        // A price with exponent -5
        assert_eq!(to_micro(1_234_567, -5).unwrap(), 12_345_670);
    }

    #[test]
    fn buy_then_value() {
        let price = 150 * USD; // $150
        let qty = usd_to_qty(1_500 * USD, price).unwrap();
        assert_eq!(qty, 10_000_000_000); // 10 coins
        assert_eq!(qty_to_usd(qty, price).unwrap(), 1_500 * USD);
    }

    #[test]
    fn equity_and_cap() {
        let prices = [150 * USD, 100_000 * USD, 4_000 * USD];
        let qty = [10_000_000_000, 10_000_000, 0]; // 10 SOL, 0.01 BTC
        let equity = equity_of(7_500 * USD, &qty, &prices).unwrap();
        assert_eq!(equity, (10_000 * USD) as i128);
        assert!(within_cap((5_000 * USD) as i128, equity, 5_000));
        assert!(!within_cap((5_000 * USD + 1) as i128, equity, 5_000));
    }

    #[test]
    fn shorts_subtract_and_cap_both_sides() {
        let prices = [150 * USD, 100_000 * USD, 4_000 * USD];
        // Short 20 SOL ($3,000) after starting with $10,000: cash is $13,000.
        let qty = [-20_000_000_000, 0, 0];
        assert_eq!(position_value(qty[0], prices[0]).unwrap(), -((3_000 * USD) as i128));
        let equity = equity_of(13_000 * USD, &qty, &prices).unwrap();
        assert_eq!(equity, (10_000 * USD) as i128);
        // The cap applies to the size of a short as to a long.
        assert!(within_cap(-((5_000 * USD) as i128), equity, 5_000));
        assert!(!within_cap(-((5_000 * USD + 1) as i128), equity, 5_000));
        // SOL doubles: the short loses $3,000.
        let up = [300 * USD, 100_000 * USD, 4_000 * USD];
        assert_eq!(equity_of(13_000 * USD, &qty, &up).unwrap(), (7_000 * USD) as i128);
        // SOL at $800 wipes the account out, and nothing more can be added.
        let wiped = [800 * USD, 100_000 * USD, 4_000 * USD];
        let e = equity_of(13_000 * USD, &qty, &wiped).unwrap();
        assert!(e < 0);
        assert!(!within_cap(0, e, 5_000));
    }

    #[test]
    fn risk_direction() {
        assert!(adds_risk(0, 5));
        assert!(adds_risk(0, -5));
        assert!(adds_risk(5, 7));
        assert!(adds_risk(-5, -7));
        assert!(adds_risk(5, -1)); // flips from long to short
        assert!(!adds_risk(5, 3));
        assert!(!adds_risk(-5, -3));
        assert!(!adds_risk(-5, 0));
    }

    #[test]
    fn guard_band() {
        let pyth = 100 * USD;
        assert!(near(101 * USD, pyth, 100));
        assert!(near(99 * USD, pyth, 100));
        assert!(!near(101 * USD + 1, pyth, 100));
        assert!(!near(99 * USD - 1, pyth, 100));
        assert!(!near(USD, 0, 100));
        // BTC-sized prices don't overflow.
        assert!(near(75_800 * USD, 75_710 * USD, 100));
    }

    #[test]
    fn fees() {
        assert_eq!(mul_div(1_000 * USD, 10, 10_000).unwrap(), USD); // 0.1% of $1,000
    }
}
