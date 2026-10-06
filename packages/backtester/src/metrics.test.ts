import { describe, expect, it } from "vitest";
import type { Trade } from "./engine.js";
import { computeMetrics, computeTurnover, type EquityPoint } from "./metrics.js";

const curve = (start: string, values: number[]): EquityPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const SQRT365 = Math.sqrt(365); // 19.104973...

describe("computeMetrics", () => {
  // 100 -> 110 -> 99 -> 108.9 -> 130.68 on 2024-01-01..05
  // daily returns: +0.10, -0.10, +0.10, +0.20
  const metrics = computeMetrics(curve("2024-01-01", [100, 110, 99, 108.9, 130.68]));

  it("total return and CAGR", () => {
    // total = 130.68 / 100 - 1 = 0.3068 over 4 days = 4/365 years
    expect(metrics.totalReturn).toBeCloseTo(0.3068, 12);
    expect(metrics.days).toBe(4);
    // CAGR = 1.3068^(365/4) - 1
    expect(metrics.cagr).toBeCloseTo(1.3068 ** (365 / 4) - 1, 6);
  });

  it("annualised volatility from the sample standard deviation", () => {
    // mean = (0.1 - 0.1 + 0.1 + 0.2) / 4 = 0.075
    // deviations 0.025, -0.175, 0.025, 0.125 -> squares sum
    //   0.000625 + 0.030625 + 0.000625 + 0.015625 = 0.0475
    // sample variance = 0.0475 / 3 = 0.0158333; sd = 0.1258306
    // annualised = 0.1258306 * sqrt(365) = 2.40398
    const sd = Math.sqrt(0.0475 / 3);
    expect(metrics.annualizedVolatility).toBeCloseTo(sd * SQRT365, 10);
    expect(metrics.annualizedVolatility).toBeCloseTo(2.40398, 4);
  });

  it("Sharpe and Sortino with a zero risk-free rate", () => {
    // Sharpe = 0.075 / 0.1258306 * sqrt(365) = 0.596040 * 19.104973 = 11.3873
    expect(metrics.sharpe).toBeCloseTo((0.075 / Math.sqrt(0.0475 / 3)) * SQRT365, 10);
    expect(metrics.sharpe).toBeCloseTo(11.3873, 3);
    // downside: only -0.10 counts -> sqrt(0.01 / 4) = 0.05
    // Sortino = 0.075 / 0.05 * sqrt(365) = 1.5 * 19.104973 = 28.6575
    expect(metrics.sortino).toBeCloseTo(1.5 * SQRT365, 10);
  });

  it("max drawdown with peak, trough and recovery dates, and Calmar", () => {
    // peak 110 on 01-02, trough 99 on 01-03 -> 1 - 99/110 = 0.10; back above 110 on 01-05
    expect(metrics.maxDrawdown.depth).toBeCloseTo(0.1, 12);
    expect(metrics.maxDrawdown).toMatchObject({
      peakDate: "2024-01-02",
      troughDate: "2024-01-03",
      recoveryDate: "2024-01-05",
    });
    // a 4-day CAGR is huge (~4e10), so compare relatively
    expect(metrics.calmar! / (metrics.cagr! / 0.1)).toBeCloseTo(1, 12);
  });

  it("best and worst day and share of positive days", () => {
    expect(metrics.bestDay!.date).toBe("2024-01-05");
    expect(metrics.bestDay!.return).toBeCloseTo(0.2, 12);
    expect(metrics.worstDay!.date).toBe("2024-01-03");
    expect(metrics.worstDay!.return).toBeCloseTo(-0.1, 12);
    expect(metrics.positiveDays).toBe(0.75); // 3 of 4
  });

  it("leaves trailing returns null when the curve is too short", () => {
    expect(metrics.trailing1m).toBeNull();
    expect(metrics.trailing3m).toBeNull();
  });

  it("subtracts a daily risk-free rate for Sharpe and Sortino", () => {
    // 10% a year -> daily rate = 1.1^(1/365) - 1 = 0.000261158
    const rf = 1.1 ** (1 / 365) - 1;
    const m = computeMetrics(curve("2024-01-01", [100, 110, 99, 108.9, 130.68]), {
      riskFreeRate: 0.1,
    });
    expect(m.sharpe).toBeCloseTo(((0.075 - rf) / Math.sqrt(0.0475 / 3)) * SQRT365, 10);
    // excess returns: 0.1 - rf, -0.1 - rf, ...; only the -0.1 one is negative
    const downside = Math.sqrt((-0.1 - rf) ** 2 / 4);
    expect(m.sortino).toBeCloseTo(((0.075 - rf) / downside) * SQRT365, 10);
  });

  it("counts the first day's return from an initial value", () => {
    // 100 (initial, 2023-12-31) -> 110 -> 121: two +10% days
    const m = computeMetrics(curve("2024-01-01", [110, 121]), { initialValue: 100 });
    expect(m.startDate).toBe("2023-12-31");
    expect(m.days).toBe(2);
    expect(m.totalReturn).toBeCloseTo(0.21, 12);
    expect(m.positiveDays).toBe(1);
    expect(m.annualizedVolatility).toBeCloseTo(0, 12); // identical returns
  });

  it("trailing returns go back calendar months", () => {
    // value = 100 + i on 2024-01-01 + i days, i = 0..99 -> last point 2024-04-09 = 199
    // 1 month back = 2024-03-09 (i = 68, value 168): 199 / 168 - 1
    // 3 months back = 2024-01-09 (i = 8, value 108): 199 / 108 - 1
    const m = computeMetrics(
      curve(
        "2024-01-01",
        Array.from({ length: 100 }, (_, i) => 100 + i),
      ),
    );
    expect(m.endDate).toBe("2024-04-09");
    expect(m.trailing1m).toBeCloseTo(199 / 168 - 1, 12);
    expect(m.trailing3m).toBeCloseTo(199 / 108 - 1, 12);
  });

  it("clamps month-end dates for trailing returns", () => {
    // 2024-03-31 minus 1 month = 2024-02-29 (leap year), the 30th point from 2024-01-31
    const values = Array.from({ length: 61 }, (_, i) => 100 + i); // 2024-01-31 .. 2024-03-31
    const m = computeMetrics(curve("2024-01-31", values));
    expect(m.trailing1m).toBeCloseTo(160 / 129 - 1, 12); // 02-29 is i = 29
  });

  it("returns null ratios for a flat curve", () => {
    const m = computeMetrics(curve("2024-01-01", [100, 100, 100]));
    expect(m).toMatchObject({
      totalReturn: 0,
      cagr: 0,
      annualizedVolatility: 0,
      sharpe: null,
      sortino: null,
      calmar: null,
      positiveDays: 0,
      maxDrawdown: { depth: 0, peakDate: null, troughDate: null, recoveryDate: null },
    });
  });

  it("reports a drawdown that never recovers", () => {
    const m = computeMetrics(curve("2024-01-01", [100, 80, 90]));
    expect(m.maxDrawdown).toEqual({
      depth: 0.19999999999999996,
      peakDate: "2024-01-01",
      troughDate: "2024-01-02",
      recoveryDate: null,
    });
  });

  it("rejects bad curves", () => {
    expect(() => computeMetrics([])).toThrow("equity curve is empty");
    expect(() => computeMetrics(curve("2024-01-01", [100, 0]))).toThrow(
      "equity value on 2024-01-02 must be positive, got 0",
    );
    expect(() =>
      computeMetrics([
        { date: "2024-01-02", value: 1 },
        { date: "2024-01-01", value: 1 },
      ]),
    ).toThrow("equity curve dates must increase");
  });
});

describe("computeTurnover", () => {
  it("divides traded value by average portfolio value", () => {
    // trades from the 50/50 engine test: buy 5 @ 100 = 500, sell 1.25 @ 200 = 250 -> 750
    // curve 1500, 1125 -> average 1312.5; turnover = 750 / 1312.5 = 0.5714286
    // span 1 day -> annualised 0.5714286 * 365 = 208.571
    const trades: Trade[] = [
      { date: "2024-01-01", symbol: "SOL", side: "buy", amount: 5, price: 100, fee: 0 },
      { date: "2024-01-02", symbol: "SOL", side: "sell", amount: 1.25, price: 200, fee: 0 },
    ];
    const t = computeTurnover(trades, curve("2024-01-01", [1500, 1125]));
    expect(t.tradedValue).toBe(750);
    expect(t.turnover).toBeCloseTo(750 / 1312.5, 12);
    expect(t.annualizedTurnover).toBeCloseTo((750 / 1312.5) * 365, 9);
  });

  it("includes the initial value in the average when given", () => {
    // values 1000, 1500, 1125 -> average 1208.333; 750 / 1208.333 = 0.6206897; span 2 days
    const trades: Trade[] = [
      { date: "2024-01-01", symbol: "SOL", side: "buy", amount: 7.5, price: 100, fee: 0 },
    ];
    const t = computeTurnover(trades, curve("2024-01-01", [1500, 1125]), { initialValue: 1000 });
    expect(t.turnover).toBeCloseTo(750 / (3625 / 3), 12);
    expect(t.annualizedTurnover).toBeCloseTo((750 / (3625 / 3)) * (365 / 2), 9);
  });

  it("is zero with no trades, and null annualised for a single day", () => {
    expect(computeTurnover([], curve("2024-01-01", [100]))).toEqual({
      tradedValue: 0,
      turnover: 0,
      annualizedTurnover: null,
    });
  });
});
