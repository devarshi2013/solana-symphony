// Test-only helpers (excluded from the build).
import { Keypair } from "@solana/web3.js";

import { VAULT_IDL } from "./idl/vault.js";

const key = () => Keypair.generate().publicKey.toBase58();

/** A deployment shaped like the deploy script's output, with fresh addresses. */
export function sampleDeployment(build = "devnet-mock (TEST-ONLY: swaps go to mock-swap)") {
  const mint = (decimals: number, feed: string) => ({
    address: key(),
    decimals,
    pythFeedId: feed.repeat(64),
    pythPriceAccount: key(),
  });
  return {
    cluster: "devnet",
    rpc: "http://127.0.0.1:1",
    genesisHash: "test",
    updatedAt: "2026-10-06T00:00:00.000Z",
    deployer: key(),
    programs: {
      vault: { programId: VAULT_IDL.address as string, build, sha256: "0" },
      mockSwap: { programId: key(), build: "TEST-ONLY", sha256: "0" },
    },
    mints: { tUSDC: mint(6, "a"), tSOL: mint(9, "b"), tJUP: mint(6, "c") } as Record<
      string,
      ReturnType<typeof mint>
    >,
  };
}
