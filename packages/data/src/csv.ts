import { readFile } from "node:fs/promises";
import { isSupportedSymbol, TOKEN_SYMBOLS } from "@solana-symphony/dsl";
import { cacheFile, readCache, writeCache } from "./cache.js";
import { isIsoDate, isValidCandle, mergeCandles, type Candle } from "./candle.js";
import { defaultCacheDir } from "./paths.js";

const REQUIRED_COLUMNS = ["date", "open", "high", "low", "close"] as const;

/** A CSV that could not be imported. Lists every problem found, with line numbers. */
export class CsvImportError extends Error {
  override readonly name = "CsvImportError";

  constructor(
    readonly path: string,
    readonly problems: readonly string[],
  ) {
    const shown = problems.slice(0, 20);
    const more =
      problems.length > shown.length ? [`...and ${problems.length - shown.length} more`] : [];
    super([`Cannot import ${path}:`, ...shown.map((p) => `  ${p}`), ...more].join("\n"));
  }
}

/**
 * Parses daily candles from CSV text.
 *
 * - The first line is a header naming the columns, in any order and any case:
 *   `date,open,high,low,close` are required, `volume` is optional, others are ignored.
 * - `date` is a UTC calendar date, `YYYY-MM-DD`. Prices must be positive numbers.
 * - An empty or missing volume becomes null.
 * - Blank lines are skipped; values may be wrapped in double quotes.
 *
 * Returns candles sorted by date, or throws a CsvImportError listing every bad line.
 */
export function parseCsv(text: string, path = "CSV"): Candle[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex === -1) throw new CsvImportError(path, ["file is empty"]);

  const header = splitRow(lines[headerIndex]!).map((h) => h.toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new CsvImportError(path, [
      `header is missing column(s): ${missing.join(", ")} (found: ${header.join(", ")})`,
    ]);
  }
  const col = (name: string) => header.indexOf(name);

  const problems: string[] = [];
  const candles: Candle[] = [];
  const seen = new Map<string, number>();

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const lineNo = i + 1;
    const fields = splitRow(line);
    const field = (name: string) => (col(name) === -1 ? "" : (fields[col(name)] ?? ""));

    const date = field("date");
    if (!isIsoDate(date)) {
      problems.push(`line ${lineNo}: date "${date}" is not a valid YYYY-MM-DD date`);
      continue;
    }
    const firstLine = seen.get(date);
    if (firstLine !== undefined) {
      problems.push(`line ${lineNo}: duplicate date ${date} (first on line ${firstLine})`);
      continue;
    }
    seen.set(date, lineNo);

    const prices: number[] = [];
    for (const name of ["open", "high", "low", "close"]) {
      const value = Number(field(name));
      if (field(name) === "" || !Number.isFinite(value) || value <= 0) {
        problems.push(`line ${lineNo}: ${name} "${field(name)}" is not a positive number`);
      }
      prices.push(value);
    }
    const rawVolume = field("volume");
    const volume = rawVolume === "" ? null : Number(rawVolume);
    if (volume !== null && !(Number.isFinite(volume) && volume >= 0)) {
      problems.push(`line ${lineNo}: volume "${rawVolume}" is not a non-negative number`);
    }

    const [open, high, low, close] = prices as [number, number, number, number];
    const candle: Candle = { date, open, high, low, close, volume };
    if (isValidCandle(candle)) candles.push(candle);
  }

  if (problems.length > 0) throw new CsvImportError(path, problems);
  return mergeCandles([], candles);
}

export interface ImportResult {
  symbol: string;
  /** Candles read from the CSV. */
  imported: number;
  /** How many of those replaced a cached candle with the same date. */
  replaced: number;
  /** Candles in the cache file afterwards. */
  total: number;
  cachePath: string;
}

/**
 * Imports daily candles from a CSV file into `<cacheDir>/<SYMBOL>.json`, so they are used
 * by data:check, FilePriceProvider and the backtester like downloaded data. Where the CSV
 * and the cache have the same date, the CSV wins. The whole file is rejected if any line
 * is invalid, so a bad file never half-applies.
 */
export async function importCsv(
  path: string,
  symbol: string,
  options: { cacheDir?: string } = {},
): Promise<ImportResult> {
  if (!isSupportedSymbol(symbol)) {
    throw new Error(`unsupported token "${symbol}"; supported: ${TOKEN_SYMBOLS.join(", ")}`);
  }
  const incoming = parseCsv(await readFile(path, "utf8"), path);
  const cachePath = cacheFile(options.cacheDir ?? defaultCacheDir(), symbol);
  const existing = await readCache(cachePath);
  const existingDates = new Set(existing.map((c) => c.date));
  const merged = mergeCandles(existing, incoming);
  await writeCache(cachePath, merged);
  return {
    symbol,
    imported: incoming.length,
    replaced: incoming.filter((c) => existingDates.has(c.date)).length,
    total: merged.length,
    cachePath,
  };
}

/** Splits one CSV row on commas, trimming whitespace and surrounding double quotes. */
function splitRow(line: string): string[] {
  return line.split(",").map((f) =>
    f
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim(),
  );
}
