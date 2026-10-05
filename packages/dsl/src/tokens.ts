/**
 * Registry of tokens strategies may use.
 *
 * Every value was checked against an official source (URL beside it). Mint addresses were
 * also confirmed on-chain to be SPL token mints, and decimals were read from those mints.
 * A value that could not be confirmed from an official source is a `TODO: ...` string;
 * check with `isTodo` before using one.
 */

/** Placeholder for a value not yet confirmed from an official source. */
export type Todo = `TODO: ${string}`;

export interface TokenInfo {
  /** Symbol used in strategies. Case-sensitive. */
  symbol: string;
  /** Full token name. */
  name: string;
  /** Number of decimal places in the token's on-chain amounts. */
  decimals: number | Todo;
  /** SPL token mint address on mainnet-beta. */
  mainnetMint: string | Todo;
  /** SPL token mint address on devnet, or null if the issuer publishes none. */
  devnetMint: string | null;
  /** Pyth price feed ID for the token's USD price (hex, 0x-prefixed). */
  pythFeedId: string | Todo;
}

// Decimals for every confirmed mint: read from the mint account on mainnet-beta, viewable at
// https://explorer.solana.com/address/<mint>
// Pyth feed IDs: Pyth's official Hermes API, feed "Crypto.<SYMBOL>/USD", at
// https://hermes.pyth.network/v2/price_feeds?query=<SYMBOL>&asset_type=crypto

export const TOKENS = {
  SOL: {
    symbol: "SOL",
    name: "Wrapped SOL",
    decimals: 9,
    // Native mint, same address on every cluster: https://solana.com/docs/tokens/basics/sync-native
    mainnetMint: "So11111111111111111111111111111111111111112",
    // https://solana.com/docs/tokens/basics/sync-native
    devnetMint: "So11111111111111111111111111111111111111112",
    // Crypto.SOL/USD: https://hermes.pyth.network/v2/price_feeds?query=SOL&asset_type=crypto
    pythFeedId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    // https://developers.circle.com/stablecoins/usdc-contract-addresses
    mainnetMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    // https://developers.circle.com/stablecoins/usdc-contract-addresses
    devnetMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    // Crypto.USDC/USD: https://hermes.pyth.network/v2/price_feeds?query=USDC&asset_type=crypto
    pythFeedId: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  JUP: {
    symbol: "JUP",
    name: "Jupiter",
    decimals: 6,
    // Example response listing symbol "JUP", name "Jupiter":
    // https://developers.jup.ag/docs/api-reference/tokens/search
    mainnetMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    // Jupiter publishes no devnet mint.
    devnetMint: null,
    // Crypto.JUP/USD: https://hermes.pyth.network/v2/price_feeds?query=JUP&asset_type=crypto
    pythFeedId: "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  },
  JTO: {
    symbol: "JTO",
    name: "Jito",
    decimals: 9,
    // Jito Foundation memorandum defines JTO tokens by this mint address:
    // https://github.com/jito-foundation/jito-omnidocs/blob/183e11244bd0eb432d07b1b83e44c0d63191c7c7/governance/amended-and-restated-memorandum-of-association/index.md
    mainnetMint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    // Jito publishes no devnet JTO mint.
    devnetMint: null,
    // Crypto.JTO/USD: https://hermes.pyth.network/v2/price_feeds?query=JTO&asset_type=crypto
    pythFeedId: "0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  },
  BONK: {
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    // Official site's "Buy BONK" links swap into this mint (see the OKX DEX link):
    // https://bonkcoin.com
    mainnetMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    // The BONK team publishes no devnet mint.
    devnetMint: null,
    // Crypto.BONK/USD: https://hermes.pyth.network/v2/price_feeds?query=BONK&asset_type=crypto
    pythFeedId: "0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  },
  JitoSOL: {
    symbol: "JitoSOL",
    name: "Jito Staked SOL",
    decimals: 9,
    // https://www.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs/
    mainnetMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    // https://www.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs/
    devnetMint: "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi",
    // Crypto.JITOSOL/USD: https://hermes.pyth.network/v2/price_feeds?query=JITOSOL&asset_type=crypto
    pythFeedId: "0x67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb",
  },
  mSOL: {
    symbol: "mSOL",
    name: "Marinade Staked SOL",
    decimals: 9,
    // https://docs.marinade.finance/developers/contract-addresses
    mainnetMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    // Same address on devnet: https://docs.marinade.finance/developers/contract-addresses
    devnetMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    // Crypto.MSOL/USD: https://hermes.pyth.network/v2/price_feeds?query=MSOL&asset_type=crypto
    pythFeedId: "0xc2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4",
  },
  WIF: {
    symbol: "WIF",
    name: "dogwifhat",
    decimals: "TODO: read from the mint account once the mint is confirmed",
    // https://dogwifcoin.org blocked automated access and no other official source was found.
    mainnetMint: "TODO: confirm the WIF mint from an official dogwifhat source",
    // No official devnet mint found.
    devnetMint: null,
    // Crypto.WIF/USD: https://hermes.pyth.network/v2/price_feeds?query=WIF&asset_type=crypto
    pythFeedId: "0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
  },
} as const satisfies Record<string, TokenInfo>;

export type TokenSymbol = keyof typeof TOKENS;

export const TOKEN_SYMBOLS = Object.keys(TOKENS) as TokenSymbol[];

export function isTodo(value: unknown): value is Todo {
  return typeof value === "string" && value.startsWith("TODO:");
}

export function isSupportedSymbol(symbol: string): symbol is TokenSymbol {
  return Object.hasOwn(TOKENS, symbol);
}

/**
 * Returns an error message if `symbol` is not in the registry, otherwise undefined.
 * Suggests the registered spelling when only the case differs (e.g. "jitosol").
 */
export function checkTokenSymbol(symbol: string): string | undefined {
  if (isSupportedSymbol(symbol)) return undefined;
  const sameIgnoringCase = TOKEN_SYMBOLS.find((s) => s.toLowerCase() === symbol.toLowerCase());
  if (sameIgnoringCase) return `unsupported token "${symbol}"; did you mean "${sameIgnoringCase}"?`;
  return `unsupported token "${symbol}"; supported: ${TOKEN_SYMBOLS.join(", ")}`;
}
