import { CandlePriceProvider } from "@solana-symphony/data";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BacktestPriceProvider } from "./engine.js";
import { buildServer, CACHE_TTL_MS, hashKey } from "./server.js";

const prices = new CandlePriceProvider({
  SOL: Array.from({ length: 40 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    close: 101 + i,
  })),
});

/** Counts price lookups, to tell whether a request actually ran a backtest. */
function countingProvider() {
  let calls = 0;
  const provider: BacktestPriceProvider = {
    getCloses: (...args) => (calls++, prices.getCloses(...args)),
    getOpen: (...args) => prices.getOpen(...args),
  };
  return { provider, calls: () => calls };
}

const strategy = {
  id: "half",
  name: "Half SOL",
  description: "",
  version: 1,
  rebalance: "daily",
  root: {
    type: "weight",
    mode: "equal",
    children: [
      { type: "asset", symbol: "SOL" },
      { type: "asset", symbol: "USDC" },
    ],
  },
};
const body = {
  strategy,
  start: "2024-01-05",
  end: "2024-02-05",
  capital: 1000,
  benchmarks: ["SOL", "USDC"],
};

let app: FastifyInstance;
let clock: number;
let counter: ReturnType<typeof countingProvider>;

beforeEach(async () => {
  clock = Date.UTC(2024, 2, 1);
  counter = countingProvider();
  app = await buildServer({ provider: counter.provider, now: () => clock });
});
afterEach(async () => {
  await app.close();
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/backtest", payload: payload as object, headers });

describe("POST /backtest", () => {
  it("returns results and metrics for the strategy and each benchmark", async () => {
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    const json = res.json();
    expect(json.settings).toEqual({
      start: "2024-01-05",
      end: "2024-02-05",
      capital: 1000,
      feeBps: 30,
      slippageBps: 20,
      benchmarks: ["SOL", "USDC"],
    });
    expect(json.comparison.labels).toEqual(["Half SOL", "Buy & hold SOL", "Buy & hold USDC"]);
    expect(json.comparison.results[0].metrics.totalReturn).toEqual(expect.any(Number));
    expect(
      json.comparison.rows.find((r: { metric: string }) => r.metric === "Sharpe"),
    ).toBeDefined();
    expect(json.backtests[0].result.equityCurve).toHaveLength(32);
  });

  it("defaults benchmarks to SOL and costs to 30/20 bps", async () => {
    const { strategy: s, start, end, capital } = body;
    const json = (await post({ strategy: s, start, end, capital })).json();
    expect(json.settings.benchmarks).toEqual(["SOL"]);
    expect(json.comparison.labels).toEqual(["Half SOL", "Buy & hold SOL"]);
  });

  it("returns 400 with validateStrategy's errors for an invalid strategy", async () => {
    const res = await post({
      ...body,
      strategy: { ...strategy, rebalance: "hourly", root: { type: "asset", symbol: "DOGE" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid strategy",
      errors: [
        'rebalance: Invalid option: expected one of "daily"|"weekly"|"monthly"|"quarterly"',
        'root.symbol: unsupported token "DOGE"; supported: SOL, USDC, JUP, JTO, BONK, JitoSOL, mSOL, WIF',
      ],
    });
  });

  it("returns 400 for a malformed request", async () => {
    const res = await post({
      strategy,
      start: "2024-02-30",
      capital: -5,
      benchmarks: ["DOGE"],
      extra: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid request");
    expect(res.json().errors).toEqual(
      expect.arrayContaining([
        "start: is not a real date",
        "end: Invalid input: expected string, received undefined",
        "capital: Too small: expected number to be >0",
        'benchmarks.0: unsupported token "DOGE"; supported: SOL, USDC, JUP, JTO, BONK, JitoSOL, mSOL, WIF',
        '(body): Unrecognized key: "extra"',
      ]),
    );
  });

  it("returns 400 when start is after end", async () => {
    const res = await post({ ...body, start: "2024-03-01", end: "2024-01-01" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid request",
      errors: ["start 2024-03-01 is after end 2024-01-01"],
    });
  });
});

describe("caching", () => {
  it("serves an identical request from cache without rerunning the backtest", async () => {
    const first = await post(body);
    const callsAfterFirst = counter.calls();
    const second = await post(body);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.json()).toEqual(first.json());
    expect(counter.calls()).toBe(callsAfterFirst);
  });

  it("treats requests that differ only in key order as the same", async () => {
    await post(body);
    const reordered = {
      capital: 1000,
      benchmarks: ["SOL", "USDC"],
      end: "2024-02-05",
      start: "2024-01-05",
      strategy: {
        root: strategy.root,
        rebalance: "daily",
        version: 1,
        description: "",
        name: "Half SOL",
        id: "half",
      },
    };
    expect((await post(reordered)).headers["x-cache"]).toBe("HIT");
  });

  it("misses for a different request", async () => {
    await post(body);
    expect((await post({ ...body, capital: 2000 })).headers["x-cache"]).toBe("MISS");
  });

  it("expires entries after one hour", async () => {
    await post(body);
    clock += CACHE_TTL_MS - 1;
    expect((await post(body)).headers["x-cache"]).toBe("HIT");
    clock += 1;
    expect((await post(body)).headers["x-cache"]).toBe("MISS");
  });

  it("hashes canonical JSON", () => {
    expect(hashKey({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(
      hashKey({ b: [1, { c: 3, d: 2 }], a: 1 }),
    );
    expect(hashKey({ a: [1, 2] })).not.toBe(hashKey({ a: [2, 1] }));
  });
});

describe("CORS", () => {
  it("allows the web app on localhost:3000", async () => {
    const res = await post(body, { origin: "http://localhost:3000" });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("answers the browser's preflight request", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/backtest",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("does not allow other origins", async () => {
    const res = await post(body, { origin: "https://evil.example" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

it("GET /health", async () => {
  expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
});
