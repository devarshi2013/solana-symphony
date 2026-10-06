import { describe, expect, it } from "vitest";

import { formatUnits, parseUnits } from "./units.js";

describe("parseUnits", () => {
  it("converts whole tokens to base units", () => {
    expect(parseUnits("1000", 6)).toBe(1_000_000_000n);
    expect(parseUnits("1000.5", 6)).toBe(1_000_500_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits(" 2 ", 9)).toBe(2_000_000_000n);
    expect(parseUnits("7", 0)).toBe(7n);
  });

  it("rejects bad input instead of rounding", () => {
    expect(() => parseUnits("0.0000001", 6)).toThrow(/more than 6 decimal places/);
    expect(() => parseUnits("-1", 6)).toThrow(/not a non-negative/);
    expect(() => parseUnits("1e6", 6)).toThrow();
    expect(() => parseUnits("", 6)).toThrow();
    expect(() => parseUnits("1.", 6)).toThrow();
  });
});

describe("formatUnits", () => {
  it("formats base units without trailing zeros", () => {
    expect(formatUnits(1_000_000_000n, 6)).toBe("1000");
    expect(formatUnits(1_000_500_000n, 6)).toBe("1000.5");
    expect(formatUnits(1n, 9)).toBe("0.000000001");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(42n, 0)).toBe("42");
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
  });

  it("round-trips with parseUnits", () => {
    for (const [s, d] of [
      ["1000.5", 6],
      ["0.000000001", 9],
      ["123456789.123456", 6],
    ] as const) {
      expect(formatUnits(parseUnits(s, d), d)).toBe(s);
    }
  });
});
