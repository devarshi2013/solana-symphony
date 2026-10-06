import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFile, readCache, writeCache } from "./cache.js";
import { addDays, type Candle } from "./candle.js";
import { fetchHistory } from "./history.js";
import type { HistoryProvider, TokenRef } from "./providers/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "history-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SOL: TokenRef = { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" };
const JUP: TokenRef = { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" };

const candle = (date: string, close = 1): Candle => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

/** A provider returning one candle per day (from `listedFrom`), recording each request. */
function fakeProvider(options: { chunkDays?: number; listedFrom?: string; failFor?: string } = {}) {
  const requests: Array<[string, string, string]> = [];
  const provider: HistoryProvider = {
    name: "fake",
    chunkDays: options.chunkDays ?? 10,
    async fetchDaily(token, from, to) {
      requests.push([token.symbol, from, to]);
      if (token.symbol === options.failFor) throw new Error("gave up after 4 attempts: HTTP 500");
      const out: Candle[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (d >= (options.listedFrom ?? "")) out.push(candle(d));
      }
      return out;
    },
  };
  return { provider, requests };
}

describe("fetchHistory", () => {
  it("downloads in chunks and saves every day from start to end", async () => {
    const { provider, requests } = fakeProvider({ chunkDays: 10 });
    const results = await fetchHistory({
      tokens: [SOL],
      provider,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-25",
    });

    expect(requests).toEqual([
      ["SOL", "2024-01-01", "2024-01-10"],
      ["SOL", "2024-01-11", "2024-01-20"],
      ["SOL", "2024-01-21", "2024-01-25"],
    ]);
    const saved = await readCache(cacheFile(dir, "SOL"));
    expect(saved).toHaveLength(25);
    expect(saved.at(-1)!.date).toBe("2024-01-25");
    expect(results).toEqual([
      { symbol: "SOL", status: "updated", added: 25, lastDate: "2024-01-25" },
    ]);
  });

  it("resumes after the last saved date instead of re-downloading", async () => {
    await writeCache(cacheFile(dir, "SOL"), [candle("2024-01-01"), candle("2024-01-02")]);
    const { provider, requests } = fakeProvider();
    const results = await fetchHistory({
      tokens: [SOL],
      provider,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-05",
    });

    expect(requests).toEqual([["SOL", "2024-01-03", "2024-01-05"]]);
    expect(await readCache(cacheFile(dir, "SOL"))).toHaveLength(5);
    expect(results[0]).toMatchObject({ status: "updated", added: 3 });
  });

  it("makes no request when the cache is already up to date", async () => {
    await writeCache(cacheFile(dir, "SOL"), [candle("2024-01-05")]);
    const { provider, requests } = fakeProvider();
    const results = await fetchHistory({
      tokens: [SOL],
      provider,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-05",
    });

    expect(requests).toEqual([]);
    expect(results).toEqual([{ symbol: "SOL", status: "up-to-date", lastDate: "2024-01-05" }]);
  });

  it("handles a token listed after the start date", async () => {
    const { provider } = fakeProvider({ chunkDays: 10, listedFrom: "2024-01-15" });
    await fetchHistory({
      tokens: [JUP],
      provider,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-20",
    });
    const saved = await readCache(cacheFile(dir, "JUP"));
    expect(saved.map((c) => c.date)[0]).toBe("2024-01-15");
    expect(saved).toHaveLength(6);
  });

  it("keeps going after one token fails, and reports it", async () => {
    const { provider } = fakeProvider({ failFor: "SOL" });
    const results = await fetchHistory({
      tokens: [SOL, JUP],
      provider,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-03",
    });

    expect(results[0]).toEqual({
      symbol: "SOL",
      status: "failed",
      added: 0,
      error: "gave up after 4 attempts: HTTP 500",
    });
    expect(results[1]).toMatchObject({ symbol: "JUP", status: "updated", added: 3 });
  });

  it("keeps chunks saved before a failure, so the next run resumes there", async () => {
    let calls = 0;
    const flaky: HistoryProvider = {
      name: "flaky",
      chunkDays: 2,
      async fetchDaily(_token, from, to) {
        if (++calls === 2) throw new Error("boom");
        return [candle(from), candle(to)];
      },
    };
    await fetchHistory({
      tokens: [SOL],
      provider: flaky,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-06",
    });
    const saved = await readCache(cacheFile(dir, "SOL"));
    expect(saved.map((c) => c.date)).toEqual(["2024-01-01", "2024-01-02"]);
  });

  it("drops invalid candles and anything outside the requested chunk", async () => {
    const messy: HistoryProvider = {
      name: "messy",
      chunkDays: 10,
      async fetchDaily() {
        return [
          candle("2023-12-31"),
          candle("2024-01-01"),
          candle("2024-01-02", 0),
          candle("2024-01-03"),
        ];
      },
    };
    const log: string[] = [];
    await fetchHistory({
      tokens: [SOL],
      provider: messy,
      cacheDir: dir,
      start: "2024-01-01",
      end: "2024-01-03",
      log: (m) => log.push(m),
    });
    const saved = await readCache(cacheFile(dir, "SOL"));
    expect(saved.map((c) => c.date)).toEqual(["2024-01-01", "2024-01-03"]);
    expect(log.some((m) => m.includes("dropped 1 invalid candle(s)"))).toBe(true);
  });
});
