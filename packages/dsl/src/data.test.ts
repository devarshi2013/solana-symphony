import { describe, expect, it } from "vitest";
import { InMemoryPriceProvider } from "./data.js";

// Fri 2024-03-01, then a weekend gap, then Mon 2024-03-04 to Wed 2024-03-06.
const provider = new InMemoryPriceProvider({
  SOL: [
    { date: "2024-03-01", close: 100 },
    { date: "2024-03-04", close: 104 },
    { date: "2024-03-05", close: 105 },
    { date: "2024-03-06", close: 106 },
  ],
});

const utc = (iso: string) => new Date(iso);

describe("InMemoryPriceProvider.getCloses", () => {
  // A candle dated D closes at 00:00 UTC on D + 1; only then may it be used.
  describe("exact date", () => {
    it("includes a candle from the moment it closes, oldest first", () => {
      // 2024-03-06T00:00Z is exactly when the 2024-03-05 candle closes
      expect(provider.getCloses("SOL", utc("2024-03-06T00:00:00Z"), 3)).toEqual([100, 104, 105]);
    });

    it("excludes the current day's candle until the day has closed (no look-ahead)", () => {
      // during 2024-03-05 its close does not exist yet; the latest is 2024-03-04's
      expect(provider.getCloses("SOL", utc("2024-03-05T23:59:59.999Z"), 2)).toEqual([100, 104]);
      expect(provider.getCloses("SOL", utc("2024-03-05T09:00:00Z"), 1)).toEqual([104]);
    });

    it("can return the whole series", () => {
      expect(provider.getCloses("SOL", utc("2024-03-07T00:00:00Z"), 4)).toEqual([
        100, 104, 105, 106,
      ]);
    });
  });

  describe("date between candles", () => {
    it("ends at the last candle closed before asOf", () => {
      // Sunday: the last close is Friday 2024-03-01's
      expect(provider.getCloses("SOL", utc("2024-03-03T12:00:00Z"), 1)).toEqual([100]);
    });

    it("skips missing days instead of filling them", () => {
      expect(provider.getCloses("SOL", utc("2024-03-05T00:00:00Z"), 2)).toEqual([100, 104]);
    });

    it("ends at the last candle when asOf is after all data", () => {
      expect(provider.getCloses("SOL", utc("2025-01-01T00:00:00Z"), 2)).toEqual([105, 106]);
    });
  });

  describe("not enough history", () => {
    it("returns null when the lookback reaches before the first candle", () => {
      expect(provider.getCloses("SOL", utc("2024-03-05T00:00:00Z"), 3)).toBeNull();
    });

    it("returns null before the first candle has closed", () => {
      expect(provider.getCloses("SOL", utc("2024-03-01T12:00:00Z"), 1)).toBeNull();
    });

    it("returns null for an unknown symbol", () => {
      expect(provider.getCloses("JUP", utc("2024-03-07T00:00:00Z"), 1)).toBeNull();
    });
  });

  it("rejects a lookback that is not a positive integer", () => {
    const asOf = utc("2024-03-07T00:00:00Z");
    expect(() => provider.getCloses("SOL", asOf, 0)).toThrow(RangeError);
    expect(() => provider.getCloses("SOL", asOf, 1.5)).toThrow(RangeError);
  });

  it("rejects an invalid asOf", () => {
    expect(() => provider.getCloses("SOL", new Date("nope"), 1)).toThrow(RangeError);
  });

  it("returns a copy that callers cannot use to change stored data", () => {
    const asOf = utc("2024-03-07T00:00:00Z");
    provider.getCloses("SOL", asOf, 1)!.push(999);
    expect(provider.getCloses("SOL", asOf, 1)).toEqual([106]);
  });
});

describe("InMemoryPriceProvider construction", () => {
  it("sorts unordered input by date", () => {
    const p = new InMemoryPriceProvider({
      SOL: [
        { date: "2024-01-03", close: 3 },
        { date: "2024-01-01", close: 1 },
        { date: "2024-01-02", close: 2 },
      ],
    });
    expect(p.getCloses("SOL", utc("2024-01-04T00:00:00Z"), 3)).toEqual([1, 2, 3]);
  });

  it("rejects malformed dates, duplicate dates, and non-positive closes", () => {
    expect(() => new InMemoryPriceProvider({ SOL: [{ date: "2024-02-30", close: 1 }] })).toThrow(
      'SOL: invalid date "2024-02-30"',
    );
    expect(
      () =>
        new InMemoryPriceProvider({
          SOL: [
            { date: "2024-01-01", close: 1 },
            { date: "2024-01-01", close: 2 },
          ],
        }),
    ).toThrow("SOL: duplicate candle for 2024-01-01");
    expect(() => new InMemoryPriceProvider({ SOL: [{ date: "2024-01-01", close: 0 }] })).toThrow(
      "close must be a positive number",
    );
  });
});
