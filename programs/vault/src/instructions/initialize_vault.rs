use anchor_lang::prelude::*;

use crate::{constants::*, events::VaultInitialized, state::*, validation::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeVaultArgs {
    pub vault_id: u64,
    /// `Pubkey::default()` for no keeper (swaps disabled until set_keeper).
    pub keeper: Pubkey,
    pub allowed_mints: Vec<AllowedMint>,
    pub max_slippage_bps: u16,
    pub max_oracle_staleness_secs: u32,
    pub strategy_hash: [u8; 32],
    /// Most the vault may lose to swaps per 24 hours versus the oracle, in micro-USD.
    /// 0 allows no loss at all (every swap must match or beat the oracle).
    pub max_daily_loss_usd: u64,
}

/// Design §4.1. Remaining accounts: one mint account per entry in `allowed_mints`, in order.
#[derive(Accounts)]
#[instruction(args: InitializeVaultArgs)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Vault::SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref(), &args.vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(
    ctx: Context<InitializeVault>,
    args: InitializeVaultArgs,
) -> Result<()> {
    validate_allowed_mints(&args.allowed_mints)?;
    validate_mint_accounts(&args.allowed_mints, ctx.remaining_accounts)?;
    validate_slippage(args.max_slippage_bps)?;
    validate_staleness(args.max_oracle_staleness_secs)?;

    let owner = ctx.accounts.owner.key();
    ctx.accounts.vault.set_inner(Vault {
        owner,
        vault_id: args.vault_id,
        keeper: args.keeper,
        allowed_mints: args.allowed_mints.clone(),
        max_slippage_bps: args.max_slippage_bps,
        max_oracle_staleness_secs: args.max_oracle_staleness_secs,
        strategy_hash: args.strategy_hash,
        paused: false,
        last_swap_ts: 0,
        bump: ctx.bumps.vault,
        max_daily_loss_usd: args.max_daily_loss_usd,
        loss_window_start: 0,
        loss_in_window_usd: 0,
        _reserved: [0; 40],
    });

    emit!(VaultInitialized {
        vault: ctx.accounts.vault.key(),
        owner,
        vault_id: args.vault_id,
        keeper: args.keeper,
        allowed_mints: args.allowed_mints,
        max_slippage_bps: args.max_slippage_bps,
        max_oracle_staleness_secs: args.max_oracle_staleness_secs,
        strategy_hash: args.strategy_hash,
        max_daily_loss_usd: args.max_daily_loss_usd,
    });
    Ok(())
}
