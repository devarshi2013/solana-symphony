use anchor_lang::prelude::*;

/// PDA seed prefix: `["vault", owner, vault_id.to_le_bytes()]`.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Most mints a vault can allow (design §2.1). A `usize` because it sizes the account's
/// `allowed_mints` list, which is also why it is not exported to the IDL with `#[constant]`.
pub const MAX_ALLOWED_MINTS: usize = 10;

/// Basis-point denominator: 10_000 bps = 100%.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Hard ceiling on `max_slippage_bps` an owner can set: 5% (design §3, Q2).
#[constant]
pub const MAX_SLIPPAGE_CAP_BPS: u16 = 500;

/// Hard ceiling on `max_oracle_staleness_secs` an owner can set (design §3, Q2).
#[constant]
pub const MAX_STALENESS_CAP_SECS: u32 = 120;

/// Reject a price whose confidence interval is wider than 2% of the price (design §3, Q3).
#[constant]
pub const MAX_CONFIDENCE_BPS: u64 = 200;

/// Minimum time between swaps on one vault, limiting fee bleed (design §6.15, Q5).
#[constant]
pub const MIN_SWAP_INTERVAL_SECS: i64 = 60;

/// Length of the window `max_daily_loss_usd` applies to (security review H-1).
#[constant]
pub const LOSS_WINDOW_SECS: i64 = 86_400;

/// The input and output price updates of one swap must be published at most this far apart,
/// so the keeper cannot pair prices from different moments (security review M-1).
#[constant]
pub const MAX_PRICE_SKEW_SECS: i64 = 30;

/// Decimals of the USD amounts the vault stores (micro-USD).
pub const USD_DECIMALS: i64 = 6;

/// Pyth Solana Receiver program, which owns `PriceUpdateV2` accounts. Same address on
/// mainnet and devnet (checked against docs.pyth.network contract addresses, 2026-10-05);
/// `Account<PriceUpdateV2>` enforces it as the owner.
pub use pyth_solana_receiver_sdk::ID as PYTH_RECEIVER_PROGRAM_ID;

// The swap venue's program ID (Jupiter v6, or mock-swap in a devnet-mock build) is
// `instructions::swap::SWAP_PROGRAM_ID`.
