import { describe, expect, it } from "vitest";
import { DATA_PACKAGE_NAME } from "./index.js";

describe("data package scaffold", () => {
  it("exposes its package name", () => {
    expect(DATA_PACKAGE_NAME).toBe("@solana-symphony/data");
  });
});
