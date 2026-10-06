use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, error::VaultError, events::Withdrawn, state::*};

/// Design §4.6. Owner only. Deliberately has no paused check and no allowed-mint check, so
/// funds can never be trapped. Tokens can only go to the owner's own ATA.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ VaultError::Unauthorized,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    let vault_balance = ctx
        .accounts
        .vault_token_account
        .amount
        .checked_sub(amount)
        .ok_or(VaultError::InsufficientBalance)?;

    let vault = &ctx.accounts.vault;
    let vault_id = vault.vault_id.to_le_bytes();
    let seeds: &[&[u8]] = &[VAULT_SEED, vault.owner.as_ref(), &vault_id, &[vault.bump]];

    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.vault_token_account.reload()?;
    require!(
        ctx.accounts.vault_token_account.amount == vault_balance,
        VaultError::TokenAccountTampered
    );

    emit!(Withdrawn {
        vault: ctx.accounts.vault.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        destination: ctx.accounts.owner_token_account.key(),
        vault_balance,
    });
    Ok(())
}
