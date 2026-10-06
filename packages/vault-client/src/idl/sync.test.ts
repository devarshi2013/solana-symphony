import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VAULT_IDL } from "./vault.js";

const built = new URL("../../../../target/idl/vault.json", import.meta.url);

describe("packaged IDL", () => {
  it.runIf(existsSync(built))("matches the latest anchor build (else run sync-idl)", () => {
    expect(VAULT_IDL).toEqual(JSON.parse(readFileSync(built, "utf8")));
  });
});
