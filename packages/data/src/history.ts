import { addDays, isValidCandle, mergeCandles } from "./candle.js";
import { cacheFile, readCache, writeCache } from "./cache.js";
import type { HistoryProvider, TokenRef } from "./providers/types.js";

export interface FetchHistoryOptions {
  tokens: readonly TokenRef[];
  provider: HistoryProvider;
  cacheDir: string;
  /** First date to download, `"YYYY-MM-DD"`. */
  start: string;
  /** Last date to download, normally the last complete UTC day. */
  end: string;
  log?: (message: string) => void;
}

export type TokenResult =
  | { symbol: string; status: "up-to-date"; lastDate: string | undefined }
  | { symbol: string; status: "updated"; added: number; lastDate: string | undefined }
  | { symbol: string; status: "failed"; added: number; error: string };

/**
 * Downloads daily candles for each token into `<cacheDir>/<SYMBOL>.json`.
 *
 * Resumes after the last cached date, requests the provider's chunk size at a time, and
 * saves after every chunk, so an interrupted run loses at most one chunk. Invalid candles
 * (non-positive or non-finite prices) are dropped with a warning. A token that fails does
 * not stop the others.
 */
export async function fetchHistory(options: FetchHistoryOptions): Promise<TokenResult[]> {
  const { tokens, provider, cacheDir, start, end, log = () => {} } = options;
  const results: TokenResult[] = [];

  for (const token of tokens) {
    const path = cacheFile(cacheDir, token.symbol);
    let added = 0;
    try {
      let candles = await readCache(path);
      const lastCached = candles.at(-1)?.date;
      const resumeFrom = lastCached ? addDays(lastCached, 1) : start;
      if (resumeFrom > end) {
        log(`${token.symbol}: up to date (last candle ${lastCached})`);
        results.push({ symbol: token.symbol, status: "up-to-date", lastDate: lastCached });
        continue;
      }
      log(`${token.symbol}: fetching ${resumeFrom} to ${end} from ${provider.name}`);

      for (let from = resumeFrom; from <= end; from = addDays(from, provider.chunkDays)) {
        const to = minDate(addDays(from, provider.chunkDays - 1), end);
        const fetched = await provider.fetchDaily(token, from, to);
        const inRange = fetched.filter((c) => c.date >= from && c.date <= to);
        const valid = inRange.filter(isValidCandle);
        if (valid.length < inRange.length) {
          log(
            `  ${token.symbol}: dropped ${inRange.length - valid.length} invalid candle(s) in ${from}..${to}`,
          );
        }
        const before = candles.length;
        candles = mergeCandles(candles, valid);
        added += candles.length - before;
        await writeCache(path, candles);
        log(`  ${from}..${to}: ${valid.length} candle(s)`);
      }

      results.push({
        symbol: token.symbol,
        status: "updated",
        added,
        lastDate: candles.at(-1)?.date,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${token.symbol}: FAILED: ${error}`);
      results.push({ symbol: token.symbol, status: "failed", added, error });
    }
  }
  return results;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
