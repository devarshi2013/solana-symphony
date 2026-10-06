import type { LabeledResult } from "./benchmark.js";
import { computeMetrics, computeTurnover, type Metrics, type Turnover } from "./metrics.js";

export interface ComparedResult {
  label: string;
  metrics: Metrics;
  turnover: Turnover;
  finalValue: number;
  totalFees: number;
  totalSlippage: number;
  /**
   * Pearson correlation of daily returns with the first result (the strategy), over the
   * dates both cover. Null for the strategy itself, with fewer than 2 shared days, or when
   * either side never moves (e.g. buy-and-hold USDC), since correlation is then undefined.
   */
  correlation: number | null;
}

export interface ComparisonRow {
  metric: string;
  /** One formatted cell per result, in the same order as `Comparison.labels`. */
  cells: string[];
}

export interface Comparison {
  labels: string[];
  results: ComparedResult[];
  /** The metrics as formatted rows, ready to print side by side. */
  rows: ComparisonRow[];
}

/**
 * Compares backtest results side by side. The first result is treated as the strategy;
 * each later one gets its daily-return correlation with it.
 *
 * Metrics include each result's first day (from its initial capital). Results should cover
 * the same dates; correlation uses only the dates they share.
 */
export function compare(
  results: readonly LabeledResult[],
  options: { riskFreeRate?: number } = {},
): Comparison {
  if (results.length === 0) throw new RangeError("nothing to compare");
  const base = dailyReturns(results[0]!);

  const compared: ComparedResult[] = results.map((r, i) => {
    const { equityCurve, initialCapital, trades } = r.result;
    return {
      label: r.label,
      metrics: computeMetrics(equityCurve, {
        initialValue: initialCapital,
        ...(options.riskFreeRate !== undefined ? { riskFreeRate: options.riskFreeRate } : {}),
      }),
      turnover: computeTurnover(trades, equityCurve, { initialValue: initialCapital }),
      finalValue: equityCurve.at(-1)!.value,
      totalFees: r.result.totalFees,
      totalSlippage: r.result.totalSlippage,
      correlation: i === 0 ? null : correlationByDate(base, dailyReturns(r)),
    };
  });

  const row = (metric: string, cell: (c: ComparedResult, i: number) => string): ComparisonRow => ({
    metric,
    cells: compared.map(cell),
  });
  const rows: ComparisonRow[] = [
    row("Final value", (c) => money(c.finalValue)),
    row("Total return", (c) => pct(c.metrics.totalReturn)),
    row("CAGR", (c) => pct(c.metrics.cagr)),
    row("Volatility (ann.)", (c) => pct(c.metrics.annualizedVolatility, false)),
    row("Sharpe", (c) => ratio(c.metrics.sharpe)),
    row("Sortino", (c) => ratio(c.metrics.sortino)),
    row("Max drawdown", (c) => pct(-c.metrics.maxDrawdown.depth)),
    row("Drawdown peak → trough", (c) =>
      c.metrics.maxDrawdown.peakDate
        ? `${c.metrics.maxDrawdown.peakDate} → ${c.metrics.maxDrawdown.troughDate}`
        : "-",
    ),
    row("Calmar", (c) => ratio(c.metrics.calmar)),
    row("Best day", (c) => (c.metrics.bestDay ? pct(c.metrics.bestDay.return) : "-")),
    row("Worst day", (c) => (c.metrics.worstDay ? pct(c.metrics.worstDay.return) : "-")),
    row("Positive days", (c) => pct(c.metrics.positiveDays, false)),
    row("Trailing 1m", (c) => pct(c.metrics.trailing1m)),
    row("Trailing 3m", (c) => pct(c.metrics.trailing3m)),
    row("Turnover (ann.)", (c) =>
      c.turnover.annualizedTurnover === null ? "-" : `${c.turnover.annualizedTurnover.toFixed(2)}x`,
    ),
    row("Fees", (c) => money(c.totalFees)),
    row("Slippage", (c) => money(c.totalSlippage)),
    row("Correlation vs strategy", (c, i) => (i === 0 ? "-" : ratio(c.correlation))),
  ];
  return { labels: compared.map((c) => c.label), results: compared, rows };
}

/** Renders a comparison as a fixed-width text table. */
export function formatComparison(comparison: Comparison): string {
  const header = ["", ...comparison.labels];
  const body = comparison.rows.map((r) => [r.metric, ...r.cells]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

/** Pearson correlation of two equal-length series, or null if undefined. */
export function correlation(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length) throw new RangeError("series must have the same length");
  if (x.length < 2) return null;
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Daily returns keyed by date, the first measured from the initial capital. */
function dailyReturns({ result }: LabeledResult): Map<string, number> {
  const returns = new Map<string, number>();
  let previous = result.initialCapital;
  for (const { date, value } of result.equityCurve) {
    returns.set(date, value / previous - 1);
    previous = value;
  }
  return returns;
}

function correlationByDate(a: Map<string, number>, b: Map<string, number>): number | null {
  const shared = [...a.keys()].filter((d) => b.has(d));
  return correlation(
    shared.map((d) => a.get(d)!),
    shared.map((d) => b.get(d)!),
  );
}

/** A fraction as a percent with one decimal; `signed` adds "+" to gains. */
function pct(value: number | null, signed = true): string {
  if (value === null) return "-";
  const p = value * 100;
  return `${signed && p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function ratio(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
