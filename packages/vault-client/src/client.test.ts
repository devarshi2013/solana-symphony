import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { JUPITER_PROGRAM_ID, keypairWallet, vaultAddress, VaultClient } from "./client.js";
import { parseDeployment } from "./deployments.js";
import { VAULT_IDL } from "./idl/vault.js";
import { sampleDeployment } from "./test-fixtures.js";

// Builders never touch the network; this endpoint is never contacted.
const connection = new Connection("http://127.0.0.1:1");
const owner = Keypair.generate();

function client(build?: string) {
  const deployment = parseDeployment(sampleDeployment(build));
  return new VaultClient({ connection, wallet: keypairWallet(owner), deployment });
}

/** Decodes instruction data (Anchor's TS coder returns camelCase names and fields). */
const decode = (c: VaultClient, data: Buffer) =>
  (
    c.program.coder.instruction as unknown as {
      decode(data: Buffer): { name: string; data: Record<string, unknown> } | null;
    }
  ).decode(data);

describe("VaultClient setup", () => {
  it("refuses a deployment for another vault program", () => {
    const d = sampleDeployment();
    d.programs.vault.programId = Keypair.generate().publicKey.toBase58();
    expect(
      () =>
        new VaultClient({
          connection,
          wallet: keypairWallet(owner),
          deployment: parseDeployment(d),
        }),
    ).toThrow(/does not match this client's IDL/);
  });

  it("derives the vault PDA from owner and vault id", () => {
    const c = client();
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(7n);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.publicKey.toBuffer(), id],
      new PublicKey(VAULT_IDL.address),
    );
    expect(c.vaultAddress(owner.publicKey, 7n).equals(expected)).toBe(true);
    expect(vaultAddress(c.programId, owner.publicKey, 7n).equals(expected)).toBe(true);
    expect(c.vaultAddress().equals(c.vaultAddress(owner.publicKey, 0n))).toBe(true);
  });

  it("resolves mints by name or address", () => {
    const c = client();
    const usdc = c.mint("tUSDC");
    expect(usdc.name).toBe("tUSDC");
    expect(c.mint(usdc.address).name).toBe("tUSDC");
    expect(c.mint(usdc.address.toBase58()).name).toBe("tUSDC");
    expect(c.mint(Keypair.generate().publicKey).name).toBeUndefined();
    expect(() => c.mint("tDOGE")).toThrow(/unknown mint "tDOGE".*tUSDC, tSOL, tJUP/);
  });

  it("knows which swap program the vault build accepts", () => {
    const mock = client();
    expect(mock.swapProgramId().toBase58()).toBe(mock.deployment.programs.mockSwap?.programId);
    expect(client("normal").swapProgramId().equals(JUPITER_PROGRAM_ID)).toBe(true);
  });
});

describe("instruction builders", () => {
  it("createVault: named mints become allowed mints with their Pyth feeds", async () => {
    const c = client();
    const { ix, vault } = await c.createVaultIx({
      vaultId: 3n,
      mints: ["tUSDC", "tSOL"],
      maxDailyLossUsd: "12.5",
    });
    expect(vault.equals(c.vaultAddress(owner.publicKey, 3n))).toBe(true);
    const decoded = decode(c, ix.data);
    expect(decoded?.name).toBe("initializeVault");
    const args = (decoded?.data as { args: Record<string, unknown> }).args;
    expect(args.keeper).toEqual(PublicKey.default); // no keeper by default
    expect(args.maxSlippageBps).toBe(50);
    expect(String(args.maxDailyLossUsd)).toBe("12500000"); // micro-USD
    const allowed = args.allowedMints as { mint: PublicKey; pythFeedId: number[] }[];
    expect(allowed.map((m) => m.mint.toBase58())).toEqual([
      c.mint("tUSDC").address.toBase58(),
      c.mint("tSOL").address.toBase58(),
    ]);
    expect(Buffer.from(allowed[0]!.pythFeedId).toString("hex")).toBe("a".repeat(64));
    // the mint accounts follow the named accounts, in order
    expect(ix.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual(
      allowed.map((m) => m.mint.toBase58()),
    );
  });

  it("createVault: a mint outside the deployment needs its feed id", async () => {
    const c = client();
    const other = Keypair.generate().publicKey;
    const base = { maxDailyLossUsd: 10 };
    await expect(c.createVaultIx({ ...base, mints: [other] })).rejects.toThrow(
      /pythFeedId is required/,
    );
    await expect(
      c.createVaultIx({ ...base, mints: [{ mint: other, pythFeedId: "zz" }] }),
    ).rejects.toThrow(/64 hex/);
    await expect(
      c.createVaultIx({ ...base, mints: [{ mint: other, pythFeedId: "d".repeat(64) }] }),
    ).resolves.toBeDefined();
    await expect(c.createVaultIx({ mints: ["tUSDC"], maxDailyLossUsd: "-1" })).rejects.toThrow(
      /not a non-negative/,
    );
  });

  it("deposit and withdraw use the owner's and the vault's ATAs", async () => {
    const c = client();
    const vault = c.vaultAddress();
    const usdc = c.mint("tUSDC").address;
    const deposit = await c.depositIx({ vault, mint: "tUSDC", amount: 1_000_000_000n });
    const keys = deposit.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(getAssociatedTokenAddressSync(usdc, owner.publicKey).toBase58());
    expect(keys).toContain(getAssociatedTokenAddressSync(usdc, vault, true).toBase58());
    expect(String(decode(c, deposit.data)?.data.amount)).toBe("1000000000");

    const [createAta, withdraw] = await c.withdrawIx({ vault, mint: "tUSDC", amount: 5 });
    expect(createAta?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(decode(c, withdraw!.data)?.name).toBe("withdraw");
  });

  it("rejects amounts outside u64", async () => {
    const c = client();
    const vault = c.vaultAddress();
    await expect(c.depositIx({ vault, mint: "tUSDC", amount: -1n })).rejects.toThrow(/u64/);
    await expect(c.depositIx({ vault, mint: "tUSDC", amount: 2n ** 64n })).rejects.toThrow(/u64/);
  });

  it("updateConfig sends only the fields given", async () => {
    const c = client();
    const ix = await c.updateConfigIx(c.vaultAddress(), { maxSlippageBps: 100 });
    const args = (decode(c, ix.data)?.data as { args: Record<string, unknown> }).args;
    expect(args).toEqual({
      allowedMints: null,
      maxSlippageBps: 100,
      maxOracleStalenessSecs: null,
      strategyHash: null,
      maxDailyLossUsd: null,
    });
    const limit = await c.updateConfigIx(c.vaultAddress(), { maxDailyLossUsd: "0.5" });
    const limitArgs = (decode(c, limit.data)?.data as { args: Record<string, unknown> }).args;
    expect(String(limitArgs.maxDailyLossUsd)).toBe("500000");
  });

  it("setKeeper(null) removes the keeper", async () => {
    const c = client();
    const ix = await c.setKeeperIx(c.vaultAddress(), null);
    expect((decode(c, ix.data)?.data.newKeeper as PublicKey).equals(PublicKey.default)).toBe(true);
  });
});

describe("buildSwapIx", () => {
  const setup = () => {
    const c = client();
    const vault = c.vaultAddress();
    const venueAccount = Keypair.generate().publicKey;
    const route = {
      programId: c.swapProgramId(),
      accounts: [
        { pubkey: vault, isSigner: true, isWritable: false }, // the venue's transfer authority
        { pubkey: venueAccount, isSigner: false, isWritable: true },
      ],
      data: Uint8Array.from([1, 2, 3]),
    };
    return { c, vault, route, venueAccount };
  };

  it("passes the route through with the vault's signer flag cleared", async () => {
    const { c, vault, route, venueAccount } = setup();
    const ix = await c.buildSwapIx({
      vault,
      inputMint: "tUSDC",
      outputMint: "tSOL",
      amountIn: 150_000_000n,
      keeperMinOut: 1n,
      route,
    });
    const tail = ix.keys.slice(-2);
    expect(tail[0]).toEqual({ pubkey: vault, isSigner: false, isWritable: false });
    expect(tail[1]?.pubkey.equals(venueAccount)).toBe(true);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(c.deployment.mints.tUSDC?.pythPriceAccount);
    expect(keys).toContain(c.deployment.mints.tSOL?.pythPriceAccount);
    const decoded = decode(c, ix.data)?.data ?? {};
    expect(String(decoded.amountIn)).toBe("150000000");
    expect(String(decoded.keeperMinOut)).toBe("1");
    expect([...(decoded.routeData as Buffer)]).toEqual([1, 2, 3]);
  });

  it("refuses a route for any other program", async () => {
    const { c, vault, route } = setup();
    await expect(
      c.buildSwapIx({
        vault,
        inputMint: "tUSDC",
        outputMint: "tSOL",
        amountIn: 1,
        route: { ...route, programId: JUPITER_PROGRAM_ID },
      }),
    ).rejects.toThrow(/only swaps through/);
  });
});
