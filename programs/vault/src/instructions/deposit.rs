use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, error::VaultError, events::Deposited, state::*};

/// Design §4.5. Works while paused (Q4). The vault's ATA is created on the first deposit of a
/// mint; if it already exists Anchor checks it is the canonical ATA for (vault, mint).
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ VaultError::Unauthorized,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        constraint = vault.find_allowed(&mint.key()).is_some() @ VaultError::MintNotAllowed
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.owner_token_account.amount >= amount,
        VaultError::InsufficientBalance
    );
    let expected_balance = ctx
        .accounts
        .vault_token_account
        .amount
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    ctx.accounts.vault_token_account.reload()?;
    let vault_balance = ctx.accounts.vault_token_account.amount;
    require!(
        vault_balance == expected_balance,
        VaultError::TokenAccountTampered
    );

    emit!(Deposited {
        vault: ctx.accounts.vault.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        vault_balance,
    });
    Ok(())
}
