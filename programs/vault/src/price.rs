//! Pyth prices and the oracle minimum-output maths (design §4.7, checks 6 and 10).
//!
//! Prices come from `PriceUpdateV2` accounts owned by the Pyth Solana Receiver program
//! (`pyth-solana-receiver-sdk`). A Pyth price means `price × 10^exponent` USD for one whole
//! token; token amounts are in base units, `amount / 10^decimals` whole tokens.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::{
    error::GetPriceError,
    price_update::{FeedId, Price, PriceUpdateV2},
};

use crate::{constants::*, error::VaultError};

/// A validated Pyth price: positive, fresh, fully verified and tight enough.
/// Worth `price × 10^exponent` USD per whole token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OraclePrice {
    pub price: u64,
    pub exponent: i32,
}

/// A validated price and when it was published (unix seconds).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceReading {
    pub price: OraclePrice,
    pub publish_time: i64,
}

/// Decimals of the input and output mints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintDecimals {
    pub input: u8,
    pub output: u8,
}

/// Reads the price for `feed_id` from a Pyth price update and validates it.
///
/// Rejects an update that is not fully verified (`InvalidOracleAccount`), is for another feed
/// (`OracleFeedMismatch`), or was published more than `max_age_secs` before `clock`
/// (`StalePrice`); then applies [`validate_price`].
pub fn read_price(
    update: &PriceUpdateV2,
    feed_id: &FeedId,
    clock: &Clock,
    max_age_secs: u32,
) -> Result<PriceReading> {
    // Requires VerificationLevel::Full and publish_time + max_age >= now.
    let price = update
        .get_price_no_older_than(clock, u64::from(max_age_secs), feed_id)
        .map_err(|e| match e {
            GetPriceError::PriceTooOld => error!(VaultError::StalePrice),
            GetPriceError::MismatchedFeedId => error!(VaultError::OracleFeedMismatch),
            _ => error!(VaultError::InvalidOracleAccount),
        })?;
    Ok(PriceReading {
        price: validate_price(&price)?,
        publish_time: price.publish_time,
    })
}

/// The two prices of a swap must be published at most `MAX_PRICE_SKEW_SECS` apart, so the
/// keeper cannot pair an input price from one moment with an output price from another
/// (security review M-1).
pub fn check_price_skew(a: &PriceReading, b: &PriceReading) -> Result<()> {
    let skew = a
        .publish_time
        .checked_sub(b.publish_time)
        .ok_or(VaultError::MathOverflow)?
        .unsigned_abs();
    require!(
        skew <= MAX_PRICE_SKEW_SECS.unsigned_abs(),
        VaultError::PriceSkewTooLarge
    );
    Ok(())
}

/// The USD value of `amount` base units at `price`, in micro-USD, **rounded up** (so a loss is
/// never undercounted): `amount × price × 10^(exponent + 6 - decimals)`.
pub fn usd_value_micro(amount: u64, price: OraclePrice, decimals: u8) -> Result<u64> {
    let scale = i64::from(price.exponent) + USD_DECIMALS - i64::from(decimals);
    let power = pow10(scale.unsigned_abs())?;
    let value = u128::from(amount)
        .checked_mul(u128::from(price.price))
        .ok_or(VaultError::MathOverflow)?;
    let micro = if scale >= 0 {
        value.checked_mul(power).ok_or(VaultError::MathOverflow)?
    } else {
        value.div_ceil(power)
    };
    u64::try_from(micro).map_err(|_| error!(VaultError::MathOverflow))
}

/// Requires `price > 0` and a confidence interval no wider than `MAX_CONFIDENCE_BPS` (2%)
/// of the price: `conf × 10_000 <= price × 200`.
pub fn validate_price(price: &Price) -> Result<OraclePrice> {
    require!(price.price > 0, VaultError::NonPositivePrice);
    let value = price.price as u64; // positive, so the cast is exact
    let conf_bps = u128::from(price.conf) * u128::from(BPS_DENOMINATOR);
    let limit = u128::from(value) * u128::from(MAX_CONFIDENCE_BPS);
    require!(conf_bps <= limit, VaultError::PriceTooUncertain);
    Ok(OraclePrice {
        price: value,
        exponent: price.exponent,
    })
}

/// The least output (output base units) the vault accepts for `input_amount` input base units:
/// the oracle-implied amount less `max_slippage_bps`, rounded down.
///
/// ```text
/// out = input_amount × in.price × 10^(in.exponent + out.decimals)
///       ───────────────────────────────────────────────────────── × (10_000 - bps) / 10_000
///          out.price × 10^(out.exponent + in.decimals)
/// ```
///
/// Computed in u128 with a single division, so there is one rounding (down). Fails with
/// `MathOverflow` if an intermediate or the result does not fit, and `SlippageAboveCap` if
/// `max_slippage_bps > 10_000`.
pub fn min_output_amount(
    input_amount: u64,
    input_price: OraclePrice,
    output_price: OraclePrice,
    decimals: MintDecimals,
    max_slippage_bps: u16,
) -> Result<u64> {
    let keep_bps = BPS_DENOMINATOR
        .checked_sub(u64::from(max_slippage_bps))
        .ok_or(VaultError::SlippageAboveCap)?;
    require!(output_price.price > 0, VaultError::NonPositivePrice);

    // Net power of ten, moved to whichever side keeps it non-negative.
    let scale = i64::from(input_price.exponent) + i64::from(decimals.output)
        - i64::from(output_price.exponent)
        - i64::from(decimals.input);
    let power = pow10(scale.unsigned_abs())?;

    let mut numerator = u128::from(input_amount)
        .checked_mul(u128::from(input_price.price))
        .and_then(|n| n.checked_mul(u128::from(keep_bps)))
        .ok_or(VaultError::MathOverflow)?;
    let mut denominator = u128::from(output_price.price)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(VaultError::MathOverflow)?;
    if scale >= 0 {
        numerator = numerator
            .checked_mul(power)
            .ok_or(VaultError::MathOverflow)?;
    } else {
        denominator = denominator
            .checked_mul(power)
            .ok_or(VaultError::MathOverflow)?;
    }

    let out = numerator
        .checked_div(denominator)
        .ok_or(VaultError::MathOverflow)?;
    u64::try_from(out).map_err(|_| error!(VaultError::MathOverflow))
}

fn pow10(exponent: u64) -> Result<u128> {
    u32::try_from(exponent)
        .ok()
        .and_then(|e| 10u128.checked_pow(e))
        .ok_or_else(|| error!(VaultError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, VerificationLevel};

    // Realistic Pyth feeds: USD prices with exponent -8 (USDC, SOL) and -10 (BONK).
    const USDC: OraclePrice = OraclePrice {
        price: 100_000_000, // $1.00
        exponent: -8,
    };
    const SOL: OraclePrice = OraclePrice {
        price: 15_000_000_000, // $150.00
        exponent: -8,
    };
    const BONK: OraclePrice = OraclePrice {
        price: 250_000, // $0.000025
        exponent: -10,
    };
    const USDC_DEC: u8 = 6;
    const SOL_DEC: u8 = 9;
    const BONK_DEC: u8 = 5;

    fn dec(input: u8, output: u8) -> MintDecimals {
        MintDecimals { input, output }
    }

    fn code<T: std::fmt::Debug>(result: Result<T>) -> u32 {
        match result.unwrap_err() {
            Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error {other:?}"),
        }
    }

    fn expected(e: VaultError) -> u32 {
        anchor_lang::error::ERROR_CODE_OFFSET + e as u32
    }

    // ------------------------------------------------------------ min_output_amount

    #[test]
    fn usdc_to_sol() {
        // 150 USDC at $1 buys 1 SOL at $150 = 1_000_000_000 lamports.
        let m = |bps| min_output_amount(150_000_000, USDC, SOL, dec(USDC_DEC, SOL_DEC), bps);
        assert_eq!(m(0).unwrap(), 1_000_000_000);
        assert_eq!(m(50).unwrap(), 995_000_000); // 0.5% slippage
        assert_eq!(m(500).unwrap(), 950_000_000); // 5%, the cap
    }

    #[test]
    fn sol_to_usdc() {
        // 2 SOL × $150 = $300 = 300_000_000 USDC base units.
        let m = |bps| min_output_amount(2_000_000_000, SOL, USDC, dec(SOL_DEC, USDC_DEC), bps);
        assert_eq!(m(0).unwrap(), 300_000_000);
        assert_eq!(m(100).unwrap(), 297_000_000);
    }

    #[test]
    fn sol_to_bonk() {
        // 1 SOL = $150 = 150 / 0.000025 = 6_000_000 BONK = 600_000_000_000 base units (5 dp).
        let m = |bps| min_output_amount(1_000_000_000, SOL, BONK, dec(SOL_DEC, BONK_DEC), bps);
        assert_eq!(m(0).unwrap(), 600_000_000_000);
        assert_eq!(m(500).unwrap(), 570_000_000_000);
    }

    #[test]
    fn bonk_to_usdc_and_back() {
        // 1_000_000 BONK × $0.000025 = $25.
        let to_usdc = min_output_amount(100_000_000_000, BONK, USDC, dec(BONK_DEC, USDC_DEC), 0);
        assert_eq!(to_usdc.unwrap(), 25_000_000);
        let to_bonk = min_output_amount(25_000_000, USDC, BONK, dec(USDC_DEC, BONK_DEC), 0);
        assert_eq!(to_bonk.unwrap(), 100_000_000_000);
    }

    #[test]
    fn same_price_with_a_different_exponent_gives_the_same_answer() {
        // $150 as 15_000_000_000e-8 or as 15_000_000e-5.
        let sol_e5 = OraclePrice {
            price: 15_000_000,
            exponent: -5,
        };
        let a = min_output_amount(150_000_000, USDC, SOL, dec(USDC_DEC, SOL_DEC), 30).unwrap();
        let b = min_output_amount(150_000_000, USDC, sol_e5, dec(USDC_DEC, SOL_DEC), 30).unwrap();
        assert_eq!(a, b);
        assert_eq!(a, 997_000_000); // 1 SOL less 0.3%
    }

    #[test]
    fn non_negative_net_exponent() {
        // USDC (6 dp) → SOL (9 dp) priced at exponent 0: scale = 0 + 9 - 0 - 6 = +3.
        let usdc = OraclePrice {
            price: 1,
            exponent: 0,
        };
        let sol = OraclePrice {
            price: 150,
            exponent: 0,
        };
        let out = min_output_amount(150_000_000, usdc, sol, dec(USDC_DEC, SOL_DEC), 0).unwrap();
        assert_eq!(out, 1_000_000_000);
    }

    #[test]
    fn rounds_down() {
        // 1 USDC base unit = $0.000001 = 6.67 lamports at $150: floor to 6.
        let m = |amount, bps| min_output_amount(amount, USDC, SOL, dec(USDC_DEC, SOL_DEC), bps);
        assert_eq!(m(1, 0).unwrap(), 6);
        // 0.995 × 6.67 = 6.63, still 6: one rounding, not floor(floor(6.67) × 0.995) = 5.
        assert_eq!(m(1, 50).unwrap(), 6);
        // 1 lamport at $150 = 0.15 USDC base units: 0.
        let dust = min_output_amount(1, SOL, USDC, dec(SOL_DEC, USDC_DEC), 0);
        assert_eq!(dust.unwrap(), 0);
        // 1 SOL into USDC at $149.99999999.
        let sol = OraclePrice {
            price: 14_999_999_999,
            exponent: -8,
        };
        let out = min_output_amount(1_000_000_000, sol, USDC, dec(SOL_DEC, USDC_DEC), 0);
        assert_eq!(out.unwrap(), 149_999_999);
    }

    #[test]
    fn zero_input_gives_zero() {
        let out = min_output_amount(0, SOL, USDC, dec(SOL_DEC, USDC_DEC), 50);
        assert_eq!(out.unwrap(), 0);
    }

    #[test]
    fn slippage_never_raises_the_minimum() {
        let mut last = u64::MAX;
        for bps in [0, 1, 10, 50, 100, 250, 500, 10_000] {
            let out =
                min_output_amount(123_456_789, SOL, BONK, dec(SOL_DEC, BONK_DEC), bps).unwrap();
            assert!(out <= last);
            last = out;
        }
        assert_eq!(last, 0); // 100% slippage accepts anything
    }

    #[test]
    fn rejects_slippage_above_100_percent() {
        let out = min_output_amount(1, USDC, SOL, dec(USDC_DEC, SOL_DEC), 10_001);
        assert_eq!(code(out), expected(VaultError::SlippageAboveCap));
    }

    #[test]
    fn overflow_is_an_error_not_a_wrap() {
        // u64::MAX lamports (1.8e10 SOL, $2.8e12) into BONK: about 1.1e22 base units > u64::MAX.
        let out = min_output_amount(u64::MAX, SOL, BONK, dec(SOL_DEC, BONK_DEC), 0);
        assert_eq!(code(out), expected(VaultError::MathOverflow));
        // A price exponent so large that 10^scale does not fit in a u128.
        let huge = OraclePrice {
            price: 1,
            exponent: 40,
        };
        let out = min_output_amount(1, huge, USDC, dec(USDC_DEC, USDC_DEC), 0);
        assert_eq!(code(out), expected(VaultError::MathOverflow));
        let out = min_output_amount(1, USDC, huge, dec(USDC_DEC, USDC_DEC), 0);
        assert_eq!(code(out), expected(VaultError::MathOverflow));
    }

    #[test]
    fn largest_amounts_that_fit_do_not_overflow() {
        // u64::MAX BONK base units into SOL: × 1e-5 BONK × $0.000025 / $150 × 1e9 lamports
        // = u64::MAX / 600 exactly (rational), so floor(u64::MAX / 600).
        let out = min_output_amount(u64::MAX, BONK, SOL, dec(BONK_DEC, SOL_DEC), 0).unwrap();
        assert_eq!(out, u64::MAX / 600);
    }

    // ------------------------------------------------------------ validate_price

    fn price(price: i64, conf: u64) -> Price {
        Price {
            price,
            conf,
            exponent: -8,
            publish_time: 0,
        }
    }

    #[test]
    fn confidence_up_to_two_percent_is_accepted() {
        // $150 ± $3 is exactly 2%.
        let p = validate_price(&price(15_000_000_000, 300_000_000)).unwrap();
        assert_eq!(p, SOL);
        let wide = validate_price(&price(15_000_000_000, 300_000_001));
        assert_eq!(code(wide), expected(VaultError::PriceTooUncertain));
        // Same rule at small magnitudes: 2% of 100 is 2.
        assert!(validate_price(&price(100, 2)).is_ok());
        assert_eq!(
            code(validate_price(&price(100, 3))),
            expected(VaultError::PriceTooUncertain)
        );
    }

    #[test]
    fn zero_and_negative_prices_are_rejected() {
        for p in [0, -1, i64::MIN] {
            assert_eq!(
                code(validate_price(&price(p, 0))),
                expected(VaultError::NonPositivePrice)
            );
        }
        // The largest price does not overflow the confidence check.
        assert!(validate_price(&price(i64::MAX, 0)).is_ok());
        assert_eq!(
            code(validate_price(&price(i64::MAX, u64::MAX))),
            expected(VaultError::PriceTooUncertain)
        );
    }

    // ------------------------------------------------------------ read_price

    const FEED: FeedId = [7; 32];
    const NOW: i64 = 1_800_000_000;

    fn update(publish_time: i64, verification_level: VerificationLevel) -> PriceUpdateV2 {
        PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level,
            price_message: PriceFeedMessage {
                feed_id: FEED,
                price: 15_000_000_000,
                conf: 7_500_000,
                exponent: -8,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price: 15_000_000_000,
                ema_conf: 7_500_000,
            },
            posted_slot: 1,
        }
    }

    fn clock() -> Clock {
        Clock {
            unix_timestamp: NOW,
            ..Clock::default()
        }
    }

    #[test]
    fn reads_a_fresh_verified_price() {
        let p = read_price(
            &update(NOW - 5, VerificationLevel::Full),
            &FEED,
            &clock(),
            60,
        );
        assert_eq!(
            p.unwrap(),
            PriceReading {
                price: SOL,
                publish_time: NOW - 5
            }
        );
    }

    // ------------------------------------------------------------ check_price_skew (M-1)

    fn reading(publish_time: i64) -> PriceReading {
        PriceReading {
            price: SOL,
            publish_time,
        }
    }

    #[test]
    fn price_skew_up_to_30_seconds_either_way() {
        assert!(check_price_skew(&reading(NOW), &reading(NOW)).is_ok());
        assert!(check_price_skew(&reading(NOW), &reading(NOW - 30)).is_ok());
        assert!(check_price_skew(&reading(NOW - 30), &reading(NOW)).is_ok());
        for (a, b) in [(NOW, NOW - 31), (NOW - 31, NOW)] {
            assert_eq!(
                code(check_price_skew(&reading(a), &reading(b))),
                expected(VaultError::PriceSkewTooLarge)
            );
        }
        // Extreme timestamps are an error, not a panic.
        assert!(check_price_skew(&reading(i64::MAX), &reading(i64::MIN)).is_err());
    }

    // ------------------------------------------------------------ usd_value_micro (H-1)

    #[test]
    fn usd_value_across_decimals() {
        // 1 SOL (9 dp) at $150 = 150_000_000 micro-USD.
        assert_eq!(
            usd_value_micro(1_000_000_000, SOL, SOL_DEC).unwrap(),
            150_000_000
        );
        // 2.5 USDC (6 dp) at $1 = 2_500_000.
        assert_eq!(
            usd_value_micro(2_500_000, USDC, USDC_DEC).unwrap(),
            2_500_000
        );
        // 1,000,000 BONK (5 dp) at $0.000025 = $25.
        assert_eq!(
            usd_value_micro(100_000_000_000, BONK, BONK_DEC).unwrap(),
            25_000_000
        );
        // Positive net exponent: price 150 with exponent 0, for 1 whole SOL.
        let sol_e0 = OraclePrice {
            price: 150,
            exponent: 0,
        };
        assert_eq!(
            usd_value_micro(1_000_000_000, sol_e0, 0).unwrap(),
            150_000_000_000_000_000
        );
    }

    #[test]
    fn usd_value_rounds_up_so_losses_are_never_undercounted() {
        // 1 lamport = $0.00000015 = 0.15 micro-USD: counted as 1, never 0.
        assert_eq!(usd_value_micro(1, SOL, SOL_DEC).unwrap(), 1);
        assert_eq!(usd_value_micro(0, SOL, SOL_DEC).unwrap(), 0);
        // 13_280_000 lamports (0.01328 SOL) = $1.992 exactly.
        assert_eq!(
            usd_value_micro(13_280_000, SOL, SOL_DEC).unwrap(),
            1_992_000
        );
        assert_eq!(
            usd_value_micro(13_280_001, SOL, SOL_DEC).unwrap(),
            1_992_001
        );
    }

    #[test]
    fn usd_value_overflow_is_an_error() {
        let huge = OraclePrice {
            price: u64::MAX,
            exponent: 10,
        };
        assert_eq!(
            code(usd_value_micro(u64::MAX, huge, 0)),
            expected(VaultError::MathOverflow)
        );
    }

    #[test]
    fn rejects_prices_older_than_max_age() {
        let at = |age| {
            read_price(
                &update(NOW - age, VerificationLevel::Full),
                &FEED,
                &clock(),
                60,
            )
        };
        assert!(at(60).is_ok()); // exactly max age is still accepted
        assert_eq!(code(at(61)), expected(VaultError::StalePrice));
        assert_eq!(code(at(3_600)), expected(VaultError::StalePrice));
    }

    #[test]
    fn rejects_another_feed() {
        let p = read_price(
            &update(NOW, VerificationLevel::Full),
            &[8; 32],
            &clock(),
            60,
        );
        assert_eq!(code(p), expected(VaultError::OracleFeedMismatch));
    }

    #[test]
    fn rejects_partially_verified_updates() {
        let partial = VerificationLevel::Partial { num_signatures: 5 };
        let p = read_price(&update(NOW, partial), &FEED, &clock(), 60);
        assert_eq!(code(p), expected(VaultError::InvalidOracleAccount));
    }

    #[test]
    fn rejects_an_uncertain_price_from_an_update() {
        let mut u = update(NOW, VerificationLevel::Full);
        u.price_message.conf = 300_000_001; // just over 2% of $150
        let p = read_price(&u, &FEED, &clock(), 60);
        assert_eq!(code(p), expected(VaultError::PriceTooUncertain));
    }
}
