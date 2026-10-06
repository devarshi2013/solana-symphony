import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheFile, writeCache, type Candle } from "@solana-symphony/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, strategySymbols } from "./command.js";

let dir: string;
let cacheDir: string;
let logs: string[];
let errors: string[];
let opened: string[];

const strategy = {
  id: "sol-trend",
  name: "SOL trend",
  description: "",
  version: 1,
  rebalance: "daily",
  root: {
    type: "if",
    condition: {
      lhs: { type: "indicator", name: "price", symbol: "SOL" },
      op: ">",
      rhs: { type: "indicator", name: "sma", symbol: "SOL", window: 5 },
    },
    then: { type: "asset", symbol: "SOL" },
    else: { type: "asset", symbol: "USDC" },
  },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "backtest-cli-"));
  cacheDir = join(dir, "cache");
  logs = [];
  errors = [];
  opened = [];
  // 60 days of SOL: up for 30 days, then down
  const candles: Candle[] = Array.from({ length: 60 }, (_, i) => {
    const close = i < 30 ? 100 + i * 2 : 160 - (i - 30) * 3;
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    return { date, open: close, high: close, low: close, close, volume: null };
  });
  await writeCache(cacheFile(cacheDir, "SOL"), candles);
  writeFileSync(join(dir, "strategy.json"), JSON.stringify(strategy));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[]) =>
  main(args, {
    cwd: dir,
    cacheDir,
    outRoot: dir,
    now: () => new Date("2024-03-01T12:00:00Z"),
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    open: (p) => (opened.push(p), true),
  });

describe("backtest command", () => {
  it("prints the comparison, writes results.json and report.html, and opens the report", async () => {
    const code = await run([
      "strategy.json",
      "--start",
      "2024-01-10",
      "--end",
      "2024-02-28",
      "--capital",
      "5000",
      "--benchmark",
      "SOL,USDC",
    ]);
    expect(errors).toEqual([]);
    expect(code).toBe(0);

    const out = logs.join("\n");
    expect(out).toContain("SOL trend: 2024-01-10 to 2024-02-28, 5000 USDC");
    expect(out).toMatch(/SOL trend\s+Buy & hold SOL\s+Buy & hold USDC/);
    expect(out).toContain("Sharpe");

    const resultsPath = join(dir, "out", "sol-trend", "results.json");
    const reportPath = join(dir, "out", "sol-trend", "report.html");
    const results = JSON.parse(readFileSync(resultsPath, "utf8"));
    expect(results.settings).toEqual({
      start: "2024-01-10",
      end: "2024-02-28",
      capital: 5000,
      feeBps: 30,
      slippageBps: 20,
      benchmarks: ["SOL", "USDC"],
    });
    expect(results.backtests.map((b: { label: string }) => b.label)).toEqual([
      "SOL trend",
      "Buy & hold SOL",
      "Buy & hold USDC",
    ]);
    expect(results.backtests[0].result.equityCurve).toHaveLength(50);
    expect(readFileSync(reportPath, "utf8")).toContain("<title>SOL trend · backtest</title>");
    expect(opened).toEqual([reportPath]);
  });

  it("defaults end to yesterday and skips opening with --no-open", async () => {
    expect(await run(["strategy.json", "--start", "2024-01-10", "--no-open"])).toBe(0);
    const results = JSON.parse(readFileSync(join(dir, "out", "sol-trend", "results.json"), "utf8"));
    expect(results.settings.end).toBe("2024-02-29");
    expect(opened).toEqual([]);
  });

  it("explains invalid strategies, bad options and missing data", async () => {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...strategy, rebalance: "hourly" }));
    expect(await run(["bad.json"])).toBe(1);
    expect(errors.at(-1)).toContain('rebalance: Invalid option: expected one of "daily"');

    expect(await run(["strategy.json", "--benchmark", "DOGE"])).toBe(1);
    expect(errors.at(-1)).toContain("Unknown benchmark token(s): DOGE");

    expect(await run(["strategy.json", "--capital", "0"])).toBe(1);
    expect(errors.at(-1)).toBe("--capital must be a positive number");

    expect(await run([])).toBe(1);
    expect(errors.at(-1)).toContain("Expected one strategy file.");

    rmSync(cacheDir, { recursive: true });
    expect(await run(["strategy.json"])).toBe(1);
    expect(errors.at(-1)).toContain("No cached prices");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("warns about late-listed tokens and rebalances that fell back to USDC", async () => {
    // JUP only has prices from 2024-02-01; a momentum filter over SOL and JUP cannot rank
    // until JUP has 6 closes for a 5-day return.
    const jup: Candle[] = Array.from({ length: 29 }, (_, i) => {
      const date = new Date(Date.UTC(2024, 1, 1 + i)).toISOString().slice(0, 10);
      return { date, open: 1 + i / 10, high: 1, low: 1, close: 1 + i / 10, volume: null };
    });
    await writeCache(cacheFile(cacheDir, "JUP"), jup);
    writeFileSync(
      join(dir, "momentum.json"),
      JSON.stringify({
        ...strategy,
        id: "momentum",
        name: "Momentum",
        root: {
          type: "filter",
          sortBy: { type: "indicator", name: "cumulativeReturn", symbol: "", window: 5 },
          order: "top",
          select: 1,
          children: [
            { type: "asset", symbol: "SOL" },
            { type: "asset", symbol: "JUP" },
          ],
        },
      }),
    );

    expect(await run(["momentum.json", "--start", "2024-01-10", "--end", "2024-02-20"])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Data: JUP, first price 2024-02-01 (after --start)");
    // JUP's 6th close (2024-02-06) is visible from 2024-02-07
    expect(out).toContain(
      "Momentum: 28 of 42 rebalances fell back to USDC for missing price history " +
        "(first 2024-01-10: root: JUP 5d return: not enough price data → 100% USDC). " +
        "Runs as written from 2024-02-07; consider --start 2024-02-07.",
    );
  });

  it("prints help", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(logs[0]).toContain("Usage: pnpm backtest <strategy.json>");
  });
});

describe("strategySymbols", () => {
  it("lists traded and read tokens, ignoring filter sortBy symbols", () => {
    expect(
      strategySymbols({
        type: "filter",
        sortBy: { type: "indicator", name: "rsi", symbol: "BONK", window: 14 },
        order: "top",
        select: 1,
        children: [
          { type: "asset", symbol: "JUP" },
          {
            type: "if",
            condition: {
              lhs: { type: "indicator", name: "price", symbol: "SOL" },
              op: ">",
              rhs: { type: "number", value: 1 },
            },
            then: { type: "group", name: "g", child: { type: "asset", symbol: "JTO" } },
            else: { type: "asset", symbol: "USDC" },
          },
        ],
      }),
    ).toEqual(["JUP", "SOL", "JTO", "USDC"]);
  });
});
