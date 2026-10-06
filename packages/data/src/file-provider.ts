import { InMemoryPriceProvider, TOKEN_SYMBOLS, type PriceProvider } from "@solana-symphony/dsl";
import { cacheFile, readCache } from "./cache.js";
import { defaultCacheDir } from "./paths.js";

/** The parts of a candle a CandlePriceProvider needs. */
export interface OpenClose {
  /** UTC calendar date, `"YYYY-MM-DD"`. */
  date: string;
  open: number;
  close: number;
}

/**
 * PriceProvider over daily candles held in memory, plus each day's open price for trading.
 *
 * Closes come from the dsl's InMemoryPriceProvider, so the same rules apply: a candle is
 * visible to getCloses only once its UTC day has closed. getOpen(symbol, D) returns the
 * price at 00:00 UTC on D, which is known at that moment.
 */
export class CandlePriceProvider implements PriceProvider {
  private readonly inner: InMemoryPriceProvider;
  private readonly opens = new Map<string, Map<string, number>>();
  /** Symbols with at least one candle. */
  readonly symbols: readonly string[];

  /**
   * @throws Error on an invalid or duplicate date, or an open or close that is not a
   *   positive finite number.
   */
  constructor(data: Readonly<Record<string, readonly OpenClose[]>>) {
    this.inner = new InMemoryPriceProvider(data);
    for (const [symbol, candles] of Object.entries(data)) {
      const bySymbol = new Map<string, number>();
      for (const { date, open } of candles) {
        if (!Number.isFinite(open) || open <= 0) {
          throw new Error(`${symbol} ${date}: open must be a positive number, got ${open}`);
        }
        bySymbol.set(date, open);
      }
      this.opens.set(symbol, bySymbol);
    }
    this.symbols = Object.keys(data).filter((s) => (data[s]?.length ?? 0) > 0);
  }

  getCloses(symbol: string, asOf: Date, lookbackDays: number): number[] | null {
    return this.inner.getCloses(symbol, asOf, lookbackDays);
  }

  /** Opening price on `date` (`"YYYY-MM-DD"`), or null if there is no candle that day. */
  getOpen(symbol: string, date: string): number | null {
    return this.opens.get(symbol)?.get(date) ?? null;
  }
}

/** CandlePriceProvider loaded from the candle cache in `data/cache/<SYMBOL>.json`. */
export class FilePriceProvider extends CandlePriceProvider {
  /**
   * Reads the cache files for `symbols` (default: every registry token). Missing files are
   * skipped, so lookups return null for those symbols.
   *
   * @throws Error if a file is corrupt or holds bad data (a non-positive price or a
   *   duplicate date). Run `pnpm data:check` to find the problem.
   */
  static async load(
    options: { cacheDir?: string; symbols?: readonly string[] } = {},
  ): Promise<FilePriceProvider> {
    const cacheDir = options.cacheDir ?? defaultCacheDir();
    const data: Record<string, OpenClose[]> = {};
    for (const symbol of options.symbols ?? TOKEN_SYMBOLS) {
      const candles = await readCache(cacheFile(cacheDir, symbol));
      if (candles.length > 0) data[symbol] = candles;
    }
    try {
      return new FilePriceProvider(data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`bad data in ${cacheDir}: ${reason}. Run \`pnpm data:check\` for details.`, {
        cause: err,
      });
    }
  }
}
