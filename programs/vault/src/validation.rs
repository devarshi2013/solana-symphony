//! Config checks shared by `initialize_vault` and `update_config` (design §4.1, §4.2).

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{constants::*, error::VaultError, state::AllowedMint};

/// 1 ≤ `max_slippage_bps` ≤ `MAX_SLIPPAGE_CAP_BPS` (500).
pub fn validate_slippage(max_slippage_bps: u16) -> Result<()> {
    require!(
        (1..=MAX_SLIPPAGE_CAP_BPS).contains(&max_slippage_bps),
        VaultError::SlippageAboveCap
    );
    Ok(())
}

/// 1 ≤ `max_oracle_staleness_secs` ≤ `MAX_STALENESS_CAP_SECS` (120).
pub fn validate_staleness(max_oracle_staleness_secs: u32) -> Result<()> {
    require!(
        (1..=MAX_STALENESS_CAP_SECS).contains(&max_oracle_staleness_secs),
        VaultError::StalenessAboveCap
    );
    Ok(())
}

/// 1 to 10 entries, no mint twice, no Pyth feed twice.
pub fn validate_allowed_mints(allowed: &[AllowedMint]) -> Result<()> {
    require!(
        (1..=MAX_ALLOWED_MINTS).contains(&allowed.len()),
        VaultError::InvalidMintCount
    );
    for (i, a) in allowed.iter().enumerate() {
        for b in &allowed[i + 1..] {
            require_keys_neq!(a.mint, b.mint, VaultError::DuplicateMint);
            require!(a.pyth_feed_id != b.pyth_feed_id, VaultError::DuplicateFeed);
        }
    }
    Ok(())
}

/// Checks that `accounts` are the mints in `allowed`, in order, and that each is an
/// initialized classic SPL Token mint. Token-2022 mints are rejected (design §6.8).
pub fn validate_mint_accounts(allowed: &[AllowedMint], accounts: &[AccountInfo]) -> Result<()> {
    require!(
        accounts.len() == allowed.len(),
        VaultError::MintAccountsMismatch
    );
    for (expected, account) in allowed.iter().zip(accounts) {
        require_keys_eq!(
            account.key(),
            expected.mint,
            VaultError::MintAccountsMismatch
        );
        require_keys_eq!(
            *account.owner,
            anchor_spl::token::ID,
            VaultError::UnsupportedTokenProgram
        );
        let data = account.try_borrow_data()?;
        Mint::try_deserialize(&mut &data[..]).map_err(|_| error!(VaultError::InvalidMint))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mint(seed: u8) -> AllowedMint {
        AllowedMint {
            mint: Pubkey::new_from_array([seed; 32]),
            pyth_feed_id: [seed; 32],
        }
    }

    fn code(result: Result<()>) -> u32 {
        match result.unwrap_err() {
            Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error {other:?}"),
        }
    }

    fn expected(e: VaultError) -> u32 {
        anchor_lang::error::ERROR_CODE_OFFSET + e as u32
    }

    #[test]
    fn slippage_bounds() {
        assert!(validate_slippage(1).is_ok());
        assert!(validate_slippage(500).is_ok());
        assert_eq!(
            code(validate_slippage(0)),
            expected(VaultError::SlippageAboveCap)
        );
        assert_eq!(
            code(validate_slippage(501)),
            expected(VaultError::SlippageAboveCap)
        );
    }

    #[test]
    fn staleness_bounds() {
        assert!(validate_staleness(1).is_ok());
        assert!(validate_staleness(120).is_ok());
        assert_eq!(
            code(validate_staleness(0)),
            expected(VaultError::StalenessAboveCap)
        );
        assert_eq!(
            code(validate_staleness(121)),
            expected(VaultError::StalenessAboveCap)
        );
    }

    #[test]
    fn allowed_mint_count() {
        assert_eq!(
            code(validate_allowed_mints(&[])),
            expected(VaultError::InvalidMintCount)
        );
        let ten: Vec<_> = (1..=10).map(mint).collect();
        assert!(validate_allowed_mints(&ten).is_ok());
        let eleven: Vec<_> = (1..=11).map(mint).collect();
        assert_eq!(
            code(validate_allowed_mints(&eleven)),
            expected(VaultError::InvalidMintCount)
        );
    }

    #[test]
    fn duplicates() {
        let same_mint = [
            mint(1),
            AllowedMint {
                pyth_feed_id: [9; 32],
                ..mint(1)
            },
        ];
        assert_eq!(
            code(validate_allowed_mints(&same_mint)),
            expected(VaultError::DuplicateMint)
        );
        let same_feed = [
            mint(1),
            AllowedMint {
                pyth_feed_id: [1; 32],
                ..mint(2)
            },
        ];
        assert_eq!(
            code(validate_allowed_mints(&same_feed)),
            expected(VaultError::DuplicateFeed)
        );
    }
}
