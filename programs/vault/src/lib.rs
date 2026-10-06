//! Owner-custodied vault, rebalanced by a keeper through Jupiter swaps.
//! Design: docs/vault-design.md.
//!
//! The `devnet-mock` feature is TEST-ONLY: it routes `swap` through programs/mock-swap
//! instead of Jupiter. Never enable it for a mainnet build.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod price;
pub mod state;
pub mod validation;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("5RAyigJyfZDreAfJsGufXcgtRraMq1hrEp3sm2nZqsHG");

#[program]
pub mod vault {
    use super::*;

    /// Creates a vault owned by the signer (owner only).
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        args: InitializeVaultArgs,
    ) -> Result<()> {
        instructions::initialize_vault::handle_initialize_vault(ctx, args)
    }

    /// Changes allowed mints, slippage, staleness or strategy hash (owner only).
    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::update_config::handle_update_config(ctx, args)
    }

    /// Sets or removes the keeper (owner only).
    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        instructions::set_keeper::handle_set_keeper(ctx, new_keeper)
    }

    /// Pauses or resumes swaps (owner only).
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handle_set_paused(ctx, paused)
    }

    /// Moves tokens from the owner into the vault's ATA, creating it if needed
    /// (owner only, allowed mints only; works while paused).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Moves tokens from the vault's ATA to the owner's ATA, signed by the vault PDA
    /// (owner only; any mint; works while paused).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, amount)
    }

    /// Swaps between two allowed mints (keeper only) through Jupiter v6, checked against Pyth
    /// prices: `route_data` and the remaining accounts are Jupiter's swap instruction. The
    /// TEST-ONLY `devnet-mock` build pins programs/mock-swap instead.
    pub fn swap<'info>(
        ctx: Context<'info, Swap<'info>>,
        amount_in: u64,
        keeper_min_out: u64,
        route_data: Vec<u8>,
    ) -> Result<()> {
        instructions::swap::handle_swap(ctx, amount_in, keeper_min_out, route_data)
    }
}
