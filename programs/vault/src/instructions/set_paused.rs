use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError, events::PausedChanged, state::*};

/// Design §4.4. Pausing blocks `swap` only.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ VaultError::Unauthorized,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
}

pub fn handle_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.paused = paused;
    emit!(PausedChanged {
        vault: vault.key(),
        paused,
    });
    Ok(())
}
