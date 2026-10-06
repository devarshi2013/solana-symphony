/**
 * OPTIONAL: one real Jupiter v6 swap through the vault, on a local solana-test-validator
 * that clones the mainnet accounts the route needs. Skipped unless JUPITER_FORK=1.
 *
 * Run: `pnpm test:jupiter-fork` (see programs/vault/README.md). Needs network access to
 * api.jup.ag (keyless) and a mainnet RPC (MAINNET_RPC_URL, default the public endpoint).
 * Nothing is sent to mainnet; the only addresses sent anywhere are throwaway keys generated
 * for this run.
 *
 * Real, from mainnet: the Jupiter program, the AMM program and pool state, the USDC and wSOL
 * mints, the feature set, and the Pyth price accounts (copied unmodified once fresh). Not
 * real: the vault's token balances, written into genesis (10 USDC can't be minted locally).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnchorProvider, BN, EventParser, Program, type Idl } from "@anchor-lang/core";
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Vault } from "../../../target/types/vault.js";

const ENABLED = process.env.JUPITER_FORK === "1";
const ROOT = new URL("../../../", import.meta.url).pathname;
const WORK = join(ROOT, "target/jupiter-fork");
const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const RPC_PORT = 18899;
const LOCAL_RPC = `http://127.0.0.1:${RPC_PORT}`;

const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
// Pyth feed IDs (hermes.pyth.network) and their sponsored PriceUpdateV2 accounts (push
// oracle pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT, shard 0), checked 2026-10-05.
const FEEDS = {
  usdc: {
    id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    account: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
  },
  sol: {
    id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    account: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  },
};
/** Programs the test validator already has; never cloned. */
const BUILTINS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  SystemProgram.programId.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
]);

const AMOUNT_IN = 10_000_000; // 10 USDC
const VAULT_USDC = 20_000_000n;
const VAULT_ID = new BN(1);
const SLIPPAGE_BPS = 100;
const DEXES = process.env.JUPITER_FORK_DEXES ?? "Whirlpool";

type JupAccount = { pubkey: string; isWritable: boolean; isSigner: boolean };
type JupBuild = {
  inAmount: string;
  outAmount: string;
  routePlan: { swapInfo: { label: string; ammKey: string } }[];
  swapInstruction: { programId: string; accounts: JupAccount[]; data: string };
};

const log = (...args: unknown[]) => console.log("[jupiter-fork]", ...args);

async function jupiterBuild(taker: PublicKey, payer: PublicKey): Promise<JupBuild> {
  const params = new URLSearchParams({
    inputMint: USDC.toBase58(),
    outputMint: WSOL.toBase58(),
    amount: String(AMOUNT_IN),
    taker: taker.toBase58(),
    payer: payer.toBase58(),
    wrapAndUnwrapSol: "false",
    slippageBps: String(SLIPPAGE_BPS),
    maxAccounts: "30",
    dexes: DEXES,
  });
  const headers: Record<string, string> = {};
  if (process.env.JUP_API_KEY) headers["x-api-key"] = process.env.JUP_API_KEY;
  const res = await fetch(`https://api.jup.ag/swap/v2/build?${params}`, { headers });
  const body = (await res.json()) as JupBuild & { error?: string };
  if (!res.ok || body.error)
    throw new Error(`Jupiter /build: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** An account file for `solana-test-validator --account`. */
function writeAccount(
  name: string,
  pubkey: PublicKey,
  owner: PublicKey,
  data: Buffer,
  lamports: number,
) {
  const file = join(WORK, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      pubkey: pubkey.toBase58(),
      account: {
        lamports,
        data: [data.toString("base64"), "base64"],
        owner: owner.toBase58(),
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    }),
  );
  return file;
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, native: bigint | null) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: native === null ? 0 : 1,
      isNative: native ?? 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/** Accept Pyth updates at most this old when copying them; they age further during start-up. */
const MAX_PRICE_AGE_AT_COPY_SECS = 30;
/** The vault requires a swap's two prices within 30 s of each other (MAX_PRICE_SKEW_SECS). */
const MAX_PRICE_SKEW_AT_COPY_SECS = 25;

/**
 * Mainnet's sponsored PriceUpdateV2 accounts for `feeds`, copied unmodified once both hold an
 * update no older than MAX_PRICE_AGE_AT_COPY_SECS and published close together (sponsored feeds
 * update on independent schedules, so this can take a few polls). Read in one RPC call so they
 * are a consistent snapshot. Layout: 8 discriminator, 32 write authority, 1 verification level
 * (Full), 32 feed id, price i64, conf u64, exponent i32, publish_time i64, ...
 */
async function freshPriceAccounts(
  mainnet: Connection,
  feeds: { id: string; account: PublicKey }[],
) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const infos = await mainnet.getMultipleAccountsInfo(feeds.map((f) => f.account));
    const now = Math.floor(Date.now() / 1000);
    const read = feeds.map((feed, i) => {
      const info = infos[i];
      if (!info) throw new Error(`Pyth account ${feed.account.toBase58()} not found on mainnet`);
      const data = Buffer.from(info.data);
      if (data[40] !== 1) throw new Error("expected a fully verified price update");
      if (data.subarray(41, 73).toString("hex") !== feed.id) throw new Error("feed id mismatch");
      const publishTime = Number(data.readBigInt64LE(93));
      return {
        data,
        owner: info.owner,
        lamports: info.lamports,
        price: data.readBigInt64LE(73),
        expo: data.readInt32LE(89),
        age: now - publishTime,
        publishTime,
      };
    });
    const times = read.map((r) => r.publishTime);
    const fresh = read.every((r) => r.age <= MAX_PRICE_AGE_AT_COPY_SECS);
    if (fresh && Math.max(...times) - Math.min(...times) <= MAX_PRICE_SKEW_AT_COPY_SECS)
      return read;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("Pyth sponsored feeds were never fresh and close together; try again");
}

async function waitForValidator(connection: Connection, validator: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (validator.exitCode !== null) throw new Error(`validator exited; see ${WORK}/validator.log`);
    try {
      if ((await connection.getSlot()) > 1) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`validator did not start; see ${WORK}/validator.log`);
}

describe.runIf(ENABLED)("real Jupiter swap on a mainnet fork (optional)", () => {
  const owner = Keypair.generate();
  const keeper = Keypair.generate();
  let validator: ChildProcess | undefined;
  let connection: Connection;
  let program: Program<Vault>;
  let build: JupBuild;
  let vault: PublicKey;
  let vaultUsdc: PublicKey;
  let vaultWsol: PublicKey;

  beforeAll(async () => {
    mkdirSync(WORK, { recursive: true });
    const mainnet = new Connection(MAINNET_RPC, "confirmed");
    const idl = JSON.parse(readFileSync(join(ROOT, "target/idl/vault.json"), "utf8")) as Idl;
    const programId = new PublicKey((idl as { address: string }).address);

    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.publicKey.toBuffer(), VAULT_ID.toArrayLike(Buffer, "le", 8)],
      programId,
    );
    vaultUsdc = getAssociatedTokenAddressSync(USDC, vault, true);
    vaultWsol = getAssociatedTokenAddressSync(WSOL, vault, true);

    // 1. Route from Jupiter, for the vault as taker.
    build = await jupiterBuild(vault, keeper.publicKey);
    log(
      "route:",
      build.routePlan.map((r) => r.swapInfo.label).join(" -> "),
      `quote ${build.inAmount} USDC base units -> ${build.outAmount} lamports`,
    );
    expect(build.swapInstruction.programId).toBe(JUPITER.toBase58());

    // 2. What to clone: every route account except the vault's own, built-ins and Jupiter.
    const local = new Set([vault, vaultUsdc, vaultWsol].map((k) => k.toBase58()));
    const keys = [
      ...new Set(
        build.swapInstruction.accounts
          .map((a) => a.pubkey)
          .concat(USDC.toBase58(), WSOL.toBase58()),
      ),
    ].filter((k) => !local.has(k) && !BUILTINS.has(k) && k !== JUPITER.toBase58());
    const infos = await mainnet.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
    const clone: string[] = [];
    const cloneProgram: string[] = [JUPITER.toBase58()];
    keys.forEach((k, i) => {
      const info = infos[i];
      if (!info) return; // e.g. an optional PDA that does not exist; Jupiter passes it anyway
      if (info.executable && info.owner.equals(UPGRADEABLE_LOADER)) cloneProgram.push(k);
      else clone.push(k);
    });
    log(`cloning ${clone.length} accounts and ${cloneProgram.length} programs from mainnet`);

    // 3. Genesis accounts: vault token balances and fresh Pyth prices.
    const rent = await mainnet.getMinimumBalanceForRentExemption(AccountLayout.span);
    const files = [
      writeAccount(
        "vault-usdc",
        vaultUsdc,
        TOKEN_PROGRAM_ID,
        tokenAccount(USDC, vault, VAULT_USDC, null),
        rent,
      ),
      writeAccount(
        "vault-wsol",
        vaultWsol,
        TOKEN_PROGRAM_ID,
        tokenAccount(WSOL, vault, 0n, BigInt(rent)),
        rent,
      ),
    ];
    const names = Object.keys(FEEDS) as (keyof typeof FEEDS)[];
    const prices = await freshPriceAccounts(
      mainnet,
      names.map((n) => FEEDS[n]),
    );
    names.forEach((name, i) => {
      const p = prices[i]!;
      log(`pyth ${name}: ${p.price} e${p.expo}, ${p.age}s old`);
      files.push(writeAccount(`pyth-${name}`, FEEDS[name].account, p.owner, p.data, p.lamports));
    });

    // 4. Start the validator.
    const args = [
      "--reset",
      "--quiet",
      "--ledger",
      join(WORK, "ledger"),
      "--rpc-port",
      String(RPC_PORT),
      "--faucet-port",
      String(RPC_PORT + 1001),
      "--bind-address",
      "127.0.0.1",
      "--url",
      MAINNET_RPC,
      "--clone-feature-set",
      ...clone.flatMap((k) => ["--clone", k]),
      ...cloneProgram.flatMap((k) => ["--clone-upgradeable-program", k]),
      ...files.flatMap((f) => ["--account", "-", f]),
      "--upgradeable-program",
      programId.toBase58(),
      join(ROOT, "target/deploy/vault.so"),
      keeper.publicKey.toBase58(),
    ];
    const logFile = join(WORK, "validator.log");
    writeFileSync(logFile, `solana-test-validator ${args.join(" ")}\n`);
    validator = spawn("solana-test-validator", args, { stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer) => writeFileSync(logFile, chunk, { flag: "a" });
    validator.stdout?.on("data", append);
    validator.stderr?.on("data", append);

    connection = new Connection(LOCAL_RPC, "confirmed");
    await waitForValidator(connection, validator);
    for (const k of [owner, keeper]) {
      const sig = await connection.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({
        signature: sig,
        ...(await connection.getLatestBlockhash()),
      });
    }
    const provider = new AnchorProvider(connection, keypairWallet(keeper), {
      commitment: "confirmed",
    });
    program = new Program(idl, provider) as unknown as Program<Vault>;

    // 5. The vault: USDC and SOL allowed, 1% slippage, prices up to 120 s old.
    await program.methods
      .initializeVault({
        vaultId: VAULT_ID,
        keeper: keeper.publicKey,
        allowedMints: [
          { mint: USDC, pythFeedId: [...Buffer.from(FEEDS.usdc.id, "hex")] },
          { mint: WSOL, pythFeedId: [...Buffer.from(FEEDS.sol.id, "hex")] },
        ],
        maxSlippageBps: SLIPPAGE_BPS,
        maxOracleStalenessSecs: 120,
        strategyHash: Array<number>(32).fill(0),
        maxDailyLossUsd: new BN(5_000_000), // $5
      })
      .accountsStrict({ owner: owner.publicKey, vault, systemProgram: SystemProgram.programId })
      .remainingAccounts(
        [USDC, WSOL].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      )
      .signers([owner])
      .rpc();
  }, 300_000);

  afterAll(() => {
    validator?.kill("SIGINT");
  });

  it("swaps 10 USDC for SOL through Jupiter and passes every vault check", async () => {
    // The keeper's job: Jupiter's swap instruction as route data + remaining accounts, with the
    // vault PDA's signer flag cleared (the vault signs it in the CPI).
    const route: AccountMeta[] = build.swapInstruction.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isWritable: a.isWritable,
      isSigner: a.isSigner && a.pubkey !== vault.toBase58(),
    }));
    const swapIx: TransactionInstruction = await program.methods
      .swap(new BN(AMOUNT_IN), new BN(0), Buffer.from(build.swapInstruction.data, "base64"))
      .accountsStrict({
        keeper: keeper.publicKey,
        vault,
        inputMint: USDC,
        outputMint: WSOL,
        vaultInputAccount: vaultUsdc,
        vaultOutputAccount: vaultWsol,
        inputPriceUpdate: FEEDS.usdc.account,
        outputPriceUpdate: FEEDS.sol.account,
        swapProgram: JUPITER,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(route)
      .instruction();

    // A lookup table so the transaction fits in 1,232 bytes, as a real keeper would use.
    const slot = await connection.getSlot("finalized");
    const [createLut, lut] = AddressLookupTableProgram.createLookupTable({
      authority: keeper.publicKey,
      payer: keeper.publicKey,
      recentSlot: slot,
    });
    const addresses = [...new Set(swapIx.keys.map((k) => k.pubkey.toBase58()))]
      .filter((k) => k !== keeper.publicKey.toBase58())
      .map((k) => new PublicKey(k));
    const lutIxs: TransactionInstruction[] = [createLut];
    for (let i = 0; i < addresses.length; i += 20) {
      lutIxs.push(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: lut,
          authority: keeper.publicKey,
          payer: keeper.publicKey,
          addresses: addresses.slice(i, i + 20),
        }),
      );
    }
    for (const ix of lutIxs) await sendV0(connection, keeper, [ix]);
    const start = await connection.getSlot();
    while ((await connection.getSlot()) <= start) await new Promise((r) => setTimeout(r, 200));
    const table = (await connection.getAddressLookupTable(lut)).value;
    if (!table) throw new Error("lookup table not found");

    const before = (await getAccount(connection, vaultUsdc)).amount;
    const signature = await sendV0(
      connection,
      keeper,
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), swapIx],
      [table],
    );

    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    log(`swap ${signature}: ${tx?.meta?.computeUnitsConsumed} CU`);
    const swapped = [
      ...new EventParser(program.programId, program.coder).parseLogs(tx?.meta?.logMessages ?? []),
    ].find((e) => e.name === "swapped");
    expect(swapped).toBeDefined();
    const e = swapped!.data as Record<string, BN>;
    log(
      `spent ${e.spent} received ${e.received} lamports; oracle ${e.oracleOut}, vault minimum ${e.minOut}`,
    );
    expect(e.spent!.toNumber()).toBe(AMOUNT_IN);
    expect(e.received!.gte(e.minOut!)).toBe(true);
    expect((await getAccount(connection, vaultUsdc)).amount).toBe(before - BigInt(AMOUNT_IN));
    expect((await getAccount(connection, vaultWsol)).amount).toBe(BigInt(e.received!.toString()));
  }, 120_000);
});

async function sendV0(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[] = [],
) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  log(`tx size ${tx.serialize().length} bytes`);
  const signature = await connection.sendTransaction(tx);
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err) {
    const failed = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    throw new Error(
      `${JSON.stringify(result.value.err)}\n${failed?.meta?.logMessages?.join("\n")}`,
    );
  }
  return signature;
}

/** Minimal Anchor wallet for a keypair (the package's `Wallet` is CommonJS-only). */
function keypairWallet(keypair: Keypair) {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  };
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => sign(tx),
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) =>
      txs.map(sign),
  };
}
