import { describe, expect, it } from "vitest";
import { InMemoryPriceProvider } from "./data.js";
import {
  computeIndicator,
  cumulativeReturn,
  ema,
  lookbackFor,
  maxDrawdown,
  rsi,
  sma,
  stdDevReturn,
} from "./indicators.js";
import type { Indicator } from "./types.js";

describe("sma", () => {
  it("averages the last window closes", () => {
    // last 3 of [1, 2, 3, 4, 5] = 3, 4, 5 -> (3 + 4 + 5) / 3 = 12 / 3 = 4
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
  });

  it("uses every close when there are exactly window of them", () => {
    // (10 + 20) / 2 = 15
    expect(sma([10, 20], 2)).toBe(15);
  });

  it("returns null with fewer than window closes", () => {
    expect(sma([1, 2], 3)).toBeNull();
  });
});

describe("ema", () => {
  it("seeds with the SMA, then smooths each later close", () => {
    // window 3 -> alpha = 2 / (3 + 1) = 0.5
    // seed  = SMA(1, 2, 3)           = 6 / 3 = 2
    // 4     -> 0.5 * 4 + 0.5 * 2     = 2 + 1 = 3
    // 5     -> 0.5 * 5 + 0.5 * 3     = 2.5 + 1.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
  });

  it("equals the SMA with exactly window closes", () => {
    // seed = (2 + 4 + 6) / 3 = 4, nothing left to smooth
    expect(ema([2, 4, 6], 3)).toBe(4);
  });

  it("uses alpha = 2 / (window + 1)", () => {
    // window 4 -> alpha = 2 / 5 = 0.4
    // seed = (10 + 10 + 10 + 10) / 4 = 10
    // 20   -> 0.4 * 20 + 0.6 * 10 = 8 + 6 = 14
    expect(ema([10, 10, 10, 10, 20], 4)).toBeCloseTo(14, 12);
  });

  it("returns null with fewer than window closes", () => {
    expect(ema([1, 2], 3)).toBeNull();
  });
});

describe("rsi (Wilder)", () => {
  it("smooths gains and losses with Wilder's method", () => {
    // closes 10, 12, 11, 13, 12 -> changes +2, -1, +2, -1; window 2
    // first averages (changes +2, -1):
    //   avgGain = (2 + 0) / 2 = 1        avgLoss = (0 + 1) / 2 = 0.5
    // change +2: avgGain = (1 * 1 + 2) / 2 = 1.5      avgLoss = (0.5 * 1 + 0) / 2 = 0.25
    // change -1: avgGain = (1.5 * 1 + 0) / 2 = 0.75   avgLoss = (0.25 * 1 + 1) / 2 = 0.625
    // RS  = 0.75 / 0.625 = 1.2
    // RSI = 100 - 100 / (1 + 1.2) = 100 - 45.4545... = 54.5454... (= 600 / 11)
    expect(rsi([10, 12, 11, 13, 12], 2)).toBeCloseTo(600 / 11, 10);
  });

  it("uses simple averages when there are exactly window changes", () => {
    // closes 10, 11, 10.5, 11.5 -> changes +1, -0.5, +1; window 3
    // avgGain = (1 + 0 + 1) / 3 = 2/3   avgLoss = (0 + 0.5 + 0) / 3 = 1/6
    // RS = (2/3) / (1/6) = 4   RSI = 100 - 100 / 5 = 80
    expect(rsi([10, 11, 10.5, 11.5], 3)).toBeCloseTo(80, 10);
  });

  it("is 100 with only gains and 50 with no movement", () => {
    // changes +1, +1 -> avgLoss = 0, avgGain > 0
    expect(rsi([1, 2, 3], 2)).toBe(100);
    // changes 0, 0 -> no gains and no losses
    expect(rsi([5, 5, 5], 2)).toBe(50);
  });

  it("returns null with fewer than window + 1 closes", () => {
    // window 2 needs 2 changes = 3 closes
    expect(rsi([1, 2], 2)).toBeNull();
  });
});

describe("cumulativeReturn", () => {
  it("compares the last close with the close window days earlier", () => {
    // window 2 over [100, 110, 99, 121] -> from 110 (2 days back) to 121
    // 121 / 110 - 1 = 0.1 -> 10%
    expect(cumulativeReturn([100, 110, 99, 121], 2)).toBeCloseTo(10, 10);
  });

  it("reports losses as negative percent", () => {
    // 75 / 100 - 1 = -0.25 -> -25%
    expect(cumulativeReturn([100, 75], 1)).toBeCloseTo(-25, 10);
  });

  it("returns null with fewer than window + 1 closes", () => {
    expect(cumulativeReturn([100, 110], 2)).toBeNull();
  });
});

describe("stdDevReturn", () => {
  it("is the population standard deviation of daily returns", () => {
    // [100, 110, 99] -> returns 110/100 - 1 = +0.10, 99/110 - 1 = -0.10
    // mean = 0; variance = (0.10^2 + 0.10^2) / 2 = 0.02 / 2 = 0.01
    // sd = sqrt(0.01) = 0.1 -> 10%
    expect(stdDevReturn([100, 110, 99], 2)).toBeCloseTo(10, 10);
  });

  it("handles a non-zero mean", () => {
    // [100, 110, 99, 108.9] -> returns +0.10, -0.10, +0.10
    // mean = 0.10 / 3 = 1/30
    // deviations = 2/30, -4/30, 2/30 -> squares sum = (4 + 16 + 4) / 900 = 24/900
    // variance = (24/900) / 3 = 8/900; sd = sqrt(8) / 30 = 0.0942809... -> 9.42809...%
    expect(stdDevReturn([100, 110, 99, 108.9], 3)).toBeCloseTo((Math.sqrt(8) / 30) * 100, 10);
  });

  it("uses only the last window returns", () => {
    // window 1 over [50, 100, 110] -> one return (110/100 - 1); a single value has sd 0
    expect(stdDevReturn([50, 100, 110], 1)).toBe(0);
  });

  it("returns null with fewer than window + 1 closes", () => {
    expect(stdDevReturn([100, 110], 2)).toBeNull();
  });
});

describe("maxDrawdown", () => {
  it("finds the largest fall from a running peak", () => {
    // [100, 120, 90, 110, 80, 130], window 5 (all 6 closes)
    // peak 120: 90 -> (120 - 90) / 120 = 25%; 110 -> 8.33%; 80 -> (120 - 80) / 120 = 33.33%
    // 130 sets a new peak but nothing falls after it -> max = 1/3 = 33.333...%
    expect(maxDrawdown([100, 120, 90, 110, 80, 130], 5)).toBeCloseTo(100 / 3, 10);
  });

  it("only looks at the last window + 1 closes", () => {
    // window 2 over [100, 120, 90, 110, 80] -> [90, 110, 80]
    // peak 110, then 80 -> (110 - 80) / 110 = 30 / 110 = 27.2727...%
    expect(maxDrawdown([100, 120, 90, 110, 80], 2)).toBeCloseTo(3000 / 110, 10);
  });

  it("is 0 when prices never fall", () => {
    expect(maxDrawdown([1, 2, 3], 2)).toBe(0);
  });

  it("returns null with fewer than window + 1 closes", () => {
    expect(maxDrawdown([1, 2], 2)).toBeNull();
  });
});

describe("window validation", () => {
  it.each([sma, ema, rsi, cumulativeReturn, stdDevReturn, maxDrawdown])(
    "%o rejects a window that is not a positive integer",
    (fn) => {
      expect(() => fn([1, 2, 3], 0)).toThrow(RangeError);
      expect(() => fn([1, 2, 3], 1.5)).toThrow(RangeError);
    },
  );
});

describe("computeIndicator", () => {
  // SOL closes 1..10 on 2024-01-01..2024-01-10
  const provider = new InMemoryPriceProvider({
    SOL: Array.from({ length: 10 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      close: i + 1,
    })),
  });
  // 2024-01-11T00:00Z is when the 2024-01-10 candle closes
  const asOf = new Date("2024-01-11T00:00:00Z");
  const sol = (name: Indicator["name"], window?: number): Indicator =>
    window === undefined
      ? { type: "indicator", name, symbol: "SOL" }
      : { type: "indicator", name, symbol: "SOL", window };

  it("returns the latest close for price", () => {
    expect(computeIndicator(sol("price"), provider, asOf)).toBe(10);
    // during 2024-01-05 that day has not closed yet -> latest is 2024-01-04's close, 4
    expect(computeIndicator(sol("price"), provider, new Date("2024-01-05T12:00:00Z"))).toBe(4);
  });

  it("fetches window closes for sma", () => {
    // closes 8, 9, 10 -> 27 / 3 = 9
    expect(computeIndicator(sol("sma", 3), provider, asOf)).toBe(9);
  });

  it("fetches two windows of warm-up for ema", () => {
    // lookback = 2 * 2 = 4 -> closes 7, 8, 9, 10; alpha = 2 / 3
    // seed = (7 + 8) / 2 = 7.5
    // 9  -> (2/3) * 9  + (1/3) * 7.5   = 6 + 2.5 = 8.5
    // 10 -> (2/3) * 10 + (1/3) * 8.5   = 6.6667 + 2.8333 = 9.5
    expect(computeIndicator(sol("ema", 2), provider, asOf)).toBeCloseTo(9.5, 10);
  });

  it("dispatches the change-based indicators with window + 1 closes", () => {
    // closes 8, 9, 10: 10 / 8 - 1 = 0.25 -> 25%
    expect(computeIndicator(sol("cumulativeReturn", 2), provider, asOf)).toBeCloseTo(25, 10);
    // always rising -> no losses -> RSI 100; no falls -> drawdown 0
    expect(computeIndicator(sol("rsi", 3), provider, asOf)).toBe(100);
    expect(computeIndicator(sol("maxDrawdown", 5), provider, asOf)).toBe(0);
    // closes 9, 10: one return 10/9 - 1 -> sd of one value = 0
    expect(computeIndicator(sol("stdDevReturn", 1), provider, asOf)).toBe(0);
  });

  it("returns null when the provider lacks the required lookback", () => {
    // ema 6 needs 12 closes, only 10 exist (sma 6 would be fine)
    expect(lookbackFor("ema", 6)).toBe(12);
    expect(computeIndicator(sol("ema", 6), provider, asOf)).toBeNull();
    expect(computeIndicator(sol("sma", 6), provider, asOf)).not.toBeNull();
    // cumulativeReturn 10 needs 11 closes
    expect(computeIndicator(sol("cumulativeReturn", 10), provider, asOf)).toBeNull();
  });

  it("returns null for an unknown symbol", () => {
    const jup: Indicator = { type: "indicator", name: "price", symbol: "JUP" };
    expect(computeIndicator(jup, provider, asOf)).toBeNull();
  });

  it("throws when a windowed indicator has no window", () => {
    expect(() => computeIndicator(sol("sma"), provider, asOf)).toThrow(
      "sma indicator for SOL has no window",
    );
  });
});

describe("bad closes", () => {
  it.each([sma, ema, rsi, cumulativeReturn, stdDevReturn, maxDrawdown])(
    "%o rejects zero, negative, NaN and infinite closes instead of dividing by them",
    (fn) => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => fn([1, bad, 2], 2)).toThrow(RangeError);
      }
    },
  );

  it("computeIndicator rejects a bad price from the provider", () => {
    const nanProvider = { getCloses: () => [Number.NaN] };
    const price: Indicator = { type: "indicator", name: "price", symbol: "SOL" };
    expect(() => computeIndicator(price, nanProvider, new Date())).toThrow(
      "closes must be positive finite numbers, got NaN at index 0",
    );
  });

  it("lookbackFor rejects an unknown indicator", () => {
    expect(() => lookbackFor("macd" as Indicator["name"], 2)).toThrow('unknown indicator: "macd"');
  });
});
