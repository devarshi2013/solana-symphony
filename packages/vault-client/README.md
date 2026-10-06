# @solana-symphony/vault-client

Typed TypeScript client for the vault program (`programs/vault`), built on its Anchor IDL.
Program and mint addresses come from `deployments/<cluster>.json`, written by
`pnpm deploy:devnet`.

```ts
import { keypairWallet, parseUnits, VaultClient } from "@solana-symphony/vault-client";

const client = VaultClient.fromCluster("devnet", keypairWallet(owner));
const { vault } = await client.createVault({
  mints: ["tUSDC", "tSOL", "tJUP"],
  maxDailyLossUsd: 25, // most a compromised keeper could cost per day
});
await client.deposit({ vault, mint: "tUSDC", amount: parseUnits("1000", 6) });
console.log(await client.getBalances(vault));
```

| Method                                                                                                                | What it does                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVault({ mints, maxDailyLossUsd, vaultId?, keeper?, maxSlippageBps?, maxOracleStalenessSecs?, strategyHash? })` | Creates a vault owned by the wallet. Mints by deployment name (their Pyth feeds come from the deployment) or `{ mint, pythFeedId }`.                                                  |
| `deposit({ vault, mint, amount })`                                                                                    | Owner's ATA → vault's ATA (created if needed).                                                                                                                                        |
| `withdraw({ vault, mint, amount })`                                                                                   | Vault → owner's ATA (created if needed). Works while paused.                                                                                                                          |
| `setKeeper(vault, keeper \| null)`, `setPaused(vault, paused)`                                                        | Owner-only settings.                                                                                                                                                                  |
| `updateConfig(vault, { mints?, maxSlippageBps?, maxOracleStalenessSecs?, strategyHash?, maxDailyLossUsd? })`          | Only the fields given change.                                                                                                                                                         |
| `getVault(vault)`                                                                                                     | Decoded state (bigint ids, hex feed ids, mint names), or `null`.                                                                                                                      |
| `getBalances(vault)`                                                                                                  | Every token account the vault controls, plus zero rows for allowed mints it does not hold yet.                                                                                        |
| `buildSwapIx({ vault, inputMint, outputMint, amountIn, keeperMinOut?, route })`                                       | The keeper's swap instruction. `route` is the venue instruction (Jupiter's `swapInstruction`, or mock-swap's on a `devnet-mock` deployment); refused if it targets any other program. |

Amounts are base units (`bigint`); `parseUnits("1000.5", 6)` and `formatUnits` convert. Each
method has an `…Ix` twin (`depositIx`, …) that only builds the instruction(s).

**Example:** `pnpm --filter @solana-symphony/vault-client example` creates (or reuses) a vault
for `keypairs/devnet-deployer.json`, deposits 1000 tUSDC (minting it if the owner is the mint
authority) and prints the balances. Set `CLUSTER=localnet` for a local rehearsal deployment.

**IDL:** `src/idl/vault.ts` is generated from `target/` by `pnpm sync-idl`. Re-run it after
changing the program; a test fails while the copy is stale.
