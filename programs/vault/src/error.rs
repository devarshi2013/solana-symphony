use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Only the vault owner can do this")]
    Unauthorized,
    #[msg("Only the vault's keeper can swap")]
    NotKeeper,
    #[msg("This vault has no keeper set, so swaps are disabled")]
    KeeperNotSet,
    #[msg("The vault is paused: swaps are disabled (deposits and withdrawals still work)")]
    VaultPaused,
    #[msg("This mint is not in the vault's allowed mints")]
    MintNotAllowed,
    #[msg("Swap input and output mints must be different")]
    SameMint,
    #[msg("A vault must allow between 1 and 10 mints")]
    InvalidMintCount,
    #[msg("Each mint may appear only once in the allowed mints")]
    DuplicateMint,
    #[msg("Each Pyth feed may be used by only one allowed mint")]
    DuplicateFeed,
    #[msg("Pass one mint account per allowed mint, in the same order as allowed_mints")]
    MintAccountsMismatch,
    #[msg("Account is not an initialized SPL Token mint")]
    InvalidMint,
    #[msg("Only classic SPL Token mints are supported (not Token-2022)")]
    UnsupportedTokenProgram,
    #[msg("Token account is not the vault's associated token account for this mint")]
    InvalidTokenAccount,
    #[msg("Withdrawals can only go to a token account owned by the vault owner")]
    InvalidDestination,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The vault does not hold enough of this token")]
    InsufficientBalance,
    #[msg("max_slippage_bps must be between 1 and 500 (5%)")]
    SlippageAboveCap,
    #[msg("max_oracle_staleness_secs must be between 1 and 120")]
    StalenessAboveCap,
    #[msg("Price account is not a verified Pyth price update")]
    InvalidOracleAccount,
    #[msg("Price update is for a different feed than this mint's configured Pyth feed")]
    OracleFeedMismatch,
    #[msg("Price is older than the vault's max_oracle_staleness_secs")]
    StalePrice,
    #[msg("Price confidence interval is wider than 2% of the price")]
    PriceTooUncertain,
    #[msg("Oracle price must be positive")]
    NonPositivePrice,
    #[msg("Swaps may only call the Jupiter program")]
    InvalidSwapProgram,
    #[msg("Swap route includes a vault token account other than the input and output")]
    ForbiddenRouteAccount,
    #[msg("Swap spent more of the input token than amount_in")]
    SpentMoreThanAmountIn,
    #[msg("Swap delivered nothing to the vault's output account")]
    NothingReceived,
    #[msg("Swap output is below the oracle-based minimum (or the keeper's minimum)")]
    OutputBelowMinimum,
    #[msg(
        "A vault token account's authority, delegate or close authority changed during the swap"
    )]
    TokenAccountTampered,
    #[msg("Too soon since the last swap: wait for the swap cooldown")]
    SwapCooldown,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Not implemented yet")]
    NotImplemented,
    #[msg("This swap's loss against the oracle would exceed the vault's daily loss limit")]
    DailyLossLimitExceeded,
    #[msg("The input and output price updates were published too far apart")]
    PriceSkewTooLarge,
}
