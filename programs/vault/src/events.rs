use anchor_lang::prelude::*;

use crate::state::AllowedMint;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub vault_id: u64,
    pub keeper: Pubkey,
    pub allowed_mints: Vec<AllowedMint>,
    pub max_slippage_bps: u16,
    pub max_oracle_staleness_secs: u32,
    pub strategy_hash: [u8; 32],
    pub max_daily_loss_usd: u64,
}

#[event]
pub struct ConfigUpdated {
    pub vault: Pubkey,
    pub allowed_mints: Vec<AllowedMint>,
    pub max_slippage_bps: u16,
    pub max_oracle_staleness_secs: u32,
    pub strategy_hash: [u8; 32],
    pub max_daily_loss_usd: u64,
}

#[event]
pub struct KeeperChanged {
    pub vault: Pubkey,
    pub old_keeper: Pubkey,
    pub new_keeper: Pubkey,
}

#[event]
pub struct PausedChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    /// Vault balance of `mint` after the deposit.
    pub vault_balance: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    /// Vault balance of `mint` after the withdrawal.
    pub vault_balance: u64,
}

/// Everything needed to audit a swap against the oracle afterwards.
#[event]
pub struct Swapped {
    pub vault: Pubkey,
    pub keeper: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    /// Input actually spent (base units).
    pub spent: u64,
    /// Output actually received by the vault (base units).
    pub received: u64,
    /// Output the oracle prices imply for `spent`, before slippage.
    pub oracle_out: u64,
    /// The minimum the swap had to meet.
    pub min_out: u64,
    pub price_in: i64,
    pub price_in_expo: i32,
    pub price_out: i64,
    pub price_out_expo: i32,
    /// This swap's shortfall versus the oracle, in micro-USD (0 if it met or beat it).
    pub loss_usd: u64,
    /// Losses in the current 24-hour window including this swap, in micro-USD.
    pub loss_in_window_usd: u64,
}
