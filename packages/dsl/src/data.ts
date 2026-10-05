/**
 * Price data access for indicator evaluation.
 *
 * Conventions:
 * - A candle dated `"YYYY-MM-DD"` is that UTC day's close, which happens at the end of the
 *   day: 00:00 UTC on the following date.
 * - A close is available only once `asOf` has reached that moment, so a backtest can never
 *   see a price before it existed. At `2024-03-06T00:00:00Z` the latest close is
 *   2024-03-05's; at any time during 2024-03-05 it is still 2024-03-04's.
 * - Closes are not filled in for missing days: a lookback of n returns the n most recent
 *   candles, whatever dates they fall on.
 */
export interface PriceProvider {
  /**
   * Returns the `lookbackDays` most recent daily closes for `symbol` that had closed by
   * `asOf`, oldest first. Returns null if the symbol is unknown or fewer than
   * `lookbackDays` closes exist up to `asOf`.
   *
   * @throws RangeError if `lookbackDays` is not a positive integer or `asOf` is an invalid date.
   */
  getCloses(symbol: string, asOf: Date, lookbackDays: number): number[] | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One daily candle as supplied to InMemoryPriceProvider. */
export interface DailyClose {
  /** UTC calendar date, `"YYYY-MM-DD"`. */
  date: string;
  /** Closing price. Must be a positive finite number. */
  close: number;
}

/** PriceProvider backed by in-memory data, for tests and small fixtures. */
export class InMemoryPriceProvider implements PriceProvider {
  private readonly series = new Map<string, { dates: string[]; closes: number[] }>();

  /**
   * @param data Closes per symbol, in any order. Copied on construction.
   * @throws Error on an invalid date, a duplicate date, or a close that is not positive.
   */
  constructor(data: Readonly<Record<string, readonly DailyClose[]>>) {
    for (const [symbol, candles] of Object.entries(data)) {
      for (const { date, close } of candles) {
        if (!isIsoDate(date)) {
          throw new Error(`${symbol}: invalid date "${date}", expected YYYY-MM-DD`);
        }
        if (!Number.isFinite(close) || close <= 0) {
          throw new Error(`${symbol} ${date}: close must be a positive number, got ${close}`);
        }
      }
      const sorted = [...candles].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.date === sorted[i - 1]!.date) {
          throw new Error(`${symbol}: duplicate candle for ${sorted[i]!.date}`);
        }
      }
      this.series.set(symbol, {
        dates: sorted.map((c) => c.date),
        closes: sorted.map((c) => c.close),
      });
    }
  }

  getCloses(symbol: string, asOf: Date, lookbackDays: number): number[] | null {
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
      throw new RangeError(`lookbackDays must be a positive integer, got ${lookbackDays}`);
    }
    if (Number.isNaN(asOf.getTime())) throw new RangeError("asOf is an invalid date");

    const series = this.series.get(symbol);
    if (!series) return null;

    // The candle dated D closes at D + 1 day, so the last closed candle is dated asOf - 1 day.
    const lastClosedDay = new Date(asOf.getTime() - DAY_MS).toISOString().slice(0, 10);
    const end = countOnOrBefore(series.dates, lastClosedDay);
    if (end < lookbackDays) return null;
    return series.closes.slice(end - lookbackDays, end);
  }
}

/** Number of entries in sorted `dates` that are on or before `day` (binary search). */
function countOnOrBefore(dates: readonly string[], day: string): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (dates[mid]! <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
