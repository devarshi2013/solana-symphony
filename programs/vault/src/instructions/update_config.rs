use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError, events::ConfigUpdated, state::*, validation::*};

/// Fields left as `None` are unchanged.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateConfigArgs {
    pub allowed_mints: Option<Vec<AllowedMint>>,
    pub max_slippage_bps: Option<u16>,
    pub max_oracle_staleness_secs: Option<u32>,
    pub strategy_hash: Option<[u8; 32]>,
    /// Micro-USD per 24 hours; takes effect immediately, losses already counted stay counted.
    pub max_daily_loss_usd: Option<u64>,
}

/// Design §4.2. Remaining accounts: the mint accounts for a new `allowed_mints`, in order.
/// Removing a mint the vault still holds is allowed: `withdraw` works for any mint.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ VaultError::Unauthorized,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    // Validate everything before changing anything.
    if let Some(allowed) = &args.allowed_mints {
        validate_allowed_mints(allowed)?;
        validate_mint_accounts(allowed, ctx.remaining_accounts)?;
    }
    if let Some(bps) = args.max_slippage_bps {
        validate_slippage(bps)?;
    }
    if let Some(secs) = args.max_oracle_staleness_secs {
        validate_staleness(secs)?;
    }

    let vault = &mut ctx.accounts.vault;
    if let Some(allowed) = args.allowed_mints {
        vault.allowed_mints = allowed;
    }
    if let Some(bps) = args.max_slippage_bps {
        vault.max_slippage_bps = bps;
    }
    if let Some(secs) = args.max_oracle_staleness_secs {
        vault.max_oracle_staleness_secs = secs;
    }
    if let Some(hash) = args.strategy_hash {
        vault.strategy_hash = hash;
    }
    if let Some(limit) = args.max_daily_loss_usd {
        vault.max_daily_loss_usd = limit;
    }

    emit!(ConfigUpdated {
        vault: vault.key(),
        allowed_mints: vault.allowed_mints.clone(),
        max_slippage_bps: vault.max_slippage_bps,
        max_oracle_staleness_secs: vault.max_oracle_staleness_secs,
        strategy_hash: vault.strategy_hash,
        max_daily_loss_usd: vault.max_daily_loss_usd,
    });
    Ok(())
}
