import { describe, expect, it } from "vitest";
import { DSL_PACKAGE_NAME } from "./index.js";

describe("dsl package scaffold", () => {
  it("exposes its package name", () => {
    expect(DSL_PACKAGE_NAME).toBe("@solana-symphony/dsl");
  });
});
