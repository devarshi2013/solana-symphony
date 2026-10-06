import { z } from "zod";
import { DAY_MS, dayStartMs, toDate, type Candle } from "../candle.js";
import type { HttpClient } from "../http.js";
import type { HistoryProvider, TokenRef } from "./types.js";

// CoinGecko Pro API. Daily OHLC by date range is only on paid plans (Analyst and above);
// the free Demo plan is limited to the last 365 days and has no OHLC range endpoint.
// https://docs.coingecko.com/reference/coins-id-ohlc-range
export const COINGECKO_BASE_URL = "https://pro-api.coingecko.com/api/v3";

/** Conservative 30 requests/minute; every paid plan allows more. */
export const COINGECKO_MIN_INTERVAL_MS = 2000;

/** /ohlc/range returns at most 180 daily candles per request. */
export const COINGECKO_CHUNK_DAYS = 179;

/** Looks up CoinGecko's coin ID for a Solana mint. */
// https://docs.coingecko.com/reference/coins-contract-address
export function coinIdUrl(mint: string): string {
  return `${COINGECKO_BASE_URL}/coins/solana/contract/${mint}`;
}

/**
 * Daily OHLC for candles dated `from` to `to`. CoinGecko timestamps are candle close times,
 * so the candle for day D is stamped 00:00 UTC on D + 1.
 */
export function ohlcUrl(coinId: string, from: string, to: string): string {
  return `${COINGECKO_BASE_URL}/coins/${coinId}/ohlc/range?${rangeParams(from, to)}`;
}

/** Daily USD volumes over the same range (OHLC responses do not include volume). */
// https://docs.coingecko.com/reference/coins-id-market-chart-range
export function volumesUrl(coinId: string, from: string, to: string): string {
  return `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart/range?${rangeParams(from, to)}`;
}

function rangeParams(from: string, to: string): URLSearchParams {
  return new URLSearchParams({
    vs_currency: "usd",
    from: String((dayStartMs(from) + DAY_MS) / 1000),
    to: String((dayStartMs(to) + DAY_MS) / 1000),
    interval: "daily",
  });
}

export function parseCoinId(json: unknown): string {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(json);
  if (!parsed.success) throw new Error("unexpected CoinGecko coin lookup response: no id");
  return parsed.data.id;
}

/**
 * Parses /ohlc/range (`[closeTimeMs, open, high, low, close]` rows) into candles dated
 * `from` to `to`, joining `volumes` by close time. Rows not stamped at 00:00 UTC are
 * candles still forming and are skipped.
 */
export function parseOhlc(
  json: unknown,
  volumes: ReadonlyMap<number, number>,
  from: string,
  to: string,
): Candle[] {
  const parsed = z
    .array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]))
    .safeParse(json);
  if (!parsed.success)
    throw new Error(`unexpected CoinGecko OHLC response: ${parsed.error.message}`);

  const candles: Candle[] = [];
  for (const [closeMs, open, high, low, close] of parsed.data) {
    if (closeMs % DAY_MS !== 0) continue;
    const date = toDate(closeMs - DAY_MS);
    if (date < from || date > to) continue;
    candles.push({ date, open, high, low, close, volume: volumes.get(closeMs) ?? null });
  }
  return candles;
}

/** Parses /market_chart/range `total_volumes` into a map from timestamp to USD volume. */
export function parseVolumes(json: unknown): Map<number, number> {
  const parsed = z
    .object({ total_volumes: z.array(z.tuple([z.number(), z.number()])) })
    .safeParse(json);
  if (!parsed.success)
    throw new Error(`unexpected CoinGecko volume response: ${parsed.error.message}`);
  return new Map(parsed.data.total_volumes);
}

export function createCoinGeckoProvider(apiKey: string, http: HttpClient): HistoryProvider {
  const headers = { "x-cg-pro-api-key": apiKey, accept: "application/json" };
  const coinIds = new Map<string, string>();

  async function coinId(mint: string): Promise<string> {
    let id = coinIds.get(mint);
    if (!id) {
      id = parseCoinId(await http.getJson(coinIdUrl(mint), headers));
      coinIds.set(mint, id);
    }
    return id;
  }

  return {
    name: "coingecko",
    chunkDays: COINGECKO_CHUNK_DAYS,
    async fetchDaily(token: TokenRef, from: string, to: string) {
      const id = await coinId(token.mint);
      const volumes = parseVolumes(await http.getJson(volumesUrl(id, from, to), headers));
      return parseOhlc(await http.getJson(ohlcUrl(id, from, to), headers), volumes, from, to);
    },
  };
}
