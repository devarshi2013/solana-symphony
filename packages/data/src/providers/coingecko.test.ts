import { describe, expect, it } from "vitest";
import type { HttpClient } from "../http.js";
import {
  coinIdUrl,
  createCoinGeckoProvider,
  ohlcUrl,
  parseCoinId,
  parseOhlc,
  parseVolumes,
  volumesUrl,
} from "./coingecko.js";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
// Close times in ms: the 2024-01-01 candle closes at 2024-01-02T00:00Z, and so on.
const CLOSE_JAN1 = Date.UTC(2024, 0, 2);
const CLOSE_JAN2 = Date.UTC(2024, 0, 3);
const DAY_MS = 86_400_000;

// [closeTime, open, high, low, close], per the /ohlc/range docs
const ohlc = [
  [CLOSE_JAN1, 0.5, 0.6, 0.45, 0.55],
  [CLOSE_JAN2, 0.55, 0.7, 0.5, 0.68],
  // still forming: stamped at the current time, not midnight
  [CLOSE_JAN2 + 5 * 3600 * 1000, 0.68, 0.69, 0.66, 0.67],
];
const marketChart = {
  prices: [],
  market_caps: [],
  total_volumes: [
    [CLOSE_JAN1, 1_000_000],
    [CLOSE_JAN2, 2_000_000],
  ],
};

describe("URLs", () => {
  it("looks up the coin by Solana mint on the Pro API", () => {
    expect(coinIdUrl(JUP)).toBe(
      `https://pro-api.coingecko.com/api/v3/coins/solana/contract/${JUP}`,
    );
  });

  it("asks for the close times of the requested days", () => {
    // candles for Jan 1..Jan 2 close at Jan 2 00:00 .. Jan 3 00:00
    for (const url of [
      ohlcUrl("jupiter", "2024-01-01", "2024-01-02"),
      volumesUrl("jupiter", "2024-01-01", "2024-01-02"),
    ]) {
      const params = Object.fromEntries(new URL(url).searchParams);
      expect(params).toEqual({
        vs_currency: "usd",
        from: String(CLOSE_JAN1 / 1000),
        to: String(CLOSE_JAN2 / 1000),
        interval: "daily",
      });
    }
    expect(new URL(ohlcUrl("jupiter", "2024-01-01", "2024-01-02")).pathname).toBe(
      "/api/v3/coins/jupiter/ohlc/range",
    );
  });
});

describe("parseOhlc", () => {
  it("dates each candle by the day before its close time and joins volume", () => {
    expect(parseOhlc(ohlc, parseVolumes(marketChart), "2024-01-01", "2024-01-31")).toEqual([
      { date: "2024-01-01", open: 0.5, high: 0.6, low: 0.45, close: 0.55, volume: 1_000_000 },
      { date: "2024-01-02", open: 0.55, high: 0.7, low: 0.5, close: 0.68, volume: 2_000_000 },
    ]);
  });

  it("skips a candle still forming and leaves volume null when missing", () => {
    const candles = parseOhlc(ohlc, new Map(), "2024-01-01", "2024-01-31");
    expect(candles.map((c) => c.date)).toEqual(["2024-01-01", "2024-01-02"]);
    expect(candles.every((c) => c.volume === null)).toBe(true);
  });

  it("drops candles outside the requested dates", () => {
    expect(parseOhlc(ohlc, new Map(), "2024-01-02", "2024-01-02").map((c) => c.date)).toEqual([
      "2024-01-02",
    ]);
  });

  it("throws on an unexpected shape", () => {
    expect(() => parseOhlc({ error: "x" }, new Map(), "a", "b")).toThrow(
      "unexpected CoinGecko OHLC response",
    );
  });
});

describe("parseCoinId", () => {
  it("reads the id field", () => {
    expect(parseCoinId({ id: "jupiter-exchange-solana", symbol: "jup" })).toBe(
      "jupiter-exchange-solana",
    );
    expect(() => parseCoinId({ error: "coin not found" })).toThrow("no id");
  });
});

describe("createCoinGeckoProvider", () => {
  it("resolves the coin id once, then fetches volumes and OHLC per chunk", async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      getJson: async (url, headers) => {
        expect(headers["x-cg-pro-api-key"]).toBe("secret");
        urls.push(url);
        if (url.includes("/contract/")) return { id: "jupiter-exchange-solana" };
        if (url.includes("/market_chart/range")) return marketChart;
        return ohlc;
      },
    };
    const provider = createCoinGeckoProvider("secret", http);
    const token = { symbol: "JUP", mint: JUP };
    expect(await provider.fetchDaily(token, "2024-01-01", "2024-01-02")).toHaveLength(2);
    await provider.fetchDaily(token, "2024-01-03", "2024-01-04");
    expect(urls.filter((u) => u.includes("/contract/"))).toHaveLength(1);
    expect(urls).toHaveLength(5);
  });

  it("uses a chunk size within the 180-candle limit", () => {
    const provider = createCoinGeckoProvider("k", { getJson: async () => null });
    expect(provider.chunkDays).toBeLessThanOrEqual(180);
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
