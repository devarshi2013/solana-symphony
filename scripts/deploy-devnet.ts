/**
 * Deploys the vault (TEST-ONLY devnet-mock build) and mock-swap to DEVNET, creates test mints
 * and seeds mock-swap, then writes every address to deployments/devnet.json.
 *
 * Run: `pnpm deploy:devnet` (builds first). Safe to re-run: each step checks what is already
 * on chain and only does what is missing or out of date.
 *
 * - Refuses to run against anything but devnet (checks the genesis hash), except a local
 *   test validator (DEVNET_RPC_URL=http://127.0.0.1:<port>) for rehearsals, which writes
 *   deployments/localnet.json instead.
 * - Deployer: DEPLOYER_KEYPAIR, default keypairs/devnet-deployer.json (gitignored), created
 *   on first run. It pays for everything and is the programs' upgrade authority, the mints'
 *   authority and mock-swap's admin.
 * - Programs: deployed with the program keypairs in target/deploy/ (gitignored; keep them, or
 *   you cannot upgrade). Skipped when the on-chain bytes already match the local build.
 * - Mock prices come from Pyth's devnet price accounts (falling back to fixed prices), so the
 *   vault's oracle check agrees with the mock. Re-run to refresh them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// @anchor-lang/core is CommonJS under Node: take values from the default export.
import anchor, { type Idl, type Program as AnchorProgram } from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import type { MockSwap } from "../target/types/mock_swap.ts";

const { AnchorProvider, BN, Program } = anchor;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEPLOYER_PATH = process.env.DEPLOYER_KEYPAIR ?? join(ROOT, "keypairs/devnet-deployer.json");
/** A local test validator is also allowed, for rehearsing the deploy; nothing else is. */
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
const CLUSTER = LOCAL ? "localnet" : "devnet";
const OUT = join(ROOT, `deployments/${CLUSTER}.json`);
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/** Leave this much SOL after deploying, for transaction fees and test accounts. */
const SOL_RESERVE = 0.5;

const PROGRAMS = {
  vault: {
    so: "target/deploy-devnet-mock/vault.so",
    keypair: "target/deploy/vault-keypair.json",
    build: "devnet-mock (TEST-ONLY: swaps go to mock-swap)",
  },
  mockSwap: {
    so: "target/deploy/mock_swap.so",
    keypair: "target/deploy/mock_swap-keypair.json",
    build: "TEST-ONLY",
  },
} as const;
type ProgramName = keyof typeof PROGRAMS;

/**
 * Test mints. Prices: Pyth devnet sponsored accounts (push oracle, shard 0) for the real
 * asset, so a vault can point its allowed_mints at the same feeds. `fallbackPrice` (exponent
 * -8) is used if the account is missing.
 */
const MINTS = {
  tUSDC: {
    decimals: 6,
    liquidity: 1_000_000, // whole tokens the market should hold
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", // USDC/USD
    pythPriceAccount: "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
    fallbackPrice: 100_000_000,
  },
  tSOL: {
    decimals: 9,
    liquidity: 10_000,
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", // SOL/USD
    pythPriceAccount: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
    fallbackPrice: 15_000_000_000,
  },
  tJUP: {
    decimals: 6,
    liquidity: 1_000_000,
    pythFeedId: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996", // JUP/USD
    pythPriceAccount: "7dbob1psH1iZBS7qPsm3Kwbf5DzSXK8Jyg31CTgTnxH5",
    fallbackPrice: 50_000_000,
  },
} as const;
type MintName = keyof typeof MINTS;

type Deployment = {
  cluster: "devnet" | "localnet";
  rpc: string;
  genesisHash: string;
  updatedAt: string;
  deployer: string;
  programs: Partial<Record<ProgramName, { programId: string; build: string; sha256: string }>>;
  mints: Partial<
    Record<
      MintName,
      { address: string; decimals: number; pythFeedId: string; pythPriceAccount: string }
    >
  >;
  mockSwap?: {
    market: string;
    admin: string;
    prices: Partial<Record<MintName, { price: string; exponent: number; source: string }>>;
    liquidityAccounts: Partial<Record<MintName, string>>;
  };
};

const log = (msg: string) => console.log(`[deploy-devnet] ${msg}`);

function fail(msg: string): never {
  console.error(`[deploy-devnet] ERROR: ${msg}`);
  process.exit(1);
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

function loadDeployment(): Deployment | undefined {
  if (!existsSync(OUT)) return undefined;
  return JSON.parse(readFileSync(OUT, "utf8")) as Deployment;
}

function saveDeployment(d: Deployment) {
  mkdirSync(dirname(OUT), { recursive: true });
  d.updatedAt = new Date().toISOString();
  writeFileSync(OUT, `${JSON.stringify(d, null, 2)}\n`);
}

// ---------------------------------------------------------------- deployer and SOL

function loadOrCreateDeployer(): Keypair {
  if (existsSync(DEPLOYER_PATH)) return loadKeypair(DEPLOYER_PATH);
  const keypair = Keypair.generate();
  mkdirSync(dirname(DEPLOYER_PATH), { recursive: true });
  writeFileSync(DEPLOYER_PATH, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  log(`created devnet deployer keypair ${DEPLOYER_PATH} (gitignored; devnet only)`);
  return keypair;
}

/** Retries transient RPC failures (network errors, 429s) a few times. */
async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 5) fail(`${what}: ${(e as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

async function ensureBalance(connection: Connection, deployer: PublicKey, neededSol: number) {
  const getSol = async () =>
    (await retry("getBalance", () => connection.getBalance(deployer))) / LAMPORTS_PER_SOL;
  let balance = await getSol();
  log(
    `deployer ${deployer.toBase58()}: ${balance.toFixed(3)} SOL (need about ${neededSol.toFixed(2)})`,
  );
  for (let attempt = 1; balance < neededSol && attempt <= 4; attempt++) {
    const request = Math.min(LOCAL ? 100 : 2, Math.ceil(neededSol - balance));
    log(`balance low: requesting a ${request} SOL airdrop (attempt ${attempt})`);
    try {
      const sig = await connection.requestAirdrop(deployer, request * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({
        signature: sig,
        ...(await connection.getLatestBlockhash()),
      });
    } catch (e) {
      const message = (e as Error).message;
      log(`airdrop failed: ${(message.split("\n")[0] ?? "").slice(0, 160)}`);
      if (/airdrop limit|run dry/i.test(message)) break; // retrying will not help today
      await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
    balance = await getSol();
  }
  if (balance < neededSol) {
    fail(
      `deployer has ${balance.toFixed(3)} SOL but needs about ${neededSol.toFixed(2)}. ` +
        `The devnet airdrop is rate-limited: get devnet SOL at https://faucet.solana.com ` +
        `for ${deployer.toBase58()} (or transfer it from another devnet wallet), then re-run.`,
    );
  }
}

// ---------------------------------------------------------------- programs

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** What deploying `name` needs: nothing, a first deploy, or an upgrade (and its cost). */
async function planProgram(connection: Connection, deployer: PublicKey, name: ProgramName) {
  const spec = PROGRAMS[name];
  const soPath = join(ROOT, spec.so);
  if (!existsSync(soPath)) fail(`${spec.so} is missing: run pnpm build:program:devnet-mock`);
  const so = readFileSync(soPath);
  const programId = loadKeypair(join(ROOT, spec.keypair)).publicKey;
  // ProgramData: 4 (enum) + 8 (slot) + 1 + 32 (Option<authority>) header, then the ELF.
  // A deploy or upgrade first writes the ELF to a buffer (37-byte header), refunded after.
  const programDataSol =
    (await connection.getMinimumBalanceForRentExemption(45 + so.length)) / LAMPORTS_PER_SOL;
  const bufferSol =
    (await connection.getMinimumBalanceForRentExemption(37 + so.length)) / LAMPORTS_PER_SOL;

  const program = await connection.getAccountInfo(programId);
  if (!program) {
    return {
      name,
      so,
      programId,
      action: "deploy" as const,
      keptSol: programDataSol,
      bufferSol,
    };
  }
  if (!program.owner.equals(UPGRADEABLE_LOADER) || !program.executable) {
    fail(`${programId.toBase58()} exists on devnet but is not an upgradeable program`);
  }
  const programData = new PublicKey(program.data.subarray(4, 36));
  const info = await connection.getAccountInfo(programData);
  if (!info) fail(`program data account for ${name} not found`);
  const data = info.data;
  const authority = data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
  if (!authority?.equals(deployer)) {
    fail(
      `${name} (${programId.toBase58()}) upgrade authority is ${authority?.toBase58() ?? "none"}, not the deployer`,
    );
  }
  const onChain = data.subarray(45);
  const same =
    onChain.length >= so.length &&
    onChain.subarray(0, so.length).equals(so) &&
    onChain.subarray(so.length).every((b) => b === 0);
  if (same) return { name, so, programId, action: "none" as const, keptSol: 0, bufferSol: 0 };
  // An upgrade needs the buffer, plus extending the program data if the ELF grew.
  return {
    name,
    so,
    programId,
    action: "upgrade" as const,
    keptSol: Math.max(0, programDataSol - info.lamports / LAMPORTS_PER_SOL),
    bufferSol,
  };
}

function runSolanaDeploy(name: ProgramName) {
  const spec = PROGRAMS[name];
  const args = [
    "program",
    "deploy",
    join(ROOT, spec.so),
    "--program-id",
    join(ROOT, spec.keypair),
    "--keypair",
    DEPLOYER_PATH,
    "--upgrade-authority",
    DEPLOYER_PATH,
    "--url",
    RPC,
    "--max-sign-attempts",
    "50",
    "--commitment",
    "confirmed",
  ];
  log(`solana ${args.join(" ")}`);
  const result = spawnSync("solana", args, { stdio: "inherit" });
  if (result.status !== 0)
    fail(
      `deploying ${name} failed (re-run to resume; leftover buffers: solana program show --buffers)`,
    );
}

// ---------------------------------------------------------------- mock prices

/** Pyth devnet price for `mint`, or its fallback. Layout as in programs/vault/src/price.rs tests. */
async function priceFor(connection: Connection, mint: MintName) {
  const spec = MINTS[mint];
  const info = await connection.getAccountInfo(new PublicKey(spec.pythPriceAccount));
  if (info?.owner.equals(PYTH_RECEIVER) && info.data[40] === 1) {
    const data = Buffer.from(info.data);
    if (data.subarray(41, 73).toString("hex") === spec.pythFeedId) {
      const price = data.readBigInt64LE(73);
      const exponent = data.readInt32LE(89);
      const age = Math.floor(Date.now() / 1000) - Number(data.readBigInt64LE(93));
      if (price > 0n) return { price, exponent, source: `pyth devnet (${age}s old at deploy)` };
    }
  }
  log(`WARNING: no usable Pyth devnet price for ${mint}; using the fallback`);
  return { price: BigInt(spec.fallbackPrice), exponent: -8, source: "fallback" };
}

// ---------------------------------------------------------------- main

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const genesis = await retry("getGenesisHash", () => connection.getGenesisHash());
  if (!LOCAL && genesis !== DEVNET_GENESIS_HASH) {
    fail(`${RPC} is not devnet (genesis ${genesis}); refusing to deploy`);
  }
  log(`cluster: ${CLUSTER} (${RPC})`);

  const deployer = loadOrCreateDeployer();
  const previous = loadDeployment();
  if (previous && previous.deployer !== deployer.publicKey.toBase58()) {
    fail(`${OUT} was made by ${previous.deployer}, not this deployer`);
  }
  if (previous && previous.genesisHash !== genesis) {
    fail(
      `${OUT} is for another ledger (genesis ${previous.genesisHash}); move it aside to start over`,
    );
  }
  const d: Deployment = previous ?? {
    cluster: CLUSTER,
    rpc: RPC,
    genesisHash: genesis,
    updatedAt: "",
    deployer: deployer.publicKey.toBase58(),
    programs: {},
    mints: {},
  };

  // 1. SOL: enough for whatever programs need deploying, plus a reserve.
  const plans = [
    await planProgram(connection, deployer.publicKey, "vault"),
    await planProgram(connection, deployer.publicKey, "mockSwap"),
  ];
  // Programs deploy one at a time: all program data stays, one buffer exists at a time.
  const needed =
    plans.reduce((sum, p) => sum + p.keptSol, 0) +
    Math.max(0, ...plans.map((p) => p.bufferSol)) +
    SOL_RESERVE;
  await ensureBalance(connection, deployer.publicKey, needed);

  // 2. Programs.
  for (const plan of plans) {
    if (plan.action === "none")
      log(`${plan.name}: on-chain program matches the local build, skipping`);
    else runSolanaDeploy(plan.name);
    d.programs[plan.name] = {
      programId: plan.programId.toBase58(),
      build: PROGRAMS[plan.name].build,
      sha256: sha256(plan.so),
    };
    saveDeployment(d);
  }

  // 3. Test mints (the deployer is the mint authority).
  for (const name of Object.keys(MINTS) as MintName[]) {
    const spec = MINTS[name];
    const existing = d.mints[name];
    if (existing) {
      const mint = await getMint(connection, new PublicKey(existing.address)).catch(() => null);
      if (mint?.mintAuthority?.equals(deployer.publicKey) && mint.decimals === spec.decimals) {
        log(`${name}: mint ${existing.address} exists, reusing`);
        continue;
      }
      log(`${name}: recorded mint ${existing.address} is missing or not ours, creating a new one`);
    }
    const mint = await createMint(connection, deployer, deployer.publicKey, null, spec.decimals);
    log(`${name}: created mint ${mint.toBase58()}`);
    d.mints[name] = {
      address: mint.toBase58(),
      decimals: spec.decimals,
      pythFeedId: spec.pythFeedId,
      pythPriceAccount: spec.pythPriceAccount,
    };
    saveDeployment(d);
  }

  // 4. mock-swap market, prices and liquidity.
  const wallet = {
    publicKey: deployer.publicKey,
    payer: deployer,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => {
      if (tx instanceof VersionedTransaction) tx.sign([deployer]);
      else tx.partialSign(deployer);
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) =>
      Promise.all(txs.map((tx) => wallet.signTransaction(tx))),
  };
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(readFileSync(join(ROOT, "target/idl/mock_swap.json"), "utf8")) as Idl;
  const mockSwap = new Program(idl, provider) as unknown as AnchorProgram<MockSwap>;
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market")], mockSwap.programId);

  const fetchMarket = () => mockSwap.account.market.fetchNullable(market);
  let state = await fetchMarket();
  if (!state) {
    await mockSwap.methods
      .initMarket()
      .accountsStrict({ admin: deployer.publicKey, market, systemProgram: SystemProgram.programId })
      .rpc();
    log(`mock-swap: created market ${market.toBase58()}`);
    state = await fetchMarket();
  } else {
    log(`mock-swap: market ${market.toBase58()} exists`);
  }
  if (!state?.admin.equals(deployer.publicKey)) {
    fail(`mock-swap market admin is ${state?.admin.toBase58()}, not the deployer`);
  }

  d.mockSwap = {
    market: market.toBase58(),
    admin: deployer.publicKey.toBase58(),
    prices: {},
    liquidityAccounts: {},
  };
  for (const name of Object.keys(MINTS) as MintName[]) {
    const spec = MINTS[name];
    const mint = new PublicKey(d.mints[name]!.address);

    const p = await priceFor(connection, name);
    const current = state.prices.find((x) => x.mint.equals(mint));
    if (
      current &&
      current.price.toString() === p.price.toString() &&
      current.exponent === p.exponent
    ) {
      log(`${name}: mock price already ${p.price} e${p.exponent}`);
    } else {
      await mockSwap.methods
        .setPrice(mint, new BN(p.price.toString()), p.exponent)
        .accountsStrict({ admin: deployer.publicKey, market })
        .rpc();
      log(`${name}: mock price set to ${p.price} e${p.exponent} (${p.source})`);
    }
    d.mockSwap.prices[name] = { price: p.price.toString(), exponent: p.exponent, source: p.source };

    // Top the market's token account up to the target (never mints more than the gap).
    const ata = await getOrCreateAssociatedTokenAccount(connection, deployer, mint, market, true);
    const target = BigInt(spec.liquidity) * 10n ** BigInt(spec.decimals);
    const balance = (await getAccount(connection, ata.address)).amount;
    if (balance < target) {
      await mintTo(connection, deployer, mint, ata.address, deployer, target - balance);
      log(`${name}: market liquidity topped up to ${spec.liquidity}`);
    } else {
      log(`${name}: market liquidity already ${balance / 10n ** BigInt(spec.decimals)}`);
    }
    d.mockSwap.liquidityAccounts[name] = ata.address.toBase58();
    saveDeployment(d);
  }

  const left = (await connection.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL;
  log(`done: ${OUT} (deployer has ${left.toFixed(3)} SOL left)`);
}

main().catch((e: unknown) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
