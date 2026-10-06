import { describe, expect, it } from "vitest";
import type { HttpClient } from "../http.js";
import { birdeyeUrl, createBirdeyeProvider, parseBirdeye } from "./birdeye.js";

const SOL = "So11111111111111111111111111111111111111112";
// 2024-01-01T00:00:00Z and the next two days, in seconds
const JAN1 = 1704067200;
const DAY = 86400;

// Shape from the OHLCV V3 docs example, with 1D candles.
const response = {
  success: true,
  data: {
    is_scaled_ui_token: false,
    items: [
      {
        o: 100,
        h: 110,
        l: 95,
        c: 105,
        v: 1000,
        v_usd: 105000,
        unix_time: JAN1,
        address: SOL,
        type: "1D",
        currency: "usd",
      },
      {
        o: 105,
        h: 120,
        l: 104,
        c: 118,
        v: 2000,
        v_usd: 236000,
        unix_time: JAN1 + DAY,
        address: SOL,
        type: "1D",
        currency: "usd",
      },
      {
        o: 118,
        h: 119,
        l: 90,
        c: 92,
        v: 3000,
        unix_time: JAN1 + 2 * DAY,
        address: SOL,
        type: "1D",
        currency: "usd",
      },
    ],
  },
};

describe("birdeyeUrl", () => {
  it("requests daily USD candles from the start of `from` to the end of `to`", () => {
    const url = new URL(birdeyeUrl(SOL, "2024-01-01", "2024-01-03"));
    expect(url.origin + url.pathname).toBe("https://public-api.birdeye.so/defi/v3/ohlcv");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      address: SOL,
      type: "1D",
      currency: "usd",
      mode: "range",
      time_from: String(JAN1),
      time_to: String(JAN1 + 3 * DAY - 1),
    });
  });
});

describe("parseBirdeye", () => {
  it("maps items to candles dated by their 00:00 UTC open time", () => {
    expect(parseBirdeye(response, "2024-01-01", "2024-01-03")).toEqual([
      { date: "2024-01-01", open: 100, high: 110, low: 95, close: 105, volume: 105000 },
      { date: "2024-01-02", open: 105, high: 120, low: 104, close: 118, volume: 236000 },
      // no v_usd -> volume unknown
      { date: "2024-01-03", open: 118, high: 119, low: 90, close: 92, volume: null },
    ]);
  });

  it("drops candles outside the requested dates", () => {
    expect(parseBirdeye(response, "2024-01-02", "2024-01-02").map((c) => c.date)).toEqual([
      "2024-01-02",
    ]);
  });

  it("throws on candles not aligned to midnight instead of guessing dates", () => {
    const shifted = {
      success: true,
      data: { items: [{ o: 1, h: 1, l: 1, c: 1, unix_time: JAN1 + 3600 }] },
    };
    expect(() => parseBirdeye(shifted, "2024-01-01", "2024-01-02")).toThrow(
      "Birdeye 1D candle at 2024-01-01T01:00:00.000Z is not aligned to 00:00 UTC",
    );
  });

  it("throws on an error response", () => {
    expect(() => parseBirdeye({ success: false, message: "Unauthorized" }, "a", "b")).toThrow(
      "Birdeye error: Unauthorized",
    );
  });

  it("throws on an unexpected shape", () => {
    expect(() => parseBirdeye({ data: { items: [{ o: "1" }] } }, "a", "b")).toThrow(
      "unexpected Birdeye response",
    );
  });
});

describe("createBirdeyeProvider", () => {
  it("sends the API key and chain headers", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const http: HttpClient = {
      getJson: async (url, headers) => {
        calls.push({ url, headers });
        return response;
      },
    };
    const candles = await createBirdeyeProvider("secret", http).fetchDaily(
      { symbol: "SOL", mint: SOL },
      "2024-01-01",
      "2024-01-03",
    );
    expect(candles).toHaveLength(3);
    expect(calls[0]!.headers).toEqual({
      "X-API-KEY": "secret",
      "x-chain": "solana",
      accept: "application/json",
    });
  });
});
