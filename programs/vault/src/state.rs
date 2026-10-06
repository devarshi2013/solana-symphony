use anchor_lang::prelude::*;

use crate::constants::MAX_ALLOWED_MINTS;

/// A mint the vault may hold and swap, with the Pyth feed that prices it in USD.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct AllowedMint {
    /// Classic SPL Token mint (Token-2022 is rejected, design §6.8).
    pub mint: Pubkey,
    /// Pyth USD price feed ID for this mint, e.g. SOL/USD for wSOL. The swap reads the
    /// price only from an update for this feed, so the keeper cannot choose the price.
    pub pyth_feed_id: [u8; 32],
}

/// One owner's vault. PDA seeds: `["vault", owner, vault_id.to_le_bytes()]`.
///
/// Tokens are held in the vault PDA's associated token accounts, one per mint. The owner
/// deposits, withdraws and configures; the keeper may only swap between allowed mints.
#[account]
#[derive(InitSpace, Debug)]
pub struct Vault {
    /// Signs every instruction except `swap`. Immutable.
    pub owner: Pubkey,
    /// Part of the PDA seeds, so one owner can have several vaults. Immutable.
    pub vault_id: u64,
    /// The only key that may call `swap`. `Pubkey::default()` means no keeper.
    pub keeper: Pubkey,
    /// Mints the vault may receive by deposit or swap. No duplicates.
    #[max_len(MAX_ALLOWED_MINTS)]
    pub allowed_mints: Vec<AllowedMint>,
    /// Largest shortfall a swap may have versus the oracle value, in bps.
    pub max_slippage_bps: u16,
    /// Oldest price a swap may use, in seconds.
    pub max_oracle_staleness_secs: u32,
    /// SHA-256 of the strategy JSON the owner approved. Informational, not enforced.
    pub strategy_hash: [u8; 32],
    /// When true, `swap` is blocked. Deposits and withdrawals still work.
    pub paused: bool,
    /// Unix time of the last swap, for the swap cooldown.
    pub last_swap_ts: i64,
    /// Canonical PDA bump.
    pub bump: u8,
    /// Most the vault may lose to swaps per 24 hours, versus the oracle, in micro-USD
    /// (USD × 10^6). Bounds what a compromised keeper can extract (security review H-1).
    pub max_daily_loss_usd: u64,
    /// Start (unix seconds) of the current 24-hour loss window.
    pub loss_window_start: i64,
    /// Losses counted in the current window, in micro-USD.
    pub loss_in_window_usd: u64,
    /// Space for future fields without reallocating.
    pub _reserved: [u8; 40],
}

impl Vault {
    /// Account size including Anchor's 8-byte discriminator, allocated for the maximum
    /// number of mints so `update_config` never needs to reallocate.
    pub const SPACE: usize = 8 + Self::INIT_SPACE;

    pub fn find_allowed(&self, mint: &Pubkey) -> Option<&AllowedMint> {
        self.allowed_mints.iter().find(|m| m.mint == *mint)
    }

    pub fn has_keeper(&self) -> bool {
        self.keeper != Pubkey::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_matches_design() {
        // design §2.1: 8 + 32 + 8 + 32 + (4 + 10 * 64) + 2 + 4 + 32 + 1 + 8 + 1
        //   + 8 + 8 + 8 (loss limit, security review H-1) + 40 reserved
        assert_eq!(Vault::SPACE, 836);
    }

    #[test]
    fn find_allowed_and_has_keeper() {
        let sol = Pubkey::new_unique();
        let vault = Vault {
            owner: Pubkey::new_unique(),
            vault_id: 0,
            keeper: Pubkey::default(),
            allowed_mints: vec![AllowedMint {
                mint: sol,
                pyth_feed_id: [1; 32],
            }],
            max_slippage_bps: 50,
            max_oracle_staleness_secs: 60,
            strategy_hash: [0; 32],
            paused: false,
            last_swap_ts: 0,
            bump: 255,
            max_daily_loss_usd: 0,
            loss_window_start: 0,
            loss_in_window_usd: 0,
            _reserved: [0; 40],
        };
        assert_eq!(
            vault.find_allowed(&sol).map(|m| m.pyth_feed_id),
            Some([1; 32])
        );
        assert!(vault.find_allowed(&Pubkey::new_unique()).is_none());
        assert!(!vault.has_keeper());
    }
}
