import { defineConfig } from "vitest/config";

// Run by `anchor test` (see Anchor.toml [scripts]), which starts a local validator,
// deploys the program and sets ANCHOR_PROVIDER_URL and ANCHOR_WALLET.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
