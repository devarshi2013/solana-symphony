import { TOKEN_SYMBOLS } from "@solana-symphony/dsl";
import { cacheFile, readCache } from "./cache.js";
import { addDays, DAY_MS, dayStartMs, type Candle } from "./candle.js";
import { defaultCacheDir } from "./paths.js";

/** A close-to-close move larger than this fraction (80%) is flagged as likely bad data. */
export const BIG_MOVE_THRESHOLD = 0.8;

export interface DateRange {
  from: string;
  to: string;
  days: number;
}

export interface BigMove {
  /** Date of the candle that moved. */
  date: string;
  previousDate: string;
  /** Close-to-close change in percent, e.g. 150 or -85. */
  changePct: number;
}

export interface DataReport {
  symbol: string;
  /** "no data" if the cache file is missing or empty; "error" if it could not be read. */
  status: "ok" | "issues" | "no data" | "error";
  error?: string;
  candles: number;
  firstDate?: string;
  lastDate?: string;
  /** Calendar days between first and last date with no candle. */
  missingDays: number;
  missingRanges: DateRange[];
  duplicateDates: string[];
  /** Dates where open, high, low or close is zero, negative or not a number. */
  badPriceDates: string[];
  bigMoves: BigMove[];
}

/** Checks one symbol's candles (in file order). Pure. */
export function analyzeCandles(symbol: string, candles: readonly Candle[]): DataReport {
  const empty: DataReport = {
    symbol,
    status: "no data",
    candles: 0,
    missingDays: 0,
    missingRanges: [],
    duplicateDates: [],
    badPriceDates: [],
    bigMoves: [],
  };
  if (candles.length === 0) return empty;

  const counts = new Map<string, number>();
  for (const c of candles) counts.set(c.date, (counts.get(c.date) ?? 0) + 1);
  const duplicateDates = [...counts]
    .filter(([, n]) => n > 1)
    .map(([d]) => d)
    .sort();
  const dates = [...counts.keys()].sort();

  const missingRanges: DateRange[] = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = Math.round((dayStartMs(dates[i]!) - dayStartMs(dates[i - 1]!)) / DAY_MS) - 1;
    if (gap > 0) {
      missingRanges.push({
        from: addDays(dates[i - 1]!, 1),
        to: addDays(dates[i]!, -1),
        days: gap,
      });
    }
  }

  const badPriceDates = candles
    .filter((c) => [c.open, c.high, c.low, c.close].some((p) => !(Number.isFinite(p) && p > 0)))
    .map((c) => c.date);

  // Compare consecutive candles by date, skipping any with bad prices.
  const sorted = [...candles]
    .filter((c) => !badPriceDates.includes(c.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const bigMoves: BigMove[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.date === prev.date) continue;
    const change = cur.close / prev.close - 1;
    if (Math.abs(change) > BIG_MOVE_THRESHOLD) {
      bigMoves.push({ date: cur.date, previousDate: prev.date, changePct: change * 100 });
    }
  }

  const missingDays = missingRanges.reduce((sum, r) => sum + r.days, 0);
  const hasIssues =
    missingDays > 0 || duplicateDates.length > 0 || badPriceDates.length > 0 || bigMoves.length > 0;
  return {
    ...empty,
    status: hasIssues ? "issues" : "ok",
    candles: candles.length,
    firstDate: dates[0]!,
    lastDate: dates.at(-1)!,
    missingDays,
    missingRanges,
    duplicateDates,
    badPriceDates,
    bigMoves,
  };
}

/** Reads each symbol's cache file and checks it. Unreadable files are reported, not thrown. */
export async function checkData(
  options: { cacheDir?: string; symbols?: readonly string[] } = {},
): Promise<DataReport[]> {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const reports: DataReport[] = [];
  for (const symbol of options.symbols ?? TOKEN_SYMBOLS) {
    try {
      reports.push(analyzeCandles(symbol, await readCache(cacheFile(cacheDir, symbol))));
    } catch (err) {
      reports.push({
        ...analyzeCandles(symbol, []),
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reports;
}

/** Renders reports as a fixed-width table, followed by details of every issue found. */
export function formatReport(reports: readonly DataReport[]): string {
  const header = [
    "Symbol",
    "First",
    "Last",
    "Candles",
    "Missing",
    "Dupes",
    "Bad price",
    "Moves>80%",
    "Status",
  ];
  const rows = reports.map((r) => [
    r.symbol,
    r.firstDate ?? "-",
    r.lastDate ?? "-",
    String(r.candles),
    String(r.missingDays),
    String(r.duplicateDates.length),
    String(r.badPriceDates.length),
    String(r.bigMoves.length),
    r.status.toUpperCase(),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  const out = [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];

  for (const r of reports) {
    const details: string[] = [];
    if (r.error) details.push(`  unreadable: ${r.error}`);
    for (const m of r.missingRanges.slice(0, 10)) {
      details.push(
        `  missing ${m.from === m.to ? m.from : `${m.from}..${m.to}`} (${m.days} day${m.days === 1 ? "" : "s"})`,
      );
    }
    if (r.missingRanges.length > 10)
      details.push(`  ...and ${r.missingRanges.length - 10} more gaps`);
    if (r.duplicateDates.length > 0) details.push(`  duplicate dates: ${list(r.duplicateDates)}`);
    if (r.badPriceDates.length > 0)
      details.push(`  zero/negative prices: ${list(r.badPriceDates)}`);
    for (const m of r.bigMoves.slice(0, 10)) {
      const sign = m.changePct > 0 ? "+" : "";
      details.push(`  ${sign}${m.changePct.toFixed(1)}% close move ${m.previousDate} -> ${m.date}`);
    }
    if (r.bigMoves.length > 10) details.push(`  ...and ${r.bigMoves.length - 10} more big moves`);
    if (details.length > 0) out.push("", `${r.symbol}:`, ...details);
  }
  return out.join("\n");
}

function list(dates: readonly string[]): string {
  return dates.length <= 10
    ? dates.join(", ")
    : `${dates.slice(0, 10).join(", ")} ...and ${dates.length - 10} more`;
}
