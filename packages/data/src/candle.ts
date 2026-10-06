/** One daily candle, as stored in data/cache/<SYMBOL>.json. */
export interface Candle {
  /** UTC calendar date, `"YYYY-MM-DD"`. The candle covers 00:00–24:00 UTC that day. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Trading volume in USD over the day, or null if the provider did not report it. */
  volume: number | null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds since the epoch at 00:00 UTC on `date`. */
export function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** UTC calendar date of a timestamp in milliseconds. */
export function toDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a real calendar date written `YYYY-MM-DD` (rejects e.g. 2024-02-30). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = dayStartMs(value);
  return Number.isFinite(ms) && toDate(ms) === value;
}

export function addDays(date: string, days: number): string {
  return toDate(dayStartMs(date) + days * DAY_MS);
}

/**
 * The most recent UTC day whose candle has closed as of `now`: yesterday, in UTC. Today's
 * candle is still forming, so saving it would cache a close that later changes.
 */
export function lastCompleteDay(now: Date): string {
  return addDays(toDate(now.getTime()), -1);
}

/** True if prices are positive finite numbers and volume is null or a non-negative number. */
export function isValidCandle(candle: Candle): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  const volumeOk = candle.volume === null || (Number.isFinite(candle.volume) && candle.volume >= 0);
  return prices.every((p) => Number.isFinite(p) && p > 0) && volumeOk;
}

/** Combines two candle lists, one candle per date (`incoming` wins), sorted by date. */
export function mergeCandles(existing: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const candle of [...existing, ...incoming]) byDate.set(candle.date, candle);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
