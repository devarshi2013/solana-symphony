import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFile, readCache, writeCache } from "./cache.js";
import { CsvImportError, importCsv, parseCsv } from "./csv.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csv-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function problems(text: string): readonly string[] {
  try {
    parseCsv(text, "test.csv");
  } catch (err) {
    if (err instanceof CsvImportError) return err.problems;
    throw err;
  }
  throw new Error("expected parseCsv to throw");
}

describe("parseCsv", () => {
  it("parses rows into candles sorted by date", () => {
    const csv = [
      "date,open,high,low,close,volume",
      "2024-01-02,105,120,104,118,236000",
      "2024-01-01,100,110,95,105,105000",
    ].join("\n");
    expect(parseCsv(csv)).toEqual([
      { date: "2024-01-01", open: 100, high: 110, low: 95, close: 105, volume: 105000 },
      { date: "2024-01-02", open: 105, high: 120, low: 104, close: 118, volume: 236000 },
    ]);
  });

  it("accepts any column order and case, quotes, CRLF, blank lines and extra columns", () => {
    const csv = 'Close,DATE,Open,Low,High,notes\r\n\r\n"118","2024-01-02",105,104,120,ok\r\n';
    expect(parseCsv(csv)).toEqual([
      { date: "2024-01-02", open: 105, high: 120, low: 104, close: 118, volume: null },
    ]);
  });

  it("treats an empty volume as unknown", () => {
    expect(
      parseCsv("date,open,high,low,close,volume\n2024-01-01,1,1,1,1,\n")[0]!.volume,
    ).toBeNull();
  });

  it("names missing columns", () => {
    expect(problems("date,open,close\n2024-01-01,1,1")).toEqual([
      "header is missing column(s): high, low (found: date, open, close)",
    ]);
  });

  it("reports every bad line with its line number", () => {
    const csv = [
      "date,open,high,low,close,volume",
      "2024-01-01,1,1,1,1,10",
      "2024-02-30,1,1,1,1,10",
      "2024-01-03,1,abc,1,0,10",
      "2024-01-01,1,1,1,1,10",
      "2024-01-05,1,1,1,1,-3",
    ].join("\n");
    expect(problems(csv)).toEqual([
      'line 3: date "2024-02-30" is not a valid YYYY-MM-DD date',
      'line 4: high "abc" is not a positive number',
      'line 4: close "0" is not a positive number',
      "line 5: duplicate date 2024-01-01 (first on line 2)",
      'line 6: volume "-3" is not a non-negative number',
    ]);
  });

  it("rejects an empty file", () => {
    expect(problems("\n\n")).toEqual(["file is empty"]);
  });
});

describe("importCsv", () => {
  it("merges into the cache, with CSV rows replacing cached ones for the same date", async () => {
    const cachePath = cacheFile(dir, "SOL");
    await writeCache(cachePath, [
      { date: "2024-01-01", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { date: "2024-01-02", open: 2, high: 2, low: 2, close: 2, volume: 2 },
    ]);
    const csvPath = join(dir, "sol.csv");
    writeFileSync(
      csvPath,
      "date,open,high,low,close\n2024-01-02,20,20,20,20\n2024-01-03,3,3,3,3\n",
    );

    const result = await importCsv(csvPath, "SOL", { cacheDir: dir });
    expect(result).toEqual({ symbol: "SOL", imported: 2, replaced: 1, total: 3, cachePath });
    expect((await readCache(cachePath)).map((c) => [c.date, c.close])).toEqual([
      ["2024-01-01", 1],
      ["2024-01-02", 20],
      ["2024-01-03", 3],
    ]);
  });

  it("leaves the cache untouched when the CSV has any bad line", async () => {
    const csvPath = join(dir, "bad.csv");
    writeFileSync(csvPath, "date,open,high,low,close\n2024-01-01,1,1,1,1\n2024-01-02,1,1,1,-1\n");
    await expect(importCsv(csvPath, "SOL", { cacheDir: dir })).rejects.toThrow(
      `Cannot import ${csvPath}:\n  line 3: close "-1" is not a positive number`,
    );
    expect(await readCache(cacheFile(dir, "SOL"))).toEqual([]);
  });

  it("rejects a symbol that is not in the token registry", async () => {
    await expect(importCsv(join(dir, "x.csv"), "DOGE", { cacheDir: dir })).rejects.toThrow(
      'unsupported token "DOGE"',
    );
  });
});
