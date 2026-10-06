import type { Trade } from "./engine.js";

/** Crypto trades every day, so returns are annualised over 365 days. */
export const DAYS_PER_YEAR = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EquityPoint {
  /** UTC calendar date, `"YYYY-MM-DD"`. */
  date: string;
  /** Portfolio value; must be positive. */
  value: number;
}

export interface DatedReturn {
  date: string;
  /** Daily return as a fraction (0.05 = +5%). */
  return: number;
}

export interface Drawdown {
  /** Largest peak-to-trough fall as a positive fraction (0.25 = 25%); 0 if none. */
  depth: number;
  /** Date of the peak before the fall, or null if there was no fall. */
  peakDate: string | null;
  /** Date of the lowest point. */
  troughDate: string | null;
  /** First date back at or above the peak, or null if it never recovered. */
  recoveryDate: string | null;
}

/** All rates and returns are fractions (0.25 = 25%). Null means not enough data to compute. */
export interface Metrics {
  startDate: string;
  endDate: string;
  /** Calendar days from the starting value to the last point. */
  days: number;
  totalReturn: number;
  /** Compound annual growth rate. */
  cagr: number | null;
  /** Sample standard deviation of daily returns × √365. */
  annualizedVolatility: number | null;
  /** Mean daily excess return / standard deviation of daily returns × √365. */
  sharpe: number | null;
  /** Mean daily excess return / downside deviation × √365. */
  sortino: number | null;
  maxDrawdown: Drawdown;
  /** CAGR / max drawdown depth. */
  calmar: number | null;
  bestDay: DatedReturn | null;
  worstDay: DatedReturn | null;
  /** Fraction of daily returns above zero. */
  positiveDays: number | null;
  /** Return over the last calendar month, or null if the curve is shorter. */
  trailing1m: number | null;
  /** Return over the last 3 calendar months, or null if the curve is shorter. */
  trailing3m: number | null;
}

export interface MetricsOptions {
  /** Annual risk-free rate as a fraction (0.04 = 4%). Default 0. */
  riskFreeRate?: number;
  /**
   * Portfolio value the day before the first point, e.g. the backtest's initial capital.
   * Include it so the first day's return (and trading costs) count.
   */
  initialValue?: number;
}

/**
 * Computes performance metrics from a daily equity curve, ordered oldest first.
 *
 * Daily returns are `value[i] / value[i-1] - 1`. The risk-free rate is converted to a daily
 * rate, `(1 + rate)^(1/365) - 1`, and subtracted from each daily return for Sharpe and
 * Sortino. Sortino's downside deviation is `sqrt(sum(min(0, excess)^2) / n)` over all n
 * returns.
 *
 * @throws RangeError if the curve is empty, out of date order, or has a non-positive value.
 */
export function computeMetrics(
  equityCurve: readonly EquityPoint[],
  options: MetricsOptions = {},
): Metrics {
  const { riskFreeRate = 0, initialValue } = options;
  validateCurve(equityCurve, initialValue);

  const first = equityCurve[0]!;
  const last = equityCurve.at(-1)!;
  // With an initial value, the curve starts the day before the first point.
  const points: EquityPoint[] =
    initialValue === undefined
      ? [...equityCurve]
      : [{ date: shiftDate(first.date, 0, -1), value: initialValue }, ...equityCurve];
  const base = points[0]!;

  const returns: DatedReturn[] = points
    .slice(1)
    .map((p, i) => ({ date: p.date, return: p.value / points[i]!.value - 1 }));
  const days = Math.round((Date.parse(last.date) - Date.parse(base.date)) / DAY_MS);
  const years = days / DAYS_PER_YEAR;
  const totalReturn = last.value / base.value - 1;
  const cagr = years > 0 ? (1 + totalReturn) ** (1 / years) - 1 : null;

  const rfDaily = (1 + riskFreeRate) ** (1 / DAYS_PER_YEAR) - 1;
  const excess = returns.map((r) => r.return - rfDaily);
  const sd = sampleStdDev(returns.map((r) => r.return));
  const annualize = Math.sqrt(DAYS_PER_YEAR);
  const meanExcess = excess.length > 0 ? mean(excess) : null;
  const downside =
    excess.length > 0 ? Math.sqrt(mean(excess.map((e) => Math.min(0, e) ** 2))) : null;

  const maxDrawdown = findMaxDrawdown(points);
  const byReturn = [...returns].sort((a, b) => a.return - b.return);

  return {
    startDate: base.date,
    endDate: last.date,
    days,
    totalReturn,
    cagr,
    annualizedVolatility: sd === null ? null : sd * annualize,
    sharpe: sd && meanExcess !== null ? (meanExcess / sd) * annualize : null,
    sortino: downside && meanExcess !== null ? (meanExcess / downside) * annualize : null,
    maxDrawdown,
    calmar: cagr !== null && maxDrawdown.depth > 0 ? cagr / maxDrawdown.depth : null,
    bestDay: byReturn.at(-1) ?? null,
    worstDay: byReturn[0] ?? null,
    positiveDays:
      returns.length > 0 ? returns.filter((r) => r.return > 0).length / returns.length : null,
    trailing1m: trailingReturn(points, 1),
    trailing3m: trailingReturn(points, 3),
  };
}

export interface Turnover {
  /** Total value traded (buys plus sells, at execution prices) in USDC. */
  tradedValue: number;
  /** Traded value as a multiple of the average portfolio value. */
  turnover: number;
  /** Turnover per year (turnover / years covered by the curve), or null for under a day. */
  annualizedTurnover: number | null;
}

/**
 * Turnover: how many times the portfolio's average value was traded. Counts every trade,
 * including the first day's buys from cash, so buy-and-hold has a turnover of about 1.
 */
export function computeTurnover(
  trades: readonly Trade[],
  equityCurve: readonly EquityPoint[],
  options: Pick<MetricsOptions, "initialValue"> = {},
): Turnover {
  validateCurve(equityCurve, options.initialValue);
  const values = equityCurve.map((p) => p.value);
  if (options.initialValue !== undefined) values.unshift(options.initialValue);
  const tradedValue = trades.reduce((sum, t) => sum + t.amount * t.price, 0);
  const turnover = tradedValue / mean(values);
  const startMs =
    Date.parse(equityCurve[0]!.date) - (options.initialValue === undefined ? 0 : DAY_MS);
  const years = (Date.parse(equityCurve.at(-1)!.date) - startMs) / DAY_MS / DAYS_PER_YEAR;
  return { tradedValue, turnover, annualizedTurnover: years > 0 ? turnover / years : null };
}

function findMaxDrawdown(points: readonly EquityPoint[]): Drawdown {
  let peak = points[0]!;
  let worst: Drawdown = { depth: 0, peakDate: null, troughDate: null, recoveryDate: null };
  for (const p of points) {
    if (p.value > peak.value) peak = p;
    const depth = 1 - p.value / peak.value;
    if (depth > worst.depth) {
      worst = { depth, peakDate: peak.date, troughDate: p.date, recoveryDate: null };
    }
  }
  if (worst.troughDate !== null) {
    const peakValue = points.find((p) => p.date === worst.peakDate)!.value;
    worst.recoveryDate =
      points.find((p) => p.date > worst.troughDate! && p.value >= peakValue)?.date ?? null;
  }
  return worst;
}

/** Return from the last point on or before `months` calendar months before the end. */
function trailingReturn(points: readonly EquityPoint[], months: number): number | null {
  const last = points.at(-1)!;
  const target = shiftDate(last.date, -months, 0);
  if (target < points[0]!.date) return null;
  const from = [...points].reverse().find((p) => p.date <= target)!;
  return last.value / from.value - 1;
}

/**
 * Moves a date by whole months and days. Month shifts clamp to the month's last day
 * (2024-03-31 minus 1 month is 2024-02-29).
 */
function shiftDate(date: string, months: number, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const targetMonth = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  const shifted = Date.UTC(d.getUTCFullYear(), targetMonth, Math.min(d.getUTCDate(), lastDay));
  return new Date(shifted + days * DAY_MS).toISOString().slice(0, 10);
}

function validateCurve(curve: readonly EquityPoint[], initialValue: number | undefined): void {
  if (curve.length === 0) throw new RangeError("equity curve is empty");
  for (let i = 0; i < curve.length; i++) {
    const { date, value } = curve[i]!;
    if (!(Number.isFinite(value) && value > 0)) {
      throw new RangeError(`equity value on ${date} must be positive, got ${value}`);
    }
    if (i > 0 && date <= curve[i - 1]!.date) {
      throw new RangeError(`equity curve dates must increase: ${curve[i - 1]!.date} then ${date}`);
    }
  }
  if (initialValue !== undefined && !(Number.isFinite(initialValue) && initialValue > 0)) {
    throw new RangeError(`initialValue must be positive, got ${initialValue}`);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n - 1), or null with fewer than 2 values. */
function sampleStdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}
