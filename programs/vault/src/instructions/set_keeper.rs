use anchor_lang::prelude::*;

use crate::{constants::*, error::VaultError, events::KeeperChanged, state::*};

/// Design §4.3. `Pubkey::default()` removes the keeper.
#[derive(Accounts)]
pub struct SetKeeper<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ VaultError::Unauthorized,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
}

pub fn handle_set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let old_keeper = vault.keeper;
    vault.keeper = new_keeper;
    emit!(KeeperChanged {
        vault: vault.key(),
        old_keeper,
        new_keeper,
    });
    Ok(())
}
