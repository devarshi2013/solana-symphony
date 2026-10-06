// Typed client for the vault program (programs/vault), wrapping its Anchor IDL.
//
// Every action has an instruction builder (`depositIx`, ...) that only builds, and a method
// (`deposit`, ...) that builds, signs with the client's wallet and sends.
// @anchor-lang/core is CommonJS under Node: take values from the default export.
import anchor, { type IdlAccounts, type Program as AnchorProgram } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountMeta,
  type Commitment,
  type Keypair,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";

import { loadDeployment, type DeployedMint, type Deployment } from "./deployments.js";
import { VAULT_IDL, type Vault } from "./idl/vault.js";
import { formatUnits, parseUnits } from "./units.js";

const { AnchorProvider, BN, Program } = anchor;

export const VAULT_SEED = "vault";
/** Jupiter v6, the swap program a normal (mainnet) vault build accepts. */
export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/** Anything that can sign transactions: a browser wallet adapter, or `keypairWallet(kp)`. */
export interface VaultWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/** A mint by its name in the deployment file (e.g. "tUSDC") or by address. */
export type MintRef = string | PublicKey;
/** Token amount in base units. */
export type Amount = bigint | number;

export interface AllowedMintInput {
  mint: MintRef;
  /** Pyth feed ID (64 hex characters); taken from the deployment for named mints. */
  pythFeedId?: string;
}

export interface CreateVaultArgs {
  /** Lets one owner have several vaults. Default 0. */
  vaultId?: bigint;
  /** Who may swap. Default: none (no swaps until `setKeeper`). */
  keeper?: PublicKey | null;
  mints: (MintRef | AllowedMintInput)[];
  /** 1-500. Default 50 (0.5%). */
  maxSlippageBps?: number;
  /** 1-120. Default 60. */
  maxOracleStalenessSecs?: number;
  /** 32 bytes identifying the strategy. Default all zeros. */
  strategyHash?: Uint8Array;
  /**
   * Most the vault may lose to swaps per 24 hours versus the oracle, in USD (e.g. "25" or
   * "2.5"). Required: it bounds what a compromised keeper could extract. "0" allows no loss.
   */
  maxDailyLossUsd: string | number;
}

export interface UpdateConfigArgs {
  mints?: (MintRef | AllowedMintInput)[];
  maxSlippageBps?: number;
  maxOracleStalenessSecs?: number;
  strategyHash?: Uint8Array;
  /** USD per 24 hours, as in `CreateVaultArgs.maxDailyLossUsd`. */
  maxDailyLossUsd?: string | number;
}

export interface VaultState {
  address: PublicKey;
  owner: PublicKey;
  vaultId: bigint;
  /** null when no keeper is set. */
  keeper: PublicKey | null;
  allowedMints: { mint: PublicKey; pythFeedId: string; name?: string }[];
  maxSlippageBps: number;
  maxOracleStalenessSecs: number;
  strategyHash: string;
  paused: boolean;
  /** Unix seconds of the last swap; 0 if none. */
  lastSwapTs: number;
  /** Daily loss limit and the losses counted in the current window, in USD (e.g. "25"). */
  maxDailyLossUsd: string;
  lossInWindowUsd: string;
  /** Unix seconds the current 24-hour loss window started; 0 before the first swap. */
  lossWindowStart: number;
}

export interface TokenBalance {
  mint: PublicKey;
  /** The mint's name in the deployment, if it is one of its mints. */
  name?: string;
  tokenAccount: PublicKey;
  amount: bigint;
  decimals: number;
  /** `amount` in whole tokens, e.g. "1000.5". */
  uiAmount: string;
  allowed: boolean;
}

export interface SwapRoute {
  /** Must be the swap program the vault build pins (see `swapProgramId`). */
  programId: PublicKey;
  /** The venue instruction's accounts, in order. */
  accounts: AccountMeta[];
  /** The venue instruction's data. */
  data: Uint8Array;
}

export interface BuildSwapArgs {
  vault: PublicKey;
  inputMint: MintRef;
  outputMint: MintRef;
  amountIn: Amount;
  /** The keeper's own minimum output (base units); the vault also enforces its oracle minimum. */
  keeperMinOut?: Amount;
  route: SwapRoute;
  /** Default: the client's wallet. */
  keeper?: PublicKey;
  /** Pyth price accounts; default: the deployment's for each mint. */
  inputPriceUpdate?: PublicKey;
  outputPriceUpdate?: PublicKey;
}

export interface VaultClientOptions {
  connection: Connection;
  wallet: VaultWallet;
  deployment: Deployment;
  commitment?: Commitment;
}

type ResolvedMint = { address: PublicKey; name?: string; info?: DeployedMint };
type BNType = InstanceType<typeof BN>;

export class VaultClient {
  readonly connection: Connection;
  readonly wallet: VaultWallet;
  readonly deployment: Deployment;
  readonly program: AnchorProgram<Vault>;

  constructor(options: VaultClientOptions) {
    const { connection, wallet, deployment } = options;
    if (deployment.programs.vault.programId !== VAULT_IDL.address) {
      throw new Error(
        `deployment's vault program ${deployment.programs.vault.programId} does not match this ` +
          `client's IDL (${VAULT_IDL.address}); re-sync the IDL or use the right deployment`,
      );
    }
    this.connection = connection;
    this.wallet = wallet;
    this.deployment = deployment;
    const provider = new AnchorProvider(connection, wallet, {
      commitment: options.commitment ?? "confirmed",
    });
    this.program = new Program(VAULT_IDL, provider);
  }

  /** A client for `deployments/<cluster>.json`, connected to the RPC it records unless given one. */
  static fromCluster(
    cluster: string,
    wallet: VaultWallet,
    options: { connection?: Connection; deploymentsDir?: string; commitment?: Commitment } = {},
  ) {
    const deployment = loadDeployment(
      cluster,
      options.deploymentsDir ? { dir: options.deploymentsDir } : {},
    );
    const connection = options.connection ?? new Connection(deployment.rpc, "confirmed");
    return new VaultClient({
      connection,
      wallet,
      deployment,
      ...(options.commitment ? { commitment: options.commitment } : {}),
    });
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  /** The vault PDA for `owner` (default: the wallet) and `vaultId` (default 0). */
  vaultAddress(owner: PublicKey = this.wallet.publicKey, vaultId = 0n): PublicKey {
    return vaultAddress(this.programId, owner, vaultId);
  }

  /** The swap program this deployment's vault build pins: mock-swap for devnet-mock builds. */
  swapProgramId(): PublicKey {
    const { vault, mockSwap } = this.deployment.programs;
    if (!vault.build.includes("devnet-mock")) return JUPITER_PROGRAM_ID;
    if (!mockSwap) throw new Error("deployment has a devnet-mock vault but no mockSwap program");
    return new PublicKey(mockSwap.programId);
  }

  /** Resolves a mint name or address, with its deployment entry when there is one. */
  mint(ref: MintRef): ResolvedMint {
    const mints = Object.entries(this.deployment.mints);
    if (typeof ref === "string") {
      const named = mints.find(([name]) => name === ref);
      if (named)
        return { address: new PublicKey(named[1].address), name: named[0], info: named[1] };
      let address: PublicKey;
      try {
        address = new PublicKey(ref);
      } catch {
        throw new Error(
          `unknown mint "${ref}": not in the deployment (${mints.map(([n]) => n).join(", ")}) and not an address`,
        );
      }
      return this.mint(address);
    }
    const known = mints.find(([, m]) => m.address === ref.toBase58());
    return known ? { address: ref, name: known[0], info: known[1] } : { address: ref };
  }

  // ------------------------------------------------------------ instruction builders

  async createVaultIx(args: CreateVaultArgs, owner: PublicKey = this.wallet.publicKey) {
    const vaultId = args.vaultId ?? 0n;
    const vault = this.vaultAddress(owner, vaultId);
    const allowed = args.mints.map((m) => this.allowedMint(m));
    const ix = await this.program.methods
      .initializeVault({
        vaultId: new BN(vaultId.toString()),
        keeper: args.keeper ?? PublicKey.default,
        allowedMints: allowed.map((a) => ({ mint: a.mint, pythFeedId: a.pythFeedId })),
        maxSlippageBps: args.maxSlippageBps ?? 50,
        maxOracleStalenessSecs: args.maxOracleStalenessSecs ?? 60,
        strategyHash: bytes32(args.strategyHash, "strategyHash"),
        maxDailyLossUsd: bn(usdMicro(args.maxDailyLossUsd)),
      })
      .accountsStrict({ owner, vault, systemProgram: SystemProgram.programId })
      .remainingAccounts(mintMetas(allowed.map((a) => a.mint)))
      .instruction();
    return { ix, vault };
  }

  /** Moves `amount` from the owner's ATA into the vault's (created if needed). */
  async depositIx(args: { vault: PublicKey; mint: MintRef; amount: Amount; owner?: PublicKey }) {
    const owner = args.owner ?? this.wallet.publicKey;
    const mint = this.mint(args.mint).address;
    return this.program.methods
      .deposit(bn(args.amount))
      .accountsStrict({
        owner,
        vault: args.vault,
        mint,
        ownerTokenAccount: getAssociatedTokenAddressSync(mint, owner),
        vaultTokenAccount: getAssociatedTokenAddressSync(mint, args.vault, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Creates the owner's ATA if missing, then withdraws `amount` into it. */
  async withdrawIx(args: { vault: PublicKey; mint: MintRef; amount: Amount; owner?: PublicKey }) {
    const owner = args.owner ?? this.wallet.publicKey;
    const mint = this.mint(args.mint).address;
    const ownerAta = getAssociatedTokenAddressSync(mint, owner);
    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ownerAta,
      owner,
      mint,
    );
    const withdraw = await this.program.methods
      .withdraw(bn(args.amount))
      .accountsStrict({
        owner,
        vault: args.vault,
        mint,
        vaultTokenAccount: getAssociatedTokenAddressSync(mint, args.vault, true),
        ownerTokenAccount: ownerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();
    return [createAta, withdraw];
  }

  /** `keeper: null` removes the keeper. */
  async setKeeperIx(vault: PublicKey, keeper: PublicKey | null, owner = this.wallet.publicKey) {
    return this.program.methods
      .setKeeper(keeper ?? PublicKey.default)
      .accountsStrict({ owner, vault })
      .instruction();
  }

  async setPausedIx(vault: PublicKey, paused: boolean, owner = this.wallet.publicKey) {
    return this.program.methods.setPaused(paused).accountsStrict({ owner, vault }).instruction();
  }

  /** Fields left out are unchanged. */
  async updateConfigIx(vault: PublicKey, args: UpdateConfigArgs, owner = this.wallet.publicKey) {
    const allowed = args.mints?.map((m) => this.allowedMint(m));
    return this.program.methods
      .updateConfig({
        allowedMints: allowed
          ? allowed.map((a) => ({ mint: a.mint, pythFeedId: a.pythFeedId }))
          : null,
        maxSlippageBps: args.maxSlippageBps ?? null,
        maxOracleStalenessSecs: args.maxOracleStalenessSecs ?? null,
        strategyHash: args.strategyHash ? bytes32(args.strategyHash, "strategyHash") : null,
        maxDailyLossUsd:
          args.maxDailyLossUsd === undefined ? null : bn(usdMicro(args.maxDailyLossUsd)),
      })
      .accountsStrict({ owner, vault })
      .remainingAccounts(mintMetas(allowed?.map((a) => a.mint) ?? []))
      .instruction();
  }

  /**
   * The keeper's swap instruction. `route` is the venue's own instruction (Jupiter's
   * `swapInstruction` from `GET /swap/v2/build`, or mock-swap's `swap` on devnet); it is
   * passed through as route data plus remaining accounts, with the vault PDA's signer flag
   * cleared (the vault signs it in the CPI). Sign with the keeper.
   */
  async buildSwapIx(args: BuildSwapArgs): Promise<TransactionInstruction> {
    const expected = this.swapProgramId();
    if (!args.route.programId.equals(expected)) {
      throw new Error(
        `route is for ${args.route.programId.toBase58()}, but this vault only swaps through ${expected.toBase58()}`,
      );
    }
    const input = this.mint(args.inputMint);
    const output = this.mint(args.outputMint);
    const priceAccount = (m: ResolvedMint, given: PublicKey | undefined, side: string) => {
      if (given) return given;
      if (m.info) return new PublicKey(m.info.pythPriceAccount);
      throw new Error(
        `${side}PriceUpdate is required for ${m.address.toBase58()} (not in the deployment)`,
      );
    };
    const route = args.route.accounts.map((a) => ({
      pubkey: a.pubkey,
      isWritable: a.isWritable,
      isSigner: a.isSigner && !a.pubkey.equals(args.vault),
    }));
    return this.program.methods
      .swap(bn(args.amountIn), bn(args.keeperMinOut ?? 0n), Buffer.from(args.route.data))
      .accountsStrict({
        keeper: args.keeper ?? this.wallet.publicKey,
        vault: args.vault,
        inputMint: input.address,
        outputMint: output.address,
        vaultInputAccount: getAssociatedTokenAddressSync(input.address, args.vault, true),
        vaultOutputAccount: getAssociatedTokenAddressSync(output.address, args.vault, true),
        inputPriceUpdate: priceAccount(input, args.inputPriceUpdate, "input"),
        outputPriceUpdate: priceAccount(output, args.outputPriceUpdate, "output"),
        swapProgram: expected,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(route)
      .instruction();
  }

  // ------------------------------------------------------------ send

  /** Creates a vault owned by the wallet. */
  async createVault(args: CreateVaultArgs) {
    const { ix, vault } = await this.createVaultIx(args);
    return { vault, signature: await this.send([ix]) };
  }

  async deposit(args: { vault: PublicKey; mint: MintRef; amount: Amount }) {
    return this.send([await this.depositIx(args)]);
  }

  async withdraw(args: { vault: PublicKey; mint: MintRef; amount: Amount }) {
    return this.send(await this.withdrawIx(args));
  }

  async setKeeper(vault: PublicKey, keeper: PublicKey | null) {
    return this.send([await this.setKeeperIx(vault, keeper)]);
  }

  async setPaused(vault: PublicKey, paused: boolean) {
    return this.send([await this.setPausedIx(vault, paused)]);
  }

  async updateConfig(vault: PublicKey, args: UpdateConfigArgs) {
    return this.send([await this.updateConfigIx(vault, args)]);
  }

  /** Signs with the wallet and sends; resolves once confirmed. */
  async send(instructions: TransactionInstruction[]): Promise<string> {
    const provider = this.program.provider as InstanceType<typeof AnchorProvider>;
    return provider.sendAndConfirm(new Transaction().add(...instructions));
  }

  // ------------------------------------------------------------ read

  /** The vault's state, or null if it does not exist. */
  async getVault(vault: PublicKey): Promise<VaultState | null> {
    const raw = await this.program.account.vault.fetchNullable(vault);
    return raw ? this.toVaultState(vault, raw) : null;
  }

  /**
   * Every token account the vault controls (any mint), plus a zero entry for each allowed
   * mint it does not hold yet. Allowed mints first, in the vault's order.
   */
  async getBalances(vault: PublicKey): Promise<TokenBalance[]> {
    const state = await this.getVault(vault);
    if (!state) throw new Error(`vault ${vault.toBase58()} not found`);
    const held = await this.connection.getTokenAccountsByOwner(vault, {
      programId: TOKEN_PROGRAM_ID,
    });
    const accounts = held.value.map(({ pubkey, account }) => unpackAccount(pubkey, account));

    const allowed = state.allowedMints.map((m) => m.mint);
    const mints = [
      ...allowed,
      ...accounts.map((a) => a.mint).filter((m) => !allowed.some((x) => x.equals(m))),
    ].filter((m, i, all) => all.findIndex((x) => x.equals(m)) === i);
    const decimals = await this.decimalsOf(mints);

    const rows: TokenBalance[] = [];
    for (const mint of mints) {
      const name = this.mint(mint).name;
      const isAllowed = allowed.some((m) => m.equals(mint));
      const own = accounts.filter((a) => a.mint.equals(mint));
      const ata = getAssociatedTokenAddressSync(mint, vault, true);
      const entries = own.length ? own : isAllowed ? [{ address: ata, amount: 0n }] : [];
      for (const a of entries) {
        const d = decimals.get(mint.toBase58()) ?? 0;
        rows.push({
          mint,
          ...(name ? { name } : {}),
          tokenAccount: a.address,
          amount: a.amount,
          decimals: d,
          uiAmount: formatUnits(a.amount, d),
          allowed: isAllowed,
        });
      }
    }
    return rows;
  }

  // ------------------------------------------------------------ helpers

  private allowedMint(input: MintRef | AllowedMintInput) {
    const { mint: ref, pythFeedId } =
      typeof input === "string" || input instanceof PublicKey ? { mint: input } : input;
    const mint = this.mint(ref);
    const feed = pythFeedId ?? mint.info?.pythFeedId;
    if (!feed) {
      throw new Error(
        `pythFeedId is required for ${mint.address.toBase58()} (not in the deployment)`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(feed))
      throw new Error(`pythFeedId must be 64 hex characters: ${feed}`);
    return { mint: mint.address, pythFeedId: [...Buffer.from(feed, "hex")] };
  }

  private async decimalsOf(mints: PublicKey[]) {
    const out = new Map<string, number>();
    const unknown = mints.filter((m) => {
      const info = this.mint(m).info;
      if (info) out.set(m.toBase58(), info.decimals);
      return !info;
    });
    if (unknown.length) {
      const infos = await this.connection.getMultipleAccountsInfo(unknown);
      unknown.forEach((m, i) => {
        const info = infos[i];
        if (info) out.set(m.toBase58(), unpackMint(m, info).decimals);
      });
    }
    return out;
  }

  private toVaultState(address: PublicKey, raw: IdlAccounts<Vault>["vault"]): VaultState {
    return {
      address,
      owner: raw.owner,
      vaultId: BigInt(raw.vaultId.toString()),
      keeper: raw.keeper.equals(PublicKey.default) ? null : raw.keeper,
      allowedMints: raw.allowedMints.map((m) => {
        const name = this.mint(m.mint).name;
        return {
          mint: m.mint,
          pythFeedId: Buffer.from(m.pythFeedId).toString("hex"),
          ...(name ? { name } : {}),
        };
      }),
      maxSlippageBps: raw.maxSlippageBps,
      maxOracleStalenessSecs: raw.maxOracleStalenessSecs,
      strategyHash: Buffer.from(raw.strategyHash).toString("hex"),
      paused: raw.paused,
      lastSwapTs: raw.lastSwapTs.toNumber(),
      maxDailyLossUsd: formatUnits(BigInt(raw.maxDailyLossUsd.toString()), USD_DECIMALS),
      lossInWindowUsd: formatUnits(BigInt(raw.lossInWindowUsd.toString()), USD_DECIMALS),
      lossWindowStart: raw.lossWindowStart.toNumber(),
    };
  }
}

/** The vault PDA: seeds ["vault", owner, vault_id as u64 little-endian]. */
export function vaultAddress(programId: PublicKey, owner: PublicKey, vaultId = 0n): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(vaultId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), owner.toBuffer(), id],
    programId,
  )[0];
}

/** An Anchor-compatible wallet for a local keypair (scripts, tests, the keeper). */
export function keypairWallet(keypair: Keypair): VaultWallet {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if ("version" in tx) (tx as VersionedTransaction).sign([keypair]);
    else (tx as Transaction).partialSign(keypair);
    return tx;
  };
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  };
}

function bn(amount: Amount): BNType {
  const value = BigInt(amount);
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error(`amount out of u64 range: ${amount}`);
  return new BN(value.toString());
}

/** The program stores USD amounts with 6 decimals (micro-USD). */
const USD_DECIMALS = 6;

function usdMicro(usd: string | number): bigint {
  return parseUnits(String(usd), USD_DECIMALS);
}

function bytes32(value: Uint8Array | undefined, name: string): number[] {
  if (!value) return Array<number>(32).fill(0);
  if (value.length !== 32) throw new Error(`${name} must be 32 bytes, got ${value.length}`);
  return [...value];
}

function mintMetas(mints: PublicKey[]): AccountMeta[] {
  return mints.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}
