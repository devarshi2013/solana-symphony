import { describe, expect, it } from "vitest";
import { createHttpClient, HttpError } from "./http.js";

type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error;

/** A fake fetch that plays `replies` in order, plus a fake clock that sleep advances. */
function harness(replies: Reply[], options: { minIntervalMs?: number; backoffMs?: number } = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const requestTimes: number[] = [];
  const client = createHttpClient({
    minIntervalMs: options.minIntervalMs ?? 0,
    backoffMs: options.backoffMs ?? 1000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch: (async () => {
      requestTimes.push(clock);
      const reply = replies.shift();
      if (!reply) throw new Error("no more replies");
      if (reply instanceof Error) throw reply;
      return new Response(reply.body ?? "{}", {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    }) as typeof fetch,
  });
  return { client, sleeps, requestTimes, remaining: () => replies.length };
}

describe("createHttpClient", () => {
  it("returns parsed JSON", async () => {
    const { client } = harness([{ status: 200, body: '{"ok":true}' }]);
    await expect(client.getJson("https://x", {})).resolves.toEqual({ ok: true });
  });

  it("waits minIntervalMs between requests", async () => {
    const { client, requestTimes } = harness([{ status: 200 }, { status: 200 }, { status: 200 }], {
      minIntervalMs: 1100,
    });
    for (let i = 0; i < 3; i++) await client.getJson("https://x", {});
    expect(requestTimes).toEqual([0, 1100, 2200]);
  });

  it("retries 429 and 5xx with exponential backoff, then succeeds", async () => {
    const { client, sleeps } = harness([
      { status: 429 },
      { status: 503 },
      { status: 200, body: "[1]" },
    ]);
    await expect(client.getJson("https://x", {})).resolves.toEqual([1]);
    // backoff 1000ms, then 2000ms
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("honours a longer Retry-After header", async () => {
    const { client, sleeps } = harness([
      { status: 429, headers: { "retry-after": "5" } },
      { status: 200 },
    ]);
    await client.getJson("https://x", {});
    expect(sleeps).toEqual([5000]);
  });

  it("retries network errors", async () => {
    const { client } = harness([new TypeError("fetch failed"), { status: 200, body: "1" }]);
    await expect(client.getJson("https://x", {})).resolves.toBe(1);
  });

  it("gives up after 3 retries (4 attempts)", async () => {
    const { client, remaining } = harness([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200 },
    ]);
    await expect(client.getJson("https://x", {})).rejects.toThrow(
      "gave up after 4 attempts: HTTP 500 from https://x",
    );
    expect(remaining()).toBe(1);
  });

  it("does not retry other 4xx errors such as a bad API key", async () => {
    const { client, remaining } = harness([{ status: 401, body: "bad key" }, { status: 200 }]);
    const error = await client.getJson("https://x", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect(remaining()).toBe(1);
  });

  it("retries a response that is not valid JSON", async () => {
    const { client } = harness([
      { status: 200, body: "<html>" },
      { status: 200, body: "2" },
    ]);
    await expect(client.getJson("https://x", {})).resolves.toBe(2);
  });
});
