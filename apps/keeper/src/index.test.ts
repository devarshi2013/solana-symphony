import { describe, expect, it } from "vitest";
import { KEEPER_APP_NAME } from "./index.js";

describe("keeper app scaffold", () => {
  it("exposes its app name", () => {
    expect(KEEPER_APP_NAME).toBe("@solana-symphony/keeper");
  });
});
