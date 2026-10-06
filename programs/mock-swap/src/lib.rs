//! # TEST-ONLY: mock swap venue for devnet. Never deploy to mainnet.
//!
//! Stands in for Jupiter so the vault's `swap` can be exercised end to end on devnet with
//! test mints (vault built with the `devnet-mock` feature). It is deliberately simple and
//! **not safe for real funds**: one global market, prices set by hand by whoever initialised
//! it, no fees, no oracle, and anyone can trade against its liquidity at the admin's price.
//!
//! - `init_market`: creates the single `Market` PDA; the signer becomes its admin.
//! - `set_price(mint, price, exponent)`: admin sets a mint's USD price, `price × 10^exponent`
//!   per whole token (the same convention as Pyth).
//! - `swap(amount_in, min_out)`: takes `amount_in` of the input mint from the user and pays
//!   out the equivalent value of the output mint at the admin's prices, rounded down.
//!
//! Liquidity: transfer test tokens into the market PDA's associated token account for each
//! mint (create it with `create_idempotent`). There is no withdraw; it is test money.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("pG9QphRAdj8stz3vLU4W7MHkmg3c5ehp9Q779xroqjP");

pub const MARKET_SEED: &[u8] = b"market";
pub const MAX_MINTS: usize = 16;

#[program]
pub mod mock_swap {
    use super::*;

    /// Creates the market. The signer becomes the admin who sets prices.
    pub fn init_market(ctx: Context<InitMarket>) -> Result<()> {
        ctx.accounts.market.set_inner(Market {
            admin: ctx.accounts.admin.key(),
            bump: ctx.bumps.market,
            prices: vec![],
        });
        Ok(())
    }

    /// Sets (or replaces) a mint's price: `price × 10^exponent` USD per whole token.
    pub fn set_price(
        ctx: Context<SetPrice>,
        mint: Pubkey,
        price: u64,
        exponent: i32,
    ) -> Result<()> {
        require!(price > 0, MockSwapError::InvalidPrice);
        let prices = &mut ctx.accounts.market.prices;
        let entry = MintPrice {
            mint,
            price,
            exponent,
        };
        match prices.iter_mut().find(|p| p.mint == mint) {
            Some(existing) => *existing = entry,
            None => {
                require!(prices.len() < MAX_MINTS, MockSwapError::TooManyMints);
                prices.push(entry);
            }
        }
        emit!(PriceSet {
            mint,
            price,
            exponent
        });
        Ok(())
    }

    /// Swaps `amount_in` of `input_mint` for `output_mint` at the admin's prices.
    /// Fails if the output is zero, below `min_out`, or more than the market holds.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64) -> Result<()> {
        require!(amount_in > 0, MockSwapError::ZeroAmount);
        let a = &ctx.accounts;
        require_keys_neq!(
            a.input_mint.key(),
            a.output_mint.key(),
            MockSwapError::SameMint
        );
        let price_in = a.market.price_of(&a.input_mint.key())?;
        let price_out = a.market.price_of(&a.output_mint.key())?;
        let out = quote(
            amount_in,
            price_in,
            price_out,
            a.input_mint.decimals,
            a.output_mint.decimals,
        )?;
        require!(out > 0, MockSwapError::ZeroOutput);
        require!(out >= min_out, MockSwapError::SlippageExceeded);
        require!(
            out <= a.market_output_account.amount,
            MockSwapError::InsufficientLiquidity
        );

        token::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.user_input_account.to_account_info(),
                    mint: a.input_mint.to_account_info(),
                    to: a.market_input_account.to_account_info(),
                    authority: a.user.to_account_info(),
                },
            ),
            amount_in,
            a.input_mint.decimals,
        )?;
        let seeds: &[&[u8]] = &[MARKET_SEED, &[a.market.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.market_output_account.to_account_info(),
                    mint: a.output_mint.to_account_info(),
                    to: a.user_output_account.to_account_info(),
                    authority: a.market.to_account_info(),
                },
                &[seeds],
            ),
            out,
            a.output_mint.decimals,
        )?;

        emit!(MockSwapped {
            user: a.user.key(),
            input_mint: a.input_mint.key(),
            output_mint: a.output_mint.key(),
            amount_in,
            amount_out: out,
        });
        Ok(())
    }
}

/// Output base units for `amount_in` input base units, rounded down:
/// `amount_in × p_in × 10^(e_in + d_out) / (p_out × 10^(e_out + d_in))`.
pub fn quote(
    amount_in: u64,
    price_in: MintPrice,
    price_out: MintPrice,
    decimals_in: u8,
    decimals_out: u8,
) -> Result<u64> {
    let scale = i64::from(price_in.exponent) + i64::from(decimals_out)
        - i64::from(price_out.exponent)
        - i64::from(decimals_in);
    let power = u32::try_from(scale.unsigned_abs())
        .ok()
        .and_then(|e| 10u128.checked_pow(e))
        .ok_or(MockSwapError::MathOverflow)?;
    let mut num = u128::from(amount_in)
        .checked_mul(u128::from(price_in.price))
        .ok_or(MockSwapError::MathOverflow)?;
    let mut den = u128::from(price_out.price);
    if scale >= 0 {
        num = num.checked_mul(power).ok_or(MockSwapError::MathOverflow)?;
    } else {
        den = den.checked_mul(power).ok_or(MockSwapError::MathOverflow)?;
    }
    let out = num.checked_div(den).ok_or(MockSwapError::MathOverflow)?;
    u64::try_from(out).map_err(|_| error!(MockSwapError::MathOverflow))
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub admin: Pubkey,
    pub bump: u8,
    #[max_len(MAX_MINTS)]
    pub prices: Vec<MintPrice>,
}

impl Market {
    pub fn price_of(&self, mint: &Pubkey) -> Result<MintPrice> {
        self.prices
            .iter()
            .find(|p| p.mint == *mint)
            .copied()
            .ok_or_else(|| error!(MockSwapError::PriceNotSet))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct MintPrice {
    pub mint: Pubkey,
    pub price: u64,
    pub exponent: i32,
}

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED],
        bump
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ MockSwapError::Unauthorized,
        seeds = [MARKET_SEED],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,
    #[account(mut, token::mint = input_mint, token::authority = user)]
    pub user_input_account: Account<'info, TokenAccount>,
    #[account(mut, token::mint = output_mint, token::authority = user)]
    pub user_output_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = input_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_input_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program,
    )]
    pub market_output_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[event]
pub struct PriceSet {
    pub mint: Pubkey,
    pub price: u64,
    pub exponent: i32,
}

#[event]
pub struct MockSwapped {
    pub user: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[error_code]
pub enum MockSwapError {
    #[msg("Only the market admin can set prices")]
    Unauthorized,
    #[msg("Price must be positive")]
    InvalidPrice,
    #[msg("The market already prices the maximum number of mints")]
    TooManyMints,
    #[msg("No price set for this mint")]
    PriceNotSet,
    #[msg("Input and output mint must differ")]
    SameMint,
    #[msg("amount_in must be greater than zero")]
    ZeroAmount,
    #[msg("The swap would pay out nothing")]
    ZeroOutput,
    #[msg("Output is below min_out")]
    SlippageExceeded,
    #[msg("The market does not hold enough of the output mint")]
    InsufficientLiquidity,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(price: u64, exponent: i32) -> MintPrice {
        MintPrice {
            mint: Pubkey::default(),
            price,
            exponent,
        }
    }

    #[test]
    fn quotes_across_decimals() {
        let usdc = p(100_000_000, -8); // $1
        let sol = p(15_000_000_000, -8); // $150
        let bonk = p(250_000, -10); // $0.000025
        assert_eq!(quote(150_000_000, usdc, sol, 6, 9).unwrap(), 1_000_000_000);
        assert_eq!(quote(1_000_000_000, sol, usdc, 9, 6).unwrap(), 150_000_000);
        assert_eq!(
            quote(1_000_000_000, sol, bonk, 9, 5).unwrap(),
            600_000_000_000
        );
        assert_eq!(
            quote(100_000_000_000, bonk, usdc, 5, 6).unwrap(),
            25_000_000
        );
        // rounds down: 1 USDC base unit = 6.67 lamports
        assert_eq!(quote(1, usdc, sol, 6, 9).unwrap(), 6);
    }

    #[test]
    fn overflow_is_an_error() {
        let sol = p(15_000_000_000, -8);
        let bonk = p(250_000, -10);
        assert!(quote(u64::MAX, sol, bonk, 9, 5).is_err());
    }
}
