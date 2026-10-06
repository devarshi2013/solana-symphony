import { describe, expect, it } from "vitest";
import { addDays, isValidCandle, lastCompleteDay, mergeCandles, type Candle } from "./candle.js";

const candle = (date: string, close = 1, volume: number | null = 10): Candle => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe("lastCompleteDay", () => {
  it("is yesterday in UTC, since today's candle is still forming", () => {
    expect(lastCompleteDay(new Date("2024-03-05T10:00:00Z"))).toBe("2024-03-04");
  });

  it("uses UTC even right after midnight", () => {
    expect(lastCompleteDay(new Date("2024-03-05T00:00:00Z"))).toBe("2024-03-04");
    expect(lastCompleteDay(new Date("2024-03-04T23:59:59Z"))).toBe("2024-03-03");
  });
});

describe("addDays", () => {
  it("crosses month, year and leap-day boundaries", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2023-12-31", 1)).toBe("2024-01-01");
    expect(addDays("2024-01-01", -1)).toBe("2023-12-31");
  });
});

describe("isValidCandle", () => {
  it("accepts positive prices with a volume or null volume", () => {
    expect(isValidCandle(candle("2024-01-01"))).toBe(true);
    expect(isValidCandle(candle("2024-01-01", 1, null))).toBe(true);
  });

  it("rejects non-positive or non-finite prices and negative volume", () => {
    expect(isValidCandle(candle("2024-01-01", 0))).toBe(false);
    expect(isValidCandle({ ...candle("2024-01-01"), low: Number.NaN })).toBe(false);
    expect(isValidCandle(candle("2024-01-01", 1, -5))).toBe(false);
  });
});

describe("mergeCandles", () => {
  it("sorts by date, keeps one candle per date, and lets incoming data win", () => {
    const merged = mergeCandles(
      [candle("2024-01-02", 2), candle("2024-01-01", 1)],
      [candle("2024-01-03", 3), candle("2024-01-02", 22)],
    );
    expect(merged.map((c) => [c.date, c.close])).toEqual([
      ["2024-01-01", 1],
      ["2024-01-02", 22],
      ["2024-01-03", 3],
    ]);
  });
});
