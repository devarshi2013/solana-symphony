import { describe, expect, it } from "vitest";
import { VAULT_CLIENT_PACKAGE_NAME } from "./index.js";

describe("vault-client package scaffold", () => {
  it("exposes its package name", () => {
    expect(VAULT_CLIENT_PACKAGE_NAME).toBe("@solana-symphony/vault-client");
  });
});
