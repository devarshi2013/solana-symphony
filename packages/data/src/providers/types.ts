import type { Candle } from "../candle.js";

/** A token to download history for. */
export interface TokenRef {
  symbol: string;
  /** Mainnet SPL mint address. */
  mint: string;
}

/** A source of daily candles. */
export interface HistoryProvider {
  readonly name: string;
  /** Largest date range (in days) to request at once. */
  readonly chunkDays: number;
  /** Daily candles for `token` dated `from` to `to` inclusive (`"YYYY-MM-DD"`, UTC). */
  fetchDaily(token: TokenRef, from: string, to: string): Promise<Candle[]>;
}
