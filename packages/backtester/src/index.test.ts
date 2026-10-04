import { describe, expect, it } from "vitest";
import { BACKTESTER_PACKAGE_NAME } from "./index.js";

describe("backtester package scaffold", () => {
  it("exposes its package name", () => {
    expect(BACKTESTER_PACKAGE_NAME).toBe("@solana-symphony/backtester");
  });
});
