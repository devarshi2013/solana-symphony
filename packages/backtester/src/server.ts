import { createHash } from "node:crypto";
import cors from "@fastify/cors";
import { isSupportedSymbol, TOKEN_SYMBOLS, validateStrategy } from "@solana-symphony/dsl";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { runBenchmark } from "./benchmark.js";
import { compare } from "./compare.js";
import type { BacktestPriceProvider } from "./engine.js";

/** The web app's dev server. */
export const ALLOWED_ORIGINS = ["http://localhost:3000"];
export const CACHE_TTL_MS = 60 * 60 * 1000;
/** Caps memory: the oldest cached results are dropped beyond this many. */
export const CACHE_MAX_ENTRIES = 200;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date")
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "is not a real date");

const requestSchema = z.strictObject({
  strategy: z.unknown(),
  start: isoDate,
  end: isoDate,
  capital: z.number().positive(),
  benchmarks: z
    .array(
      z.string().superRefine((symbol, ctx) => {
        if (!isSupportedSymbol(symbol)) {
          ctx.addIssue({
            code: "custom",
            message: `unsupported token "${symbol}"; supported: ${TOKEN_SYMBOLS.join(", ")}`,
          });
        }
      }),
    )
    .max(8)
    .default(["SOL"]),
  feeBps: z.number().min(0).max(10_000).default(30),
  slippageBps: z.number().min(0).max(10_000).default(20),
});

export interface ServerOptions {
  provider: BacktestPriceProvider;
  /** Clock for cache expiry (tests inject one). */
  now?: () => number;
  logger?: FastifyServerOptions["logger"];
}

/**
 * Builds the backtest API.
 *
 * POST /backtest with `{ strategy, start, end, capital, benchmarks?, feeBps?, slippageBps? }`
 * runs the strategy and buy-and-hold benchmarks (default `["SOL"]`) and returns
 * `{ settings, comparison, backtests }`, the same shape as the CLI's results.json.
 *
 * - 400 `{ error: "invalid strategy", errors }` if validateStrategy rejects the strategy.
 * - 400 `{ error: "invalid request", errors }` for other bad input.
 * - Responses are cached for an hour, keyed by a hash of the normalised request (so key
 *   order does not matter); the `x-cache` header says HIT or MISS. Prices are loaded when
 *   the server starts, so restart it after fetching new data.
 */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { provider, now = Date.now } = options;
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] });

  const cache = new Map<string, { expires: number; body: unknown }>();

  app.get("/health", async () => ({ ok: true }));

  app.post("/backtest", async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid request",
        errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`),
      });
    }
    const validation = validateStrategy(parsed.data.strategy);
    if (!validation.ok) {
      return reply.code(400).send({ error: "invalid strategy", errors: validation.errors });
    }

    const { strategy } = validation;
    const { start, end, capital, benchmarks, feeBps, slippageBps } = parsed.data;
    const settings = { start, end, capital, feeBps, slippageBps, benchmarks };
    const key = hashKey({ strategy, settings });

    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      // Re-insert so frequently used entries are evicted last.
      cache.delete(key);
      cache.set(key, hit);
      return reply.header("x-cache", "HIT").send(hit.body);
    }

    const backtestOptions = { start, end, initialCapital: capital, feeBps, slippageBps };
    let body;
    try {
      const results = [
        runBenchmark(strategy, provider, backtestOptions),
        ...benchmarks.map((s) => runBenchmark(`buy-hold:${s}`, provider, backtestOptions)),
      ];
      const comparison = compare(results);
      body = {
        settings,
        comparison: {
          labels: comparison.labels,
          rows: comparison.rows,
          results: comparison.results,
        },
        backtests: results,
      };
    } catch (err) {
      // Bad options such as start after end surface as RangeErrors from the engine.
      if (err instanceof RangeError) {
        return reply.code(400).send({ error: "invalid request", errors: [err.message] });
      }
      throw err;
    }

    for (const [k, entry] of cache) if (entry.expires <= now()) cache.delete(k);
    cache.set(key, { expires: now() + CACHE_TTL_MS, body });
    while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    return reply.header("x-cache", "MISS").send(body);
  });

  return app;
}

/** SHA-256 of JSON with object keys sorted, so equivalent requests share a key. */
export function hashKey(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
