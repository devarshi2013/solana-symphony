// Historical price data: daily candles, the on-disk cache, and the history fetcher.
export {
  addDays,
  DAY_MS,
  isIsoDate,
  isValidCandle,
  lastCompleteDay,
  mergeCandles,
  type Candle,
} from "./candle.js";
export { cacheFile, readCache, writeCache } from "./cache.js";
export { fetchHistory, type FetchHistoryOptions, type TokenResult } from "./history.js";
export { createHttpClient, HttpError, type HttpClient, type HttpClientOptions } from "./http.js";
export { createBirdeyeProvider } from "./providers/birdeye.js";
export { createCoinGeckoProvider } from "./providers/coingecko.js";
export type { HistoryProvider, TokenRef } from "./providers/types.js";
export {
  analyzeCandles,
  BIG_MOVE_THRESHOLD,
  checkData,
  formatReport,
  type BigMove,
  type DataReport,
  type DateRange,
} from "./check.js";
export { CsvImportError, importCsv, parseCsv, type ImportResult } from "./csv.js";
export { CandlePriceProvider, FilePriceProvider, type OpenClose } from "./file-provider.js";
export { defaultCacheDir, findWorkspaceRoot } from "./paths.js";
