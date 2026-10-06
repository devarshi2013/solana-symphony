import { z } from "zod";
import { DAY_MS, dayStartMs, toDate, type Candle } from "../candle.js";
import type { HttpClient } from "../http.js";
import type { HistoryProvider, TokenRef } from "./types.js";

// Birdeye OHLCV V3. The V1 /defi/ohlcv endpoint is deprecated.
// https://data.birdeye.so/docs/data-api/price-ohlcv/get-defi-v3-ohlcv.md
export const BIRDEYE_OHLCV_URL = "https://public-api.birdeye.so/defi/v3/ohlcv";

/** The Standard (free) plan allows 1 request per second per account. */
// https://data.birdeye.so/docs/guides/api-access/rate-limiting/index.md
export const BIRDEYE_MIN_INTERVAL_MS = 1100;

/** V3 returns up to 5000 candles per request; 1000 days keeps requests small. */
export const BIRDEYE_CHUNK_DAYS = 1000;

const responseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z
    .object({
      items: z.array(
        z.object({
          o: z.number(),
          h: z.number(),
          l: z.number(),
          c: z.number(),
          v_usd: z.number().optional(),
          unix_time: z.number(),
        }),
      ),
    })
    .optional(),
});

/** Request URL for daily USD candles dated `from` to `to` inclusive. */
export function birdeyeUrl(mint: string, from: string, to: string): string {
  const params = new URLSearchParams({
    address: mint,
    type: "1D",
    currency: "usd",
    mode: "range",
    time_from: String(dayStartMs(from) / 1000),
    // through the end of `to`, so the candle opening at 00:00 on `to` is included
    time_to: String((dayStartMs(to) + DAY_MS) / 1000 - 1),
  });
  return `${BIRDEYE_OHLCV_URL}?${params}`;
}

/**
 * Parses a V3 OHLCV response into candles dated `from` to `to`. Each item's `unix_time` is
 * the candle's open time, which for 1D candles must be 00:00 UTC; anything else means the
 * response is not what we expect, so this throws rather than guess dates.
 */
export function parseBirdeye(json: unknown, from: string, to: string): Candle[] {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new Error(`unexpected Birdeye response: ${parsed.error.message}`);
  const { success, message, data } = parsed.data;
  if (success === false || !data) throw new Error(`Birdeye error: ${message ?? "no data"}`);

  const candles: Candle[] = [];
  for (const item of data.items) {
    const openMs = item.unix_time * 1000;
    if (openMs % DAY_MS !== 0) {
      throw new Error(
        `Birdeye 1D candle at ${new Date(openMs).toISOString()} is not aligned to 00:00 UTC`,
      );
    }
    const date = toDate(openMs);
    if (date < from || date > to) continue;
    candles.push({
      date,
      open: item.o,
      high: item.h,
      low: item.l,
      close: item.c,
      volume: item.v_usd ?? null,
    });
  }
  return candles;
}

export function createBirdeyeProvider(apiKey: string, http: HttpClient): HistoryProvider {
  const headers = { "X-API-KEY": apiKey, "x-chain": "solana", accept: "application/json" };
  return {
    name: "birdeye",
    chunkDays: BIRDEYE_CHUNK_DAYS,
    async fetchDaily(token: TokenRef, from: string, to: string) {
      return parseBirdeye(await http.getJson(birdeyeUrl(token.mint, from, to), headers), from, to);
    },
  };
}
