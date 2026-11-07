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

pub fn equity_of(cash: u64, qty: &[u64; NUM_ASSETS], prices: &[u64; NUM_ASSETS]) -> Result<u64> {
    let mut total = cash;
    for i in 0..NUM_ASSETS {
        total = total
            .checked_add(qty_to_usd(qty[i], prices[i])?)
            .ok_or(PitError::MathOverflow)?;
    }
    Ok(total)
}

/// True when `position` is at most `cap_bps` of `equity`.
pub fn within_cap(position: u64, equity: u64, cap_bps: u64) -> bool {
    (position as u128) * 10_000 <= (equity as u128) * (cap_bps as u128)
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
        assert_eq!(equity, 10_000 * USD);
        assert!(within_cap(5_000 * USD, equity, 5_000));
        assert!(!within_cap(5_000 * USD + 1, equity, 5_000));
    }

    #[test]
    fn fees() {
        assert_eq!(mul_div(1_000 * USD, 10, 10_000).unwrap(), USD); // 0.1% of $1,000
    }
}
