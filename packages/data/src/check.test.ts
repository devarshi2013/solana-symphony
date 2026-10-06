import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFile, writeCache } from "./cache.js";
import type { Candle } from "./candle.js";
import { analyzeCandles, checkData, formatReport } from "./check.js";

const c = (date: string, close: number, low = close): Candle => ({
  date,
  open: close,
  high: close,
  low,
  close,
  volume: 1,
});

describe("analyzeCandles", () => {
  it("reports a clean series as ok", () => {
    const report = analyzeCandles("SOL", [
      c("2024-01-01", 100),
      c("2024-01-02", 110),
      c("2024-01-03", 99),
    ]);
    expect(report).toMatchObject({
      status: "ok",
      candles: 3,
      firstDate: "2024-01-01",
      lastDate: "2024-01-03",
      missingDays: 0,
      duplicateDates: [],
      badPriceDates: [],
      bigMoves: [],
    });
  });

  it("counts missing days and groups them into ranges", () => {
    const report = analyzeCandles("SOL", [
      c("2024-01-01", 1),
      c("2024-01-05", 1), // 2..4 missing
      c("2024-01-06", 1),
      c("2024-01-08", 1), // 7 missing
    ]);
    expect(report.status).toBe("issues");
    expect(report.missingDays).toBe(4);
    expect(report.missingRanges).toEqual([
      { from: "2024-01-02", to: "2024-01-04", days: 3 },
      { from: "2024-01-07", to: "2024-01-07", days: 1 },
    ]);
  });

  it("finds duplicate days", () => {
    const report = analyzeCandles("SOL", [
      c("2024-01-01", 1),
      c("2024-01-02", 1),
      c("2024-01-02", 1),
    ]);
    expect(report.duplicateDates).toEqual(["2024-01-02"]);
    expect(report.candles).toBe(3);
  });

  it("finds zero or negative prices in any field", () => {
    const report = analyzeCandles("SOL", [
      c("2024-01-01", 1),
      c("2024-01-02", 1, 0),
      c("2024-01-03", -1),
    ]);
    expect(report.badPriceDates).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it("flags close-to-close moves over 80% in either direction", () => {
    // 100 -> 181 (+81%), 181 -> 30 (-83.4%), 30 -> 53.7 (+79%, not flagged)
    const report = analyzeCandles("BONK", [
      c("2024-01-01", 100),
      c("2024-01-02", 181),
      c("2024-01-03", 30),
      c("2024-01-04", 53.7),
    ]);
    expect(report.bigMoves.map((m) => [m.date, Math.round(m.changePct * 10) / 10])).toEqual([
      ["2024-01-02", 81],
      ["2024-01-03", -83.4],
    ]);
  });

  it("checks moves in date order even if the file is not sorted", () => {
    const report = analyzeCandles("SOL", [c("2024-01-02", 300), c("2024-01-01", 100)]);
    expect(report.bigMoves).toEqual([
      { date: "2024-01-02", previousDate: "2024-01-01", changePct: 200 },
    ]);
  });

  it("reports an empty series as no data", () => {
    expect(analyzeCandles("WIF", []).status).toBe("no data");
  });
});

describe("checkData", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks each symbol's file, reporting missing and unreadable ones", async () => {
    await writeCache(cacheFile(dir, "SOL"), [c("2024-01-01", 1), c("2024-01-02", 1)]);
    writeFileSync(cacheFile(dir, "JUP"), "not json");

    const reports = await checkData({ cacheDir: dir, symbols: ["SOL", "JUP", "WIF"] });
    expect(reports.map((r) => [r.symbol, r.status])).toEqual([
      ["SOL", "ok"],
      ["JUP", "error"],
      ["WIF", "no data"],
    ]);
    expect(reports[1]!.error).toContain("is not a valid candle cache");
  });
});

describe("formatReport", () => {
  it("prints a table followed by details of each issue", () => {
    const text = formatReport([
      analyzeCandles("SOL", [c("2024-01-01", 100), c("2024-01-02", 100)]),
      analyzeCandles("BONK", [
        c("2024-01-01", 1),
        c("2024-01-03", 2),
        c("2024-01-03", 2),
        c("2024-01-04", -1),
      ]),
      analyzeCandles("WIF", []),
    ]);
    expect(text).toBe(
      [
        "Symbol  First       Last        Candles  Missing  Dupes  Bad price  Moves>80%  Status",
        "------  ----------  ----------  -------  -------  -----  ---------  ---------  -------",
        "SOL     2024-01-01  2024-01-02  2        0        0      0          0          OK",
        "BONK    2024-01-01  2024-01-04  4        1        1      1          1          ISSUES",
        "WIF     -           -           0        0        0      0          0          NO DATA",
        "",
        "BONK:",
        "  missing 2024-01-02 (1 day)",
        "  duplicate dates: 2024-01-03",
        "  zero/negative prices: 2024-01-04",
        "  +100.0% close move 2024-01-01 -> 2024-01-03",
      ].join("\n"),
    );
  });
});
