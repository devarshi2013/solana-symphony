import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFile, readCache, writeCache } from "./cache.js";
import type { Candle } from "./candle.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cache-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const candles: Candle[] = [
  { date: "2024-01-01", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
  { date: "2024-01-02", open: 1.5, high: 1.6, low: 1.4, close: 1.45, volume: null },
];

describe("cache", () => {
  it("names files <dir>/<SYMBOL>.json", () => {
    expect(cacheFile("/repo/data/cache", "JitoSOL")).toBe("/repo/data/cache/JitoSOL.json");
  });

  it("reads a missing file as empty", async () => {
    await expect(readCache(join(dir, "SOL.json"))).resolves.toEqual([]);
  });

  it("round-trips candles, one per line, creating the directory", async () => {
    const path = join(dir, "nested", "SOL.json");
    await writeCache(path, candles);
    expect(await readCache(path)).toEqual(candles);
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(5); // [, 2 candles, ], ""
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("explains how to recover from a corrupt file", async () => {
    const path = join(dir, "SOL.json");
    writeFileSync(path, '[{"date":"2024-01-01"');
    await expect(readCache(path)).rejects.toThrow(`${path} is not a valid candle cache`);
    await expect(readCache(path)).rejects.toThrow("delete it to re-download");
  });
});
