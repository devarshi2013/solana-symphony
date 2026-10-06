use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken},
    token::{Mint, Token, TokenAccount},
};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    constants::*,
    error::VaultError,
    events::Swapped,
    price::{check_price_skew, min_output_amount, read_price, usd_value_micro, MintDecimals},
    state::*,
};

/// Design §4.7. The keeper passes the swap venue's instruction through: its data as
/// `route_data` and its accounts, in order, as the remaining accounts. The vault invokes
/// `swap_program` with them, signing as the vault PDA (marked `is_signer` in the outer
/// transaction's metas it cannot be, so the vault sets it for the CPI).
///
/// The venue is Jupiter v6 on mainnet; with the TEST-ONLY `devnet-mock` feature it is
/// programs/mock-swap. Only the pinned program ID differs between the two builds: the CPI and
/// every check are the same code.
#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        mut,
        constraint = vault.keeper == keeper.key() @ VaultError::NotKeeper,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = input_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_input_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_output_account: Account<'info, TokenAccount>,
    /// Pyth price update for `input_mint`. Anchor checks the owner (the Pyth receiver
    /// program) and the account type; verification level, feed ID, staleness and confidence
    /// are checked in the handler with `price::read_price` (design §4.7 check 6).
    pub input_price_update: Account<'info, PriceUpdateV2>,
    /// Pyth price update for `output_mint`, validated like `input_price_update`.
    pub output_price_update: Account<'info, PriceUpdateV2>,
    /// CHECK: the swap venue. Must equal `SWAP_PROGRAM_ID` (Jupiter v6, or mock-swap in a
    /// TEST-ONLY `devnet-mock` build); checked in the handler before any CPI (§6.3).
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handle_swap<'info>(
    mut ctx: Context<'info, Swap<'info>>,
    amount_in: u64,
    keeper_min_out: u64,
    route_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?;
    let a = &ctx.accounts;
    let vault = &a.vault;

    // 1-3. Paused, keeper set (the signer check is the NotKeeper constraint), cooldown.
    require!(!vault.paused, VaultError::VaultPaused);
    require!(vault.has_keeper(), VaultError::KeeperNotSet);
    let since_last = now
        .unix_timestamp
        .checked_sub(vault.last_swap_ts)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        since_last >= MIN_SWAP_INTERVAL_SECS,
        VaultError::SwapCooldown
    );

    // 4. Both mints allowed and different (the ATA constraints pin the token accounts).
    require_keys_neq!(
        a.input_mint.key(),
        a.output_mint.key(),
        VaultError::SameMint
    );
    let input_feed = vault
        .find_allowed(&a.input_mint.key())
        .ok_or(VaultError::MintNotAllowed)?
        .pyth_feed_id;
    let output_feed = vault
        .find_allowed(&a.output_mint.key())
        .ok_or(VaultError::MintNotAllowed)?
        .pyth_feed_id;

    // 5. Amount.
    require!(amount_in > 0, VaultError::ZeroAmount);
    require!(
        amount_in <= a.vault_input_account.amount,
        VaultError::InsufficientBalance
    );

    // 6. Oracle prices.
    let max_age = vault.max_oracle_staleness_secs;
    let reading_in = read_price(&a.input_price_update, &input_feed, &now, max_age)?;
    let reading_out = read_price(&a.output_price_update, &output_feed, &now, max_age)?;
    check_price_skew(&reading_in, &reading_out)?;
    let (price_in, price_out) = (reading_in.price, reading_out.price);

    // 7. Route screening and the pinned venue.
    require_keys_eq!(
        a.swap_program.key(),
        SWAP_PROGRAM_ID,
        VaultError::InvalidSwapProgram
    );
    screen_route_accounts(
        vault,
        &a.vault_input_account.key(),
        &a.vault_output_account.key(),
        ctx.remaining_accounts,
    )?;

    // 8. Record balances, then swap.
    let before_in = a.vault_input_account.amount;
    let before_out = a.vault_output_account.amount;
    invoke_route(&ctx, route_data)?;

    // 9. Measure what actually happened.
    let a = &mut ctx.accounts;
    a.vault_input_account.reload()?;
    a.vault_output_account.reload()?;
    let spent = before_in
        .checked_sub(a.vault_input_account.amount)
        .ok_or(VaultError::TokenAccountTampered)?;
    let received = a
        .vault_output_account
        .amount
        .checked_sub(before_out)
        .ok_or(VaultError::TokenAccountTampered)?;
    require!(spent <= amount_in, VaultError::SpentMoreThanAmountIn);
    require!(received > 0, VaultError::NothingReceived);

    // 10. Oracle minimum on what was actually spent.
    let decimals = MintDecimals {
        input: a.input_mint.decimals,
        output: a.output_mint.decimals,
    };
    let oracle_out = min_output_amount(spent, price_in, price_out, decimals, 0)?;
    let min_out = min_output_amount(
        spent,
        price_in,
        price_out,
        decimals,
        a.vault.max_slippage_bps,
    )?;
    require!(
        received >= min_out.max(keeper_min_out),
        VaultError::OutputBelowMinimum
    );

    // 10b. Daily loss limit (security review H-1): count this swap's shortfall versus the
    // oracle, in USD, against `max_daily_loss_usd` per 24-hour window. Gains are not netted.
    let loss_usd = usd_value_micro(
        oracle_out.saturating_sub(received),
        price_out,
        decimals.output,
    )?;
    let window_elapsed = now
        .unix_timestamp
        .checked_sub(a.vault.loss_window_start)
        .ok_or(VaultError::MathOverflow)?;
    if window_elapsed >= LOSS_WINDOW_SECS {
        a.vault.loss_window_start = now.unix_timestamp;
        a.vault.loss_in_window_usd = 0;
    }
    let loss_in_window_usd = a
        .vault
        .loss_in_window_usd
        .checked_add(loss_usd)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        loss_in_window_usd <= a.vault.max_daily_loss_usd,
        VaultError::DailyLossLimitExceeded
    );
    a.vault.loss_in_window_usd = loss_in_window_usd;

    // 11. Post-conditions: still plain vault-owned accounts.
    let vault_key = a.vault.key();
    for account in [&a.vault_input_account, &a.vault_output_account] {
        require!(
            account.owner == vault_key
                && account.delegate.is_none()
                && account.close_authority.is_none(),
            VaultError::TokenAccountTampered
        );
    }

    a.vault.last_swap_ts = now.unix_timestamp;
    emit!(Swapped {
        vault: vault_key,
        keeper: a.keeper.key(),
        input_mint: a.input_mint.key(),
        output_mint: a.output_mint.key(),
        spent,
        received,
        oracle_out,
        min_out,
        price_in: price_in.price as i64,
        price_in_expo: price_in.exponent,
        price_out: price_out.price as i64,
        price_out_expo: price_out.exponent,
        loss_usd,
        loss_in_window_usd,
    });
    Ok(())
}

/// Design §4.7 check 7. The venue gets the vault PDA's signature, so it could move any token
/// account the vault controls that is passed to it. Allowed: the vault PDA (the transfer
/// authority; `invoke_route` passes it read-only) and the input and output vault accounts.
/// Forbidden: the vault's other ATAs and any other token account whose authority is the vault.
fn screen_route_accounts(
    vault: &Account<Vault>,
    input_account: &Pubkey,
    output_account: &Pubkey,
    route: &[AccountInfo],
) -> Result<()> {
    let vault_key = vault.key();
    let vault_atas: Vec<Pubkey> = vault
        .allowed_mints
        .iter()
        .map(|m| get_associated_token_address(&vault_key, &m.mint))
        .collect();
    for account in route {
        let key = account.key();
        if key == *input_account || key == *output_account {
            continue;
        }
        // The vault PDA itself is allowed. It is writable in this transaction (swap updates
        // it), but `invoke_route` passes it to the venue read-only, and only this program
        // could change it anyway.
        if key == vault_key {
            continue;
        }
        require!(
            !vault_atas.contains(&key) && !is_token_account_of(account, &vault_key),
            VaultError::ForbiddenRouteAccount
        );
    }
    Ok(())
}

/// True if `account` is an SPL Token or Token-2022 token account whose authority is `owner`
/// (bytes 32..64 of the account data in both programs).
fn is_token_account_of(account: &AccountInfo, owner: &Pubkey) -> bool {
    let token_owned =
        *account.owner == anchor_spl::token::ID || *account.owner == anchor_spl::token_2022::ID;
    if !token_owned {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return true; // cannot inspect: treat as forbidden
    };
    data.len() >= 64 && data[32..64] == owner.to_bytes()
}

/// Invokes `swap_program` with the keeper's route: `route_data` and the remaining accounts,
/// signed by the vault PDA. The vault PDA is always passed as signer and read-only.
fn invoke_route<'info>(ctx: &Context<'info, Swap<'info>>, route_data: Vec<u8>) -> Result<()> {
    let a = &ctx.accounts;
    let vault_key = a.vault.key();
    let accounts = ctx
        .remaining_accounts
        .iter()
        .map(|info| AccountMeta {
            pubkey: info.key(),
            is_signer: info.is_signer || info.key() == vault_key,
            is_writable: info.is_writable && info.key() != vault_key,
        })
        .collect();
    let ix = Instruction {
        program_id: SWAP_PROGRAM_ID,
        accounts,
        data: route_data,
    };
    let mut infos = ctx.remaining_accounts.to_vec();
    infos.push(a.swap_program.to_account_info());
    infos.push(a.vault.to_account_info());

    let vault_id = a.vault.vault_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        VAULT_SEED,
        a.vault.owner.as_ref(),
        &vault_id,
        &[a.vault.bump],
    ];
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

/// The swap venue: Jupiter v6 aggregator. From Jupiter's official CPI crate
/// (github.com/jup-ag/jupiter-cpi), checked as a live executable program on mainnet on
/// 2026-10-05.
#[cfg(not(feature = "devnet-mock"))]
pub const SWAP_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// TEST-ONLY venue: programs/mock-swap, for devnet testing. Never enable `devnet-mock` in a
/// mainnet build.
#[cfg(feature = "devnet-mock")]
pub const SWAP_PROGRAM_ID: Pubkey = mock_swap::ID;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "devnet-mock"))]
    #[test]
    fn mainnet_build_pins_jupiter_v6() {
        assert_eq!(
            SWAP_PROGRAM_ID.to_string(),
            "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        );
    }

    #[cfg(feature = "devnet-mock")]
    #[test]
    fn devnet_mock_build_pins_mock_swap() {
        assert_eq!(SWAP_PROGRAM_ID, mock_swap::ID);
    }
}
