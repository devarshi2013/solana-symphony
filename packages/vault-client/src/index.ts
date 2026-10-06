// TypeScript client for the on-chain vault program.
export const VAULT_CLIENT_PACKAGE_NAME = "@solana-symphony/vault-client";

export {
  JUPITER_PROGRAM_ID,
  keypairWallet,
  VAULT_SEED,
  vaultAddress,
  VaultClient,
  type AllowedMintInput,
  type Amount,
  type BuildSwapArgs,
  type CreateVaultArgs,
  type MintRef,
  type SwapRoute,
  type TokenBalance,
  type UpdateConfigArgs,
  type VaultClientOptions,
  type VaultState,
  type VaultWallet,
} from "./client.js";
export {
  DeploymentError,
  deploymentPath,
  loadDeployment,
  parseDeployment,
  type DeployedMint,
  type Deployment,
} from "./deployments.js";
export { VAULT_IDL, type Vault } from "./idl/vault.js";
export { formatUnits, parseUnits } from "./units.js";
