import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFile, writeCache } from "./cache.js";
import type { Candle } from "./candle.js";
import { CandlePriceProvider, FilePriceProvider } from "./file-provider.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-provider-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const c = (date: string, close: number): Candle => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: null,
});

describe("FilePriceProvider", () => {
  it("serves closes from the cache files, oldest first", async () => {
    await writeCache(cacheFile(dir, "SOL"), [
      c("2024-01-01", 100),
      c("2024-01-02", 110),
      c("2024-01-03", 120),
    ]);
    const provider = await FilePriceProvider.load({ cacheDir: dir, symbols: ["SOL", "JUP"] });

    expect(provider.symbols).toEqual(["SOL"]);
    // at 2024-01-04T00:00Z the 2024-01-03 candle has just closed
    expect(provider.getCloses("SOL", new Date("2024-01-04T00:00:00Z"), 3)).toEqual([100, 110, 120]);
  });

  it("never returns a candle before its day has closed", async () => {
    await writeCache(cacheFile(dir, "SOL"), [c("2024-01-01", 100), c("2024-01-02", 110)]);
    const provider = await FilePriceProvider.load({ cacheDir: dir, symbols: ["SOL"] });
    expect(provider.getCloses("SOL", new Date("2024-01-02T12:00:00Z"), 1)).toEqual([100]);
  });

  it("returns null for a symbol with no cache file or too little history", async () => {
    await writeCache(cacheFile(dir, "SOL"), [c("2024-01-01", 100)]);
    const provider = await FilePriceProvider.load({ cacheDir: dir, symbols: ["SOL", "JUP"] });
    expect(provider.getCloses("JUP", new Date("2024-02-01T00:00:00Z"), 1)).toBeNull();
    expect(provider.getCloses("SOL", new Date("2024-02-01T00:00:00Z"), 2)).toBeNull();
  });

  it("refuses to load bad data and points to data:check", async () => {
    await writeCache(cacheFile(dir, "SOL"), [c("2024-01-01", 100), c("2024-01-02", 0)]);
    await expect(FilePriceProvider.load({ cacheDir: dir, symbols: ["SOL"] })).rejects.toThrow(
      /bad data in .*: SOL 2024-01-02: close must be a positive number, got 0\. Run `pnpm data:check`/,
    );
  });
});

describe("CandlePriceProvider", () => {
  const provider = new CandlePriceProvider({
    SOL: [
      { date: "2024-01-01", open: 95, close: 100 },
      { date: "2024-01-02", open: 101, close: 110 },
    ],
  });

  it("returns the open price for a date, or null if there is no candle", () => {
    expect(provider.getOpen("SOL", "2024-01-02")).toBe(101);
    expect(provider.getOpen("SOL", "2024-01-03")).toBeNull();
    expect(provider.getOpen("JUP", "2024-01-01")).toBeNull();
  });

  it("serves closes with the same no-look-ahead rule", () => {
    expect(provider.getCloses("SOL", new Date("2024-01-02T00:00:00Z"), 1)).toEqual([100]);
  });

  it("rejects a non-positive open", () => {
    expect(
      () => new CandlePriceProvider({ SOL: [{ date: "2024-01-01", open: 0, close: 1 }] }),
    ).toThrow("SOL 2024-01-01: open must be a positive number, got 0");
  });
});
