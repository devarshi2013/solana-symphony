import { CandlePriceProvider } from "@solana-symphony/data";
import { describe as describeStrategy, type Strategy } from "@solana-symphony/dsl";
import { describe, expect, it } from "vitest";
import { runBenchmark } from "./benchmark.js";
import { compare } from "./compare.js";
import { CHART_JS_INTEGRITY, CHART_JS_URL, drawdownSeries, renderReport } from "./report.js";

describe("drawdownSeries", () => {
  it("measures each value against the running peak, starting from initial capital", () => {
    // peak 100 -> 110 (0%), 99 is 10% below 110, 121 sets a new peak, 108.9 is 10% below
    expect(
      drawdownSeries(
        [110, 99, 121, 108.9].map((value) => ({ value })),
        100,
      ).map((d) => Number(d.toFixed(12))),
    ).toEqual([0, -0.1, 0, -0.1]);
  });

  it("counts a fall from the initial capital on day one", () => {
    expect(drawdownSeries([{ value: 90 }], 100)[0]).toBeCloseTo(-0.1, 12);
  });
});

describe("renderReport", () => {
  const strategy: Strategy = {
    id: "half",
    name: 'Half SOL </script><script>alert("x")</script>',
    description: "50/50 & daily",
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
  const provider = new CandlePriceProvider({
    SOL: [
      { date: "2024-01-01", open: 100, close: 110 },
      { date: "2024-01-02", open: 110, close: 99 },
    ],
  });
  const options = { start: "2024-01-01", end: "2024-01-02", initialCapital: 1000 };
  const results = [
    runBenchmark(strategy, provider, options),
    runBenchmark("buy-hold:SOL", provider, options),
  ];
  const html = renderReport({
    strategy,
    description: describeStrategy(strategy),
    results,
    comparison: compare(results),
    settings: {
      start: "2024-01-01",
      end: "2024-01-02",
      capital: 1000,
      feeBps: 30,
      slippageBps: 20,
    },
    generatedAt: "2024-01-03T00:00:00.000Z",
  });

  it("is a standalone page loading pinned Chart.js with an integrity hash", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<script src="${CHART_JS_URL}" integrity="${CHART_JS_INTEGRITY}"`);
    for (const id of ["equity", "drawdown", "allocation"]) {
      expect(html).toContain(`<canvas id="${id}"`);
    }
  });

  it("escapes strategy text so it cannot inject markup or scripts", () => {
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("Half SOL &lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)");
    expect(html).toContain("50/50 &amp; daily");
  });

  it("embeds the chart data as parseable JSON", () => {
    const json = /<script id="report-data" type="application\/json">(.*?)<\/script>/s.exec(
      html,
    )![1]!;
    const data = JSON.parse(json);
    expect(data.dates).toEqual(["2024-01-01", "2024-01-02"]);
    expect(data.series.map((s: { label: string }) => s.label)).toEqual([
      strategy.name,
      "Buy & hold SOL",
    ]);
    // tokens are listed in registry order, each with its fixed color slot
    expect(
      data.allocation.map((a: { symbol: string; slot: number }) => [a.symbol, a.slot]),
    ).toEqual([
      ["SOL", 1],
      ["USDC", 2],
    ]);
  });

  it("includes the metrics table and the plain-English strategy", () => {
    expect(html).toContain("<th>Sharpe</th>");
    expect(html).toContain("Split equally between:");
  });
});
