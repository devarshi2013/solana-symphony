/**
 * End-to-end tests for the vault program on a local validator, through the Anchor TS client.
 * Run with `pnpm test:program:ts` (anchor test). Two fresh SPL mints stand in for USDC (6
 * decimals) and SOL (9 decimals); they are test mints, not the real ones.
 */
import { readFileSync } from "node:fs";

import {
  AnchorError,
  AnchorProvider,
  BN,
  EventParser,
  Program,
  setProvider,
  type Idl,
} from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type AccountMeta,
} from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { Vault } from "../../../target/types/vault.js";

const idl = JSON.parse(
  readFileSync(new URL("../../../target/idl/vault.json", import.meta.url), "utf8"),
) as Idl;

const provider = AnchorProvider.env();
setProvider(provider);
const program = new Program(idl, provider) as unknown as Program<Vault>;
const connection = provider.connection;

/** Pays for mints and transaction fees; the mint authority for both test mints. */
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8")) as number[]),
);

const owner = Keypair.generate();
const keeper = Keypair.generate();
const stranger = Keypair.generate();

const VAULT_ID = new BN(1);
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), owner.publicKey.toBuffer(), VAULT_ID.toArrayLike(Buffer, "le", 8)],
  program.programId,
);

let usdc: PublicKey;
let sol: PublicKey;
/** A third mint the vault never allows. */
let junk: PublicKey;

const ata = (authority: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, authority, true);
const balance = async (account: PublicKey) => (await getAccount(connection, account)).amount;

async function airdrop(to: PublicKey, sol = 10) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({
    signature: sig,
    ...(await connection.getLatestBlockhash()),
  });
}

/** Creates `authority`'s ATA for `mint` and mints `amount` base units into it. */
async function fund(authority: PublicKey, mint: PublicKey, amount: bigint) {
  const account = await createAssociatedTokenAccount(connection, payer, mint, authority);
  if (amount > 0n) await mintTo(connection, payer, mint, account, payer, amount);
  return account;
}

/** Asserts the call fails with this vault error (by name, e.g. "Unauthorized"). */
async function expectVaultError(call: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await call;
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}, but the transaction succeeded`).toBeDefined();
  const parsed =
    error instanceof AnchorError
      ? error
      : AnchorError.parse((error as { logs?: string[] }).logs ?? []);
  expect(parsed?.error.errorCode.code, String(error)).toBe(code);
}

/** Events emitted by a transaction. Waits until it is confirmed: `rpc()` returns earlier. */
async function events(signature: string) {
  await connection.confirmTransaction(
    { signature, ...(await connection.getLatestBlockhash()) },
    "confirmed",
  );
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  expect(tx, `transaction ${signature} not found`).not.toBeNull();
  const parser = new EventParser(program.programId, program.coder);
  return [...parser.parseLogs(tx?.meta?.logMessages ?? [])];
}

const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const feed = (n: number) => Array<number>(32).fill(n);
const mintMetas = (...mints: PublicKey[]): AccountMeta[] =>
  mints.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));

function deposit(signer: Keypair, mint: PublicKey, from: PublicKey, amount: number | bigint) {
  return program.methods
    .deposit(new BN(amount.toString()))
    .accountsStrict({
      owner: signer.publicKey,
      vault,
      mint,
      ownerTokenAccount: from,
      vaultTokenAccount: ata(vault, mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
}

function withdraw(signer: Keypair, mint: PublicKey, to: PublicKey, amount: number | bigint) {
  return program.methods
    .withdraw(new BN(amount.toString()))
    .accountsStrict({
      owner: signer.publicKey,
      vault,
      mint,
      vaultTokenAccount: ata(vault, mint),
      ownerTokenAccount: to,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
}

/** update_config arguments that change nothing. */
const NO_UPDATE = {
  allowedMints: null,
  maxSlippageBps: null,
  maxOracleStalenessSecs: null,
  strategyHash: null,
  maxDailyLossUsd: null,
};

function updateConfig(signer: Keypair, args: { maxSlippageBps: number }) {
  return program.methods
    .updateConfig({ ...NO_UPDATE, ...args })
    .accountsStrict({ owner: signer.publicKey, vault })
    .signers([signer])
    .rpc();
}

function setPaused(paused: boolean) {
  return program.methods
    .setPaused(paused)
    .accountsStrict({ owner: owner.publicKey, vault })
    .signers([owner])
    .rpc();
}

beforeAll(async () => {
  await Promise.all([owner, keeper, stranger].map((k) => airdrop(k.publicKey)));
  usdc = await createMint(connection, payer, payer.publicKey, null, 6);
  sol = await createMint(connection, payer, payer.publicKey, null, 9);
  junk = await createMint(connection, payer, payer.publicKey, null, 6);

  await fund(owner.publicKey, usdc, 1_000_000_000n); // 1,000 USDC
  await fund(owner.publicKey, sol, 5_000_000_000n); // 5 SOL
  await fund(owner.publicKey, junk, 1_000_000n);
  await fund(keeper.publicKey, usdc, 0n);
  await fund(stranger.publicKey, usdc, 0n);
});

describe("happy path", () => {
  it("initializes a vault allowing USDC and SOL", async () => {
    const signature = await program.methods
      .initializeVault({
        vaultId: VAULT_ID,
        keeper: keeper.publicKey,
        allowedMints: [
          { mint: usdc, pythFeedId: feed(1) },
          { mint: sol, pythFeedId: feed(2) },
        ],
        maxSlippageBps: 50,
        maxOracleStalenessSecs: 60,
        strategyHash: feed(42),
        maxDailyLossUsd: new BN(25_000_000), // $25
      })
      .accountsStrict({ owner: owner.publicKey, vault, systemProgram: SYSTEM_PROGRAM_ID })
      .remainingAccounts(mintMetas(usdc, sol))
      .signers([owner])
      .rpc();

    const v = await program.account.vault.fetch(vault);
    expect(v.owner.equals(owner.publicKey)).toBe(true);
    expect(v.keeper.equals(keeper.publicKey)).toBe(true);
    expect(v.allowedMints.map((m) => m.mint.toBase58())).toEqual([usdc.toBase58(), sol.toBase58()]);
    expect(v.maxSlippageBps).toBe(50);
    expect(v.paused).toBe(false);
    expect((await events(signature)).map((e) => e.name)).toEqual(["vaultInitialized"]);
  });

  it("deposits USDC and SOL, creating the vault's token accounts", async () => {
    const ownerUsdc = ata(owner.publicKey, usdc);
    const ownerSol = ata(owner.publicKey, sol);

    const signature = await deposit(owner, usdc, ownerUsdc, 400_000_000);
    await deposit(owner, sol, ownerSol, 2_000_000_000);

    expect(await balance(ata(vault, usdc))).toBe(400_000_000n);
    expect(await balance(ownerUsdc)).toBe(600_000_000n);
    expect(await balance(ata(vault, sol))).toBe(2_000_000_000n);
    expect(await balance(ownerSol)).toBe(3_000_000_000n);

    const [event] = await events(signature);
    expect(event?.name).toBe("deposited");
    expect(event?.data.amount.toString()).toBe("400000000");
    expect(event?.data.vaultBalance.toString()).toBe("400000000");
  });

  it("lets the owner update the config", async () => {
    await updateConfig(owner, { maxSlippageBps: 500 });
    expect((await program.account.vault.fetch(vault)).maxSlippageBps).toBe(500);
  });

  it("withdraws to the owner's token account", async () => {
    const ownerUsdc = ata(owner.publicKey, usdc);
    const signature = await withdraw(owner, usdc, ownerUsdc, 150_000_000);

    expect(await balance(ata(vault, usdc))).toBe(250_000_000n);
    expect(await balance(ownerUsdc)).toBe(750_000_000n);
    const [event] = await events(signature);
    expect(event?.name).toBe("withdrawn");
    expect(event?.data.vaultBalance.toString()).toBe("250000000");
  });

  it("withdraws while paused", async () => {
    await setPaused(true);
    await withdraw(owner, sol, ata(owner.publicKey, sol), 500_000_000);
    expect(await balance(ata(vault, sol))).toBe(1_500_000_000n);
    await setPaused(false);
  });
});

describe("attacks (must all fail)", () => {
  it("a non-owner cannot withdraw", async () => {
    const before = await balance(ata(vault, usdc));
    await expectVaultError(
      withdraw(stranger, usdc, ata(stranger.publicKey, usdc), 1),
      "Unauthorized",
    );
    expect(await balance(ata(vault, usdc))).toBe(before);
    expect(await balance(ata(stranger.publicKey, usdc))).toBe(0n);
  });

  it("the keeper cannot withdraw", async () => {
    const before = await balance(ata(vault, usdc));
    await expectVaultError(
      withdraw(keeper, usdc, ata(keeper.publicKey, usdc), before),
      "Unauthorized",
    );
    expect(await balance(ata(vault, usdc))).toBe(before);
    expect(await balance(ata(keeper.publicKey, usdc))).toBe(0n);
  });

  it("cannot deposit a mint that is not allowed", async () => {
    await expectVaultError(
      deposit(owner, junk, ata(owner.publicKey, junk), 1_000),
      "MintNotAllowed",
    );
    expect(await connection.getAccountInfo(ata(vault, junk))).toBeNull();
    expect(await balance(ata(owner.publicKey, junk))).toBe(1_000_000n);
  });

  it("a non-owner cannot update the config", async () => {
    for (const signer of [stranger, keeper]) {
      await expectVaultError(updateConfig(signer, { maxSlippageBps: 1 }), "Unauthorized");
    }
    expect((await program.account.vault.fetch(vault)).maxSlippageBps).toBe(500);
  });

  it("cannot set slippage to 1000 bps", async () => {
    await expectVaultError(updateConfig(owner, { maxSlippageBps: 1000 }), "SlippageAboveCap");
    expect((await program.account.vault.fetch(vault)).maxSlippageBps).toBe(500);
  });
});
