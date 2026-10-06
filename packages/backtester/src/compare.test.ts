import { CandlePriceProvider } from "@solana-symphony/data";
import { InvalidStrategyError, type Strategy } from "@solana-symphony/dsl";
import { describe, expect, it } from "vitest";
import { runBenchmark, type LabeledResult } from "./benchmark.js";
import { compare, correlation, formatComparison } from "./compare.js";
import { runBacktest, type BacktestResult } from "./engine.js";

const days = ["2024-01-01", "2024-01-02", "2024-01-03"];
// SOL opens and closes: day 1 open 100 close 110, day 2 110 -> 99, day 3 99 -> 108.9
const provider = new CandlePriceProvider({
  SOL: [
    { date: "2024-01-01", open: 100, close: 110 },
    { date: "2024-01-02", open: 110, close: 99 },
    { date: "2024-01-03", open: 99, close: 108.9 },
  ],
});
const options = { start: "2024-01-01", end: "2024-01-03", initialCapital: 1000 };

/** A result with a given equity curve and nothing else, for comparison tests. */
function fakeResult(label: string, values: number[], initialCapital = 100): LabeledResult {
  const result: BacktestResult = {
    initialCapital,
    equityCurve: values.map((value, i) => ({ date: days[i]!, value })),
    holdings: [],
    trades: [],
    totalFees: 0,
    totalSlippage: 0,
    rebalances: [],
    warnings: [],
  };
  return { label, result };
}

describe("runBenchmark", () => {
  it("buy-hold:SOL buys once, paying the same costs as a strategy", () => {
    // units = 1000 / (100 * 1.002 * 1.003); final = units * 108.9
    const { label, result } = runBenchmark("buy-hold:SOL", provider, options);
    expect(label).toBe("Buy & hold SOL");
    expect(result.trades).toHaveLength(1);
    expect(result.equityCurve.at(-1)!.value).toBeCloseTo((1000 / (100.2 * 1.003)) * 108.9, 9);
  });

  it("buy-hold:USDC stays in cash", () => {
    const { label, result } = runBenchmark("buy-hold:USDC", provider, options);
    expect(label).toBe("Buy & hold USDC");
    expect(result.trades).toEqual([]);
    expect(result.equityCurve.map((p) => p.value)).toEqual([1000, 1000, 1000]);
  });

  it("runs a strategy benchmark exactly like runBacktest, labelled by its name", () => {
    const strategy: Strategy = {
      id: "half",
      name: "Half SOL",
      description: "",
      version: 1,
      rebalance: "daily",
      root: {
        type: "weight",
        mode: "equal",
        children: [
          { type: "asset", symbol: "SOL" },
          { type: "asset", symbol: "USDC" },
        ],
      },
    };
    expect(runBenchmark(strategy, provider, options)).toEqual({
      label: "Half SOL",
      result: runBacktest(strategy, provider, options),
    });
  });

  it("rejects malformed benchmarks and unsupported tokens", () => {
    expect(() => runBenchmark("hold:SOL" as `buy-hold:${string}`, provider, options)).toThrow(
      'unknown benchmark "hold:SOL"',
    );
    expect(() => runBenchmark("buy-hold:DOGE", provider, options)).toThrow(InvalidStrategyError);
  });
});

describe("correlation", () => {
  it("is 1 for proportional series and -1 for opposite ones", () => {
    expect(correlation([0.1, -0.1, 0.2], [0.2, -0.2, 0.4])).toBeCloseTo(1, 12);
    expect(correlation([0.1, -0.1, 0.2], [-0.1, 0.1, -0.2])).toBeCloseTo(-1, 12);
  });

  it("matches a hand-calculated value", () => {
    // x = 0.1, 0, -0.1 (mean 0); y = 0.1, 0.1, -0.2 (mean 0)
    // sum(xy) = 0.01 + 0 + 0.02 = 0.03; sum(x²) = 0.02; sum(y²) = 0.06
    // r = 0.03 / sqrt(0.02 * 0.06) = 0.03 / 0.034641 = 0.866025 (= √3 / 2)
    expect(correlation([0.1, 0, -0.1], [0.1, 0.1, -0.2])).toBeCloseTo(Math.sqrt(3) / 2, 12);
  });

  it("is null when either series is flat or too short", () => {
    expect(correlation([0.1, 0.2], [0, 0])).toBeNull();
    expect(correlation([0.1], [0.1])).toBeNull();
  });
});

describe("compare", () => {
  it("correlates each benchmark's daily returns with the strategy", () => {
    // strategy from 100: 110, 99, 108.9 -> returns +10%, -10%, +10%
    // double:   100: 120, 96, 115.2 -> +20%, -20%, +20%  -> correlation 1
    // inverse:  100: 90, 99, 89.1   -> -10%, +10%, -10%  -> correlation -1
    // cash:     flat                                     -> null
    const comparison = compare([
      fakeResult("Strategy", [110, 99, 108.9]),
      fakeResult("Double", [120, 96, 115.2]),
      fakeResult("Inverse", [90, 99, 89.1]),
      fakeResult("Cash", [100, 100, 100]),
    ]);
    expect(comparison.labels).toEqual(["Strategy", "Double", "Inverse", "Cash"]);
    const corr = comparison.results.map((r) => r.correlation);
    expect(corr[0]).toBeNull();
    expect(corr[1]).toBeCloseTo(1, 12);
    expect(corr[2]).toBeCloseTo(-1, 12);
    expect(corr[3]).toBeNull();
  });

  it("uses only the dates both results cover", () => {
    const partial = fakeResult("Partial", [120, 96]);
    const comparison = compare([fakeResult("Strategy", [110, 99, 108.9]), partial]);
    // shared dates: day 1 (+10% vs +20%) and day 2 (-10% vs -20%) -> correlation 1
    expect(comparison.results[1]!.correlation).toBeCloseTo(1, 12);
  });

  it("includes the first day's return from the initial capital", () => {
    const [strategy] = compare([fakeResult("Strategy", [110, 99, 108.9])]).results;
    expect(strategy!.metrics.totalReturn).toBeCloseTo(0.089, 12); // 108.9 / 100 - 1
    expect(strategy!.metrics.startDate).toBe("2023-12-31");
  });

  it("formats a side-by-side table", () => {
    const comparison = compare([
      runBenchmark(
        {
          id: "half",
          name: "Half SOL",
          description: "",
          version: 1,
          rebalance: "daily",
          root: {
            type: "weight",
            mode: "equal",
            children: [
              { type: "asset", symbol: "SOL" },
              { type: "asset", symbol: "USDC" },
            ],
          },
        },
        provider,
        options,
      ),
      runBenchmark("buy-hold:SOL", provider, options),
      runBenchmark("buy-hold:USDC", provider, options),
    ]);
    expect(formatComparison(comparison)).toMatchInlineSnapshot(`
      "                                        Half SOL           Buy & hold SOL  Buy & hold USDC
      -----------------------  -----------------------  -----------------------  ---------------
      Final value                             1,044.38                 1,083.58         1,000.00
      Total return                               +4.4%                    +8.4%             0.0%
      CAGR                                   +19588.6%              +1742532.2%             0.0%
      Volatility (ann.)                         108.9%                   217.6%             0.0%
      Sharpe                                      5.25                     5.28                -
      Sortino                                    10.35                    10.43                -
      Max drawdown                               -5.0%                   -10.0%             0.0%
      Drawdown peak → trough   2024-01-01 → 2024-01-02  2024-01-01 → 2024-01-02                -
      Calmar                                   3908.91                174253.22                -
      Best day                                   +5.0%                   +10.0%             0.0%
      Worst day                                  -5.0%                   -10.0%             0.0%
      Positive days                              66.7%                    66.7%             0.0%
      Trailing 1m                                    -                        -                -
      Trailing 3m                                    -                        -                -
      Turnover (ann.)                           65.28x                  116.55x            0.00x
      Fees                                        1.64                     2.99             0.00
      Slippage                                    1.09                     1.99             0.00
      Correlation vs strategy                        -                     1.00                -"
    `);
  });

  it("rejects an empty list", () => {
    expect(() => compare([])).toThrow("nothing to compare");
  });
});
