/**
 * Example: create a vault on devnet, deposit 1000 tUSDC, print its balances.
 *
 *   pnpm --filter @solana-symphony/vault-client example
 *
 * Env: CLUSTER (default devnet; reads deployments/<cluster>.json), OWNER_KEYPAIR (default
 * keypairs/devnet-deployer.json), VAULT_ID (default 0). Re-running reuses the vault and
 * deposits another 1000 tUSDC. If the owner is the tUSDC mint authority (the deployer is),
 * it mints the owner any tUSDC it is short of.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";

import { formatUnits, keypairWallet, parseUnits, VaultClient } from "./dist/index.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const cluster = process.env.CLUSTER ?? "devnet";
const ownerPath = process.env.OWNER_KEYPAIR ?? join(ROOT, "keypairs/devnet-deployer.json");
const vaultId = BigInt(process.env.VAULT_ID ?? "0");

const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(ownerPath, "utf8")) as number[]),
);
const client = VaultClient.fromCluster(cluster, keypairWallet(owner), {
  deploymentsDir: join(ROOT, "deployments"),
});
const { connection } = client;
console.log(`cluster ${cluster} (${client.deployment.rpc}), owner ${owner.publicKey.toBase58()}`);

// 1. The vault: created once, reused after.
const vault = client.vaultAddress(owner.publicKey, vaultId);
if (await client.getVault(vault)) {
  console.log(`vault ${vault.toBase58()} exists`);
} else {
  const { signature } = await client.createVault({
    vaultId,
    mints: ["tUSDC", "tSOL", "tJUP"],
    maxSlippageBps: 100,
    maxOracleStalenessSecs: 120,
    maxDailyLossUsd: 25, // a compromised keeper could cost at most $25 a day
  });
  console.log(`created vault ${vault.toBase58()} (${signature})`);
}

// 2. 1000 tUSDC in the owner's wallet (minted if the owner is the mint authority).
const usdc = client.mint("tUSDC");
const amount = parseUnits("1000", usdc.info!.decimals);
const ownerAta = await getOrCreateAssociatedTokenAccount(
  connection,
  owner,
  usdc.address,
  owner.publicKey,
);
if (ownerAta.amount < amount) {
  const mintInfo = await getMint(connection, usdc.address);
  if (!mintInfo.mintAuthority?.equals(owner.publicKey)) {
    throw new Error(
      `owner holds ${formatUnits(ownerAta.amount, mintInfo.decimals)} tUSDC and cannot mint more`,
    );
  }
  await mintTo(connection, owner, usdc.address, ownerAta.address, owner, amount - ownerAta.amount);
  console.log(
    `minted ${formatUnits(amount - ownerAta.amount, mintInfo.decimals)} tUSDC to the owner`,
  );
}

// 3. Deposit.
const signature = await client.deposit({ vault, mint: "tUSDC", amount });
console.log(`deposited 1000 tUSDC (${signature})`);

// 4. Balances.
const state = await client.getVault(vault);
console.log(
  `\nvault ${vault.toBase58()}  keeper: ${state?.keeper?.toBase58() ?? "none"}  paused: ${state?.paused}`,
);
console.table(
  (await client.getBalances(vault)).map((b) => ({
    token: b.name ?? b.mint.toBase58(),
    balance: b.uiAmount,
    allowed: b.allowed,
    account: b.tokenAccount.toBase58(),
  })),
);
const left = (
  await getOrCreateAssociatedTokenAccount(connection, owner, usdc.address, owner.publicKey)
).amount;
console.log(
  `owner wallet: ${formatUnits(left, usdc.info!.decimals)} tUSDC (${getAssociatedTokenAddressSync(usdc.address, owner.publicKey).toBase58()})`,
);
