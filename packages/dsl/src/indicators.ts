import type { PriceProvider } from "./data.js";
import { assertNever } from "./internal.js";
import type { Indicator } from "./types.js";

/**
 * Pure indicator functions over daily closes (oldest first).
 *
 * Each returns null if `closes` is too short, and throws a RangeError if `window` is not a
 * positive integer or any close is not a positive finite number (which would otherwise
 * divide by zero or produce NaN). Price-level indicators (`sma`, `ema`) need
 * `window` closes; change-based ones (`rsi`, `cumulativeReturn`, `stdDevReturn`,
 * `maxDrawdown`) need `window + 1`, because `window` daily changes span `window + 1` closes.
 * Extra leading closes are ignored, except by `ema` and `rsi`, which use them as warm-up.
 *
 * Percent results are on a 0–100 scale (`5` means 5%).
 */

/**
 * How many windows of history `computeIndicator` fetches for `ema` and `rsi`. Both carry
 * state from earlier prices, so a longer warm-up makes them less sensitive to where the
 * data starts. With 2 windows, the seed's remaining weight is about 13% for EMA.
 */
export const SMOOTHING_WARMUP_WINDOWS = 2;

/** Simple moving average of the last `window` closes. */
export function sma(closes: readonly number[], window: number): number | null {
  assertInputs(closes, window);
  if (closes.length < window) return null;
  return mean(closes.slice(-window));
}

/**
 * Exponential moving average with smoothing factor 2 / (window + 1). Seeded with the SMA
 * of the first `window` closes, then updated with each later close.
 */
export function ema(closes: readonly number[], window: number): number | null {
  assertInputs(closes, window);
  if (closes.length < window) return null;
  const alpha = 2 / (window + 1);
  let value = mean(closes.slice(0, window));
  for (const close of closes.slice(window)) value = alpha * close + (1 - alpha) * value;
  return value;
}

/**
 * Relative strength index using Wilder's smoothing, on a 0–100 scale. The first average
 * gain and loss are simple means of the first `window` changes; each later change updates
 * them as `(previous * (window - 1) + current) / window`.
 *
 * Returns 100 when there are gains but no losses, and 50 when prices did not move at all.
 */
export function rsi(closes: readonly number[], window: number): number | null {
  assertInputs(closes, window);
  if (closes.length < window + 1) return null;
  const changes = dailyChanges(closes);
  let avgGain = mean(changes.slice(0, window).map((c) => Math.max(c, 0)));
  let avgLoss = mean(changes.slice(0, window).map((c) => Math.max(-c, 0)));
  for (const change of changes.slice(window)) {
    avgGain = (avgGain * (window - 1) + Math.max(change, 0)) / window;
    avgLoss = (avgLoss * (window - 1) + Math.max(-change, 0)) / window;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Total return over the last `window` days, in percent. */
export function cumulativeReturn(closes: readonly number[], window: number): number | null {
  assertInputs(closes, window);
  if (closes.length < window + 1) return null;
  const start = closes[closes.length - 1 - window]!;
  const end = closes[closes.length - 1]!;
  return (end / start - 1) * 100;
}

/**
 * Standard deviation of the last `window` daily returns, in percent. Uses the population
 * formula (divides by `window`), so a 1-day window gives 0 rather than no value.
 */
export function stdDevReturn(closes: readonly number[], window: number): number | null {
  assertInputs(closes, window);
  if (closes.length < window + 1) return null;
  const returns = dailyReturns(closes.slice(-(window + 1)));
  const m = mean(returns);
  const variance = mean(returns.map((r) => (r - m) ** 2));
  return Math.sqrt(variance) * 100;
}

/**
 * Largest peak-to-trough fall within the last `window + 1` closes, in percent, as a
 * positive number. 0 if prices never fell below an earlier peak.
 */
export function maxDrawdown(closes: readonly number[], window: number): number | null {
  assertInputs(closes, window);
  if (closes.length < window + 1) return null;
  let peak = -Infinity;
  let worst = 0;
  for (const close of closes.slice(-(window + 1))) {
    peak = Math.max(peak, close);
    worst = Math.max(worst, (peak - close) / peak);
  }
  return worst * 100;
}

/** Number of closes `computeIndicator` fetches for an indicator with the given window. */
export function lookbackFor(name: Indicator["name"], window: number): number {
  switch (name) {
    case "price":
      return 1;
    case "sma":
      return window;
    case "ema":
      return SMOOTHING_WARMUP_WINDOWS * window;
    case "rsi":
      return SMOOTHING_WARMUP_WINDOWS * window + 1;
    case "cumulativeReturn":
    case "stdDevReturn":
    case "maxDrawdown":
      return window + 1;
    default:
      return assertNever(name, "indicator");
  }
}

/**
 * Computes `indicator` for its symbol as of `asOf`, fetching exactly the closes it needs.
 * Returns null if the provider has too little history.
 *
 * @throws Error if a windowed indicator has no window (validateStrategy rejects these).
 */
export function computeIndicator(
  indicator: Indicator,
  provider: PriceProvider,
  asOf: Date,
): number | null {
  const { name, symbol } = indicator;
  if (name === "price") {
    const closes = provider.getCloses(symbol, asOf, 1);
    if (!closes) return null;
    assertCloses(closes);
    return closes[closes.length - 1] ?? null;
  }

  const window = indicator.window;
  if (window === undefined) throw new Error(`${name} indicator for ${symbol} has no window`);
  const closes = provider.getCloses(symbol, asOf, lookbackFor(name, window));
  if (!closes) return null;

  switch (name) {
    case "sma":
      return sma(closes, window);
    case "ema":
      return ema(closes, window);
    case "rsi":
      return rsi(closes, window);
    case "cumulativeReturn":
      return cumulativeReturn(closes, window);
    case "stdDevReturn":
      return stdDevReturn(closes, window);
    case "maxDrawdown":
      return maxDrawdown(closes, window);
    default:
      return assertNever(name, "indicator");
  }
}

function assertInputs(closes: readonly number[], window: number): void {
  assertWindow(window);
  assertCloses(closes);
}

function assertCloses(closes: readonly number[]): void {
  const bad = closes.findIndex((c) => !Number.isFinite(c) || c <= 0);
  if (bad !== -1) {
    throw new RangeError(
      `closes must be positive finite numbers, got ${closes[bad]} at index ${bad}`,
    );
  }
}

function assertWindow(window: number): void {
  if (!Number.isInteger(window) || window < 1) {
    throw new RangeError(`window must be a positive integer, got ${window}`);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function dailyChanges(closes: readonly number[]): number[] {
  return closes.slice(1).map((close, i) => close - closes[i]!);
}

function dailyReturns(closes: readonly number[]): number[] {
  return closes.slice(1).map((close, i) => close / closes[i]! - 1);
}
