import { CandlePriceProvider, type OpenClose } from "@solana-symphony/data";
import type { Node, Strategy } from "@solana-symphony/dsl";
import { describe, expect, it } from "vitest";
import { isScheduledRebalance, runBacktest } from "./engine.js";

const strategy = (root: Node, extra: Partial<Strategy> = {}): Strategy => ({
  id: "t",
  name: "Test",
  description: "",
  version: 1,
  rebalance: "daily",
  root,
  ...extra,
});
const sol: Node = { type: "asset", symbol: "SOL" };
const usdc: Node = { type: "asset", symbol: "USDC" };
const fiftyFifty: Node = { type: "weight", mode: "equal", children: [sol, usdc] };
const candles = (rows: Array<[string, number, number]>): OpenClose[] =>
  rows.map(([date, open, close]) => ({ date, open, close }));
const values = (r: { equityCurve: Array<{ value: number }> }) => r.equityCurve.map((p) => p.value);

describe("runBacktest", () => {
  it("buy and hold with fees and slippage", () => {
    // Day 1: buy SOL with all 1000 USDC at open 100.
    //   execution price = 100 * (1 + 0.002) = 100.2
    //   cash needed = units * 100.2 * (1 + 0.003)  ->  units = 1000 / (100.2 * 1.003) = 9.95018...
    //   notional = units * 100.2 = 1000 / 1.003 = 997.0090; fee = 0.3% of that = 2.99103
    //   slippage = units * 100 * 0.002 = 1.99004
    //   close 110 -> value = units * 110 = 1094.5208
    // Day 2: already 100% SOL, no trade; close 121 -> value = units * 121 = 1203.9729
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2024-01-01", 100, 110],
        ["2024-01-02", 110, 121],
      ]),
    });
    const r = runBacktest(strategy(sol), provider, {
      start: "2024-01-01",
      end: "2024-01-02",
      initialCapital: 1000,
    });

    const units = 1000 / (100.2 * 1.003);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ date: "2024-01-01", symbol: "SOL", side: "buy" });
    expect(r.trades[0]!.amount).toBeCloseTo(units, 10);
    expect(r.trades[0]!.price).toBeCloseTo(100.2, 10);
    expect(r.trades[0]!.fee).toBeCloseTo((1000 / 1.003) * 0.003, 10);
    expect(r.totalFees).toBeCloseTo(2.99103, 5);
    expect(r.totalSlippage).toBeCloseTo(units * 100 * 0.002, 10);
    expect(values(r)[0]).toBeCloseTo(units * 110, 8);
    expect(values(r)[1]).toBeCloseTo(units * 121, 8);
    expect(values(r)[1]).toBeCloseTo(1203.9729, 4);
  });

  it("50/50 daily rebalance without costs", () => {
    // Day 1 (open 100): V = 1000 -> buy 500 USDC of SOL = 5 SOL, keep 500 USDC.
    //   close 200: 5 * 200 + 500 = 1500, weights SOL 2/3, USDC 1/3
    // Day 2 (open 200): V = 5 * 200 + 500 = 1500, target 750 each
    //   sell (1000 - 750) / 200 = 1.25 SOL -> 3.75 SOL, 750 USDC
    //   close 100: 3.75 * 100 + 750 = 1125
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2024-01-01", 100, 200],
        ["2024-01-02", 200, 100],
      ]),
    });
    const r = runBacktest(strategy(fiftyFifty), provider, {
      start: "2024-01-01",
      end: "2024-01-02",
      initialCapital: 1000,
      feeBps: 0,
      slippageBps: 0,
    });

    expect(r.trades).toEqual([
      { date: "2024-01-01", symbol: "SOL", side: "buy", amount: 5, price: 100, fee: 0 },
      { date: "2024-01-02", symbol: "SOL", side: "sell", amount: 1.25, price: 200, fee: 0 },
    ]);
    expect(values(r)).toEqual([1500, 1125]);
    expect(r.holdings[0]!.weights.SOL).toBeCloseTo(2 / 3, 12);
    expect(r.holdings[1]!.weights).toEqual({ USDC: 750 / 1125, SOL: 375 / 1125 });
    expect(r.totalFees).toBe(0);
    expect(r.totalSlippage).toBe(0);
  });

  it("50/50 daily rebalance with a 1% fee on buys and sells", () => {
    // Day 1 (open 100): keep 500 USDC; buying 500 of SOL would cost 500 * 1.01 = 505 > 500,
    //   so buys scale down: u1 = 500 / (1.01 * 100) = 4.9504950 SOL
    //   fee1 = 4.9504950 * 100 * 1% = 4.9504950; cash = 1000 - 495.0495 - 4.9505 = 500
    //   close 200: V1 = 4.9504950 * 200 + 500 = 1490.0990099
    // Day 2 (open 200): V = 1490.0990099, target 745.0495050 each
    //   sell value = 990.0990099 - 745.0495050 = 245.0495050 (1.2252475 SOL)
    //   fee2 = 2.4504950; cash = 500 + 245.0495050 - 2.4504950 = 742.5990099
    //   SOL left = 3.7252475; close 100: 372.5247525 + 742.5990099 = 1115.1237624
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2024-01-01", 100, 200],
        ["2024-01-02", 200, 100],
      ]),
    });
    const r = runBacktest(strategy(fiftyFifty), provider, {
      start: "2024-01-01",
      end: "2024-01-02",
      initialCapital: 1000,
      feeBps: 100,
      slippageBps: 0,
    });

    const u1 = 500 / (1.01 * 100);
    expect(r.trades[0]!.amount).toBeCloseTo(u1, 10);
    expect(r.trades[0]!.fee).toBeCloseTo(u1, 10);
    expect(values(r)[0]).toBeCloseTo(1490.0990099, 6);
    expect(r.trades[1]).toMatchObject({ side: "sell", price: 200 });
    expect(r.trades[1]!.amount).toBeCloseTo(1.2252475, 6);
    expect(r.trades[1]!.fee).toBeCloseTo(2.450495, 6);
    expect(values(r)[1]).toBeCloseTo(1115.1237624, 6);
    expect(r.totalFees).toBeCloseTo(7.4009901, 6);
  });

  it("decides with the previous day's close and trades at today's open (no look-ahead)", () => {
    // Rule: hold SOL if its price > 100. On 2024-01-01 the latest close is 2023-12-31's 90,
    // so it stays in USDC even though 2024-01-01 opens at 150. It switches on 2024-01-02.
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2023-12-31", 90, 90],
        ["2024-01-01", 150, 150],
        ["2024-01-02", 150, 150],
      ]),
    });
    const priceAbove100: Node = {
      type: "if",
      condition: {
        lhs: { type: "indicator", name: "price", symbol: "SOL" },
        op: ">",
        rhs: { type: "number", value: 100 },
      },
      then: sol,
      else: usdc,
    };
    const r = runBacktest(strategy(priceAbove100), provider, {
      start: "2024-01-01",
      end: "2024-01-02",
      initialCapital: 1000,
      feeBps: 0,
      slippageBps: 0,
    });
    expect(r.rebalances.map((x) => [x.date, x.target])).toEqual([
      ["2024-01-01", { USDC: 1 }],
      ["2024-01-02", { SOL: 1 }],
    ]);
    expect(r.trades).toEqual([
      { date: "2024-01-02", symbol: "SOL", side: "buy", amount: 1000 / 150, price: 150, fee: 0 },
    ]);
  });

  it("rebalances weekly on Mondays only", () => {
    // 2024-01-01 is a Monday. SOL alternates 100/120 so every rebalance trades.
    const days = Array.from({ length: 15 }, (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);
    const provider = new CandlePriceProvider({
      SOL: days.map((date, i) => ({ date, open: i % 2 ? 120 : 100, close: i % 2 ? 100 : 120 })),
    });
    const r = runBacktest(strategy(fiftyFifty, { rebalance: "weekly" }), provider, {
      start: "2024-01-01",
      end: "2024-01-15",
      initialCapital: 1000,
    });
    expect(r.rebalances.map((x) => [x.date, x.reason])).toEqual([
      ["2024-01-01", "initial"],
      ["2024-01-08", "scheduled"],
      ["2024-01-15", "scheduled"],
    ]);
    expect(new Set(r.trades.map((t) => t.date))).toEqual(
      new Set(["2024-01-01", "2024-01-08", "2024-01-15"]),
    );
    expect(r.equityCurve).toHaveLength(15);
  });

  it("rebalances early when weights drift past the threshold", () => {
    // 50/50 on day 1; SOL doubles by the close -> SOL weight 2/3, 16.7 points off target.
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2024-01-01", 100, 200],
        ["2024-01-02", 200, 200],
        ["2024-01-03", 200, 200],
      ]),
    });
    const run = (driftThresholdPct: number) =>
      runBacktest(strategy(fiftyFifty, { rebalance: "monthly", driftThresholdPct }), provider, {
        start: "2024-01-01",
        end: "2024-01-03",
        initialCapital: 1000,
        feeBps: 0,
        slippageBps: 0,
      }).rebalances.map((x) => [x.date, x.reason]);

    expect(run(10)).toEqual([
      ["2024-01-01", "initial"],
      ["2024-01-02", "drift"],
    ]);
    expect(run(20)).toEqual([["2024-01-01", "initial"]]);
  });

  it("postpones a rebalance when an open is missing and carries the last close forward", () => {
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2024-01-01", 100, 100],
        ["2024-01-03", 100, 100],
      ]),
    });
    const r = runBacktest(strategy(fiftyFifty), provider, {
      start: "2024-01-01",
      end: "2024-01-03",
      initialCapital: 1000,
      feeBps: 0,
      slippageBps: 0,
    });
    expect(r.rebalances.map((x) => x.date)).toEqual(["2024-01-01", "2024-01-03"]);
    expect(r.warnings).toEqual([
      "2024-01-02: scheduled rebalance postponed, no open price for SOL",
    ]);
    expect(values(r)).toEqual([1000, 1000, 1000]);
  });

  it("keeps cash flat with no trades for an all-USDC strategy", () => {
    const r = runBacktest(strategy(usdc), new CandlePriceProvider({}), {
      start: "2024-02-27",
      end: "2024-03-01",
      initialCapital: 500,
    });
    expect(r.equityCurve).toEqual([
      { date: "2024-02-27", value: 500 },
      { date: "2024-02-28", value: 500 },
      { date: "2024-02-29", value: 500 },
      { date: "2024-03-01", value: 500 },
    ]);
    expect(r.trades).toEqual([]);
    expect(r.holdings.every((h) => h.weights.USDC === 1)).toBe(true);
  });

  it("rejects bad options", () => {
    const provider = new CandlePriceProvider({});
    const base = { start: "2024-01-01", end: "2024-01-02", initialCapital: 1000 };
    expect(() => runBacktest(strategy(usdc), provider, { ...base, start: "2024-02-30" })).toThrow(
      'start must be a YYYY-MM-DD date, got "2024-02-30"',
    );
    expect(() => runBacktest(strategy(usdc), provider, { ...base, end: "2023-12-31" })).toThrow(
      "start 2024-01-01 is after end 2023-12-31",
    );
    expect(() => runBacktest(strategy(usdc), provider, { ...base, initialCapital: 0 })).toThrow(
      "initialCapital must be a positive number",
    );
    expect(() => runBacktest(strategy(usdc), provider, { ...base, feeBps: -1 })).toThrow(
      "feeBps must be between 0 and 10000",
    );
  });
});

describe("fallbacks for tokens without enough history", () => {
  it("records each rebalance where a branch fell back to USDC, and stops once data exists", () => {
    // JUP lists on 2024-01-03. A filter needing JUP's 1-day return can only rank it once
    // two JUP closes are visible: from 2024-01-05 (closes of 01-03 and 01-04).
    const provider = new CandlePriceProvider({
      SOL: candles([
        ["2023-12-30", 100, 100],
        ["2023-12-31", 100, 100],
        ["2024-01-01", 100, 100],
        ["2024-01-02", 100, 100],
        ["2024-01-03", 100, 100],
        ["2024-01-04", 100, 100],
        ["2024-01-05", 100, 100],
      ]),
      JUP: candles([
        ["2024-01-03", 1, 1],
        ["2024-01-04", 1, 2],
        ["2024-01-05", 2, 2],
      ]),
    });
    const momentum: Node = {
      type: "filter",
      sortBy: { type: "indicator", name: "cumulativeReturn", symbol: "", window: 1 },
      order: "top",
      select: 1,
      children: [sol, { type: "asset", symbol: "JUP" }],
    };
    const r = runBacktest(strategy(momentum), provider, {
      start: "2024-01-01",
      end: "2024-01-05",
      initialCapital: 1000,
    });
    expect(r.rebalances.map((x) => [x.date, x.fallbacks.length])).toEqual([
      ["2024-01-01", 1],
      ["2024-01-02", 1],
      ["2024-01-03", 1],
      ["2024-01-04", 1],
      ["2024-01-05", 0],
    ]);
    expect(r.rebalances[0]!.fallbacks).toEqual([
      "root: JUP 1d return: not enough price data → 100% USDC",
    ]);
    expect(r.rebalances[4]!.target).toEqual({ JUP: 1 });
  });
});

describe("isScheduledRebalance", () => {
  it("follows the UTC calendar", () => {
    expect(isScheduledRebalance("2024-01-03", "daily")).toBe(true);
    expect(isScheduledRebalance("2024-01-08", "weekly")).toBe(true); // Monday
    expect(isScheduledRebalance("2024-01-09", "weekly")).toBe(false);
    expect(isScheduledRebalance("2024-02-01", "monthly")).toBe(true);
    expect(isScheduledRebalance("2024-02-02", "monthly")).toBe(false);
    expect(isScheduledRebalance("2024-04-01", "quarterly")).toBe(true);
    expect(isScheduledRebalance("2024-05-01", "quarterly")).toBe(false);
  });
});
