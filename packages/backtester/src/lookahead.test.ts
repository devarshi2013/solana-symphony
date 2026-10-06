// Proves the backtester has no look-ahead bias: scrambling every price after a cutoff date
// must not change anything the backtest did up to and including that date.

import { readdirSync, readFileSync } from "node:fs";
import { CandlePriceProvider, type OpenClose } from "@solana-symphony/data";
import { TOKEN_SYMBOLS, validateStrategy, type Strategy } from "@solana-symphony/dsl";
import { describe, expect, it } from "vitest";
import { runBacktest, type BacktestPriceProvider, type BacktestResult } from "./engine.js";

const DAY_MS = 86_400_000;
const DATA_START = "2023-01-01"; // warm-up history before the backtest starts
const DATA_DAYS = 365;
const options = { start: "2023-05-01", end: "2023-09-30", initialCapital: 10_000 };
// A Monday (weekly rebalance day), the 1st of a month (monthly rebalance day), and a Thursday.
const CUTOFFS = ["2023-07-03", "2023-08-01", "2023-08-17"];
const SEEDS = [1, 2, 3];

const EXAMPLES_DIR = new URL("../../dsl/examples/", import.meta.url);
const examples = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file): [string, Strategy] => {
    const parsed = validateStrategy(JSON.parse(readFileSync(new URL(file, EXAMPLES_DIR), "utf8")));
    if (!parsed.ok) throw new Error(`${file}: ${parsed.errors.join("; ")}`);
    return [file, parsed.strategy];
  });

const date = (i: number) =>
  new Date(Date.parse(`${DATA_START}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);

/**
 * Deterministic prices for every registry token: a trend times a wave, with different
 * speeds and phases per token so strategies cross their thresholds and change allocations.
 * Each day opens at the previous day's close.
 */
function basePrices(): Record<string, OpenClose[]> {
  const data: Record<string, OpenClose[]> = {};
  TOKEN_SYMBOLS.forEach((symbol, k) => {
    const start = [100, 1, 0.8, 3, 0.00002, 110, 105, 2][k] ?? 1;
    const drift = symbol === "USDC" ? 0 : 0.0008 * (k - 3);
    const amp = symbol === "USDC" ? 0 : 0.15 + 0.05 * (k % 4);
    const period = 40 + 17 * k;
    const close = (i: number) =>
      start * Math.exp(drift * i) * (1 + amp * Math.sin((2 * Math.PI * i) / period + k));
    data[symbol] = Array.from({ length: DATA_DAYS }, (_, i) => ({
      date: date(i),
      open: i === 0 ? close(0) : close(i - 1),
      close: close(i),
    }));
  });
  return data;
}

/** mulberry32: a small seeded PRNG, so any failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which prices to replace on a candle's date: both, only the close, or none. */
type Scramble = (date: string) => "all" | "close" | "none";

/** Replaces the selected prices with random values from 0.01 to 10,000. */
function scramble(
  data: Record<string, OpenClose[]>,
  which: Scramble,
  seed: number,
): Record<string, OpenClose[]> {
  const random = rng(seed);
  const wild = () => 10 ** (random() * 6 - 2);
  return Object.fromEntries(
    Object.entries(data).map(([symbol, candles]) => [
      symbol,
      candles.map((c) => {
        const mode = which(c.date);
        if (mode === "all") return { date: c.date, open: wild(), close: wild() };
        if (mode === "close") return { ...c, close: wild() };
        return c;
      }),
    ]),
  );
}

/** Every price dated after `cutoff`: the test the request describes. */
const afterCutoff =
  (cutoff: string): Scramble =>
  (date) =>
    date > cutoff ? "all" : "none";

/** Also the cutoff day's close, but not its open: what a trade at that open may not see. */
const fromCutoffClose =
  (cutoff: string): Scramble =>
  (date) =>
    date > cutoff ? "all" : date === cutoff ? "close" : "none";

/** Everything the backtest recorded for dates up to and including `cutoff`. */
function upTo(result: BacktestResult, cutoff: string) {
  return {
    equity: result.equityCurve.filter((p) => p.date <= cutoff),
    holdings: result.holdings.filter((h) => h.date <= cutoff),
    trades: result.trades.filter((t) => t.date <= cutoff),
    rebalances: result.rebalances.filter((r) => r.date <= cutoff),
  };
}

/** Decisions and trades up to and including `cutoff`, and valuations before it. */
function decisionsUpTo(result: BacktestResult, cutoff: string) {
  return {
    equity: result.equityCurve.filter((p) => p.date < cutoff),
    holdings: result.holdings.filter((h) => h.date < cutoff),
    trades: result.trades.filter((t) => t.date <= cutoff),
    rebalances: result.rebalances.filter((r) => r.date <= cutoff),
  };
}

/** Everything recorded after `cutoff`. */
function after(result: BacktestResult, cutoff: string) {
  return {
    equity: result.equityCurve.filter((p) => p.date > cutoff),
    trades: result.trades.filter((t) => t.date > cutoff),
  };
}

const base = basePrices();
const baseProvider = new CandlePriceProvider(base);

describe("no look-ahead bias", () => {
  it("covers all five example strategies", () => {
    expect(examples.map(([file]) => file)).toEqual([
      "inverse-vol-majors.json",
      "momentum-top2.json",
      "nested.json",
      "rsi-dip.json",
      "sol-trend.json",
    ]);
  });

  describe.each(examples)("%s", (_file, strategy) => {
    const original = runBacktest(strategy, baseProvider, options);

    it.each(CUTOFFS)("is unchanged up to %s when every later price is scrambled", (cutoff) => {
      // Guard against a vacuous pass: the strategy must actually have traded by now.
      expect(upTo(original, cutoff).trades.length).toBeGreaterThan(0);

      let changedAfterCutoff = false;
      for (const seed of SEEDS) {
        const scrambled = runBacktest(
          strategy,
          new CandlePriceProvider(scramble(base, afterCutoff(cutoff), seed)),
          options,
        );
        // Exact equality: same equity values, weights, trades and rebalance targets.
        expect(upTo(scrambled, cutoff)).toEqual(upTo(original, cutoff));
        if (JSON.stringify(after(scrambled, cutoff)) !== JSON.stringify(after(original, cutoff))) {
          changedAfterCutoff = true;
        }
      }
      // The scrambled prices really were used after the cutoff.
      expect(changedAfterCutoff).toBe(true);
    });

    it.each(CUTOFFS)("trades at the %s open without seeing that day's close", (cutoff) => {
      for (const seed of SEEDS) {
        const scrambled = runBacktest(
          strategy,
          new CandlePriceProvider(scramble(base, fromCutoffClose(cutoff), seed)),
          options,
        );
        expect(decisionsUpTo(scrambled, cutoff)).toEqual(decisionsUpTo(original, cutoff));
      }
    });
  });

  it("would catch a provider that leaks the same day's close", () => {
    // Shows the tests above have teeth: the classic bug of deciding at today's open with
    // today's close must be caught for every example, by at least one cutoff.
    class LeakyProvider implements BacktestPriceProvider {
      constructor(private readonly inner: CandlePriceProvider) {}
      getCloses(symbol: string, asOf: Date, lookbackDays: number) {
        return this.inner.getCloses(symbol, new Date(asOf.getTime() + DAY_MS), lookbackDays);
      }
      getOpen(symbol: string, day: string) {
        return this.inner.getOpen(symbol, day);
      }
    }
    const leaky = (data: Record<string, OpenClose[]>) =>
      new LeakyProvider(new CandlePriceProvider(data));

    const caught = examples.map(([file, strategy]) => {
      const leakyOriginal = runBacktest(strategy, leaky(base), options);
      const detected = CUTOFFS.some((cutoff) => {
        const a = runBacktest(strategy, leaky(scramble(base, afterCutoff(cutoff), 1)), options);
        const b = runBacktest(strategy, leaky(scramble(base, fromCutoffClose(cutoff), 1)), options);
        return (
          JSON.stringify(upTo(a, cutoff)) !== JSON.stringify(upTo(leakyOriginal, cutoff)) ||
          JSON.stringify(decisionsUpTo(b, cutoff)) !==
            JSON.stringify(decisionsUpTo(leakyOriginal, cutoff))
        );
      });
      return [file, detected];
    });
    expect(caught).toEqual(examples.map(([file]) => [file, true]));
  });
});
