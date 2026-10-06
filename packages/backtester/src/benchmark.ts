import type { Strategy } from "@solana-symphony/dsl";
import {
  runBacktest,
  type BacktestOptions,
  type BacktestPriceProvider,
  type BacktestResult,
} from "./engine.js";

/** `"buy-hold:<SYMBOL>"` (e.g. `"buy-hold:SOL"`, `"buy-hold:USDC"`) or any strategy. */
export type Benchmark = `buy-hold:${string}` | Strategy;

/** A backtest result with a name for comparison tables. */
export interface LabeledResult {
  label: string;
  result: BacktestResult;
}

/**
 * Runs a benchmark over the same dates, capital and costs as a strategy backtest.
 *
 * Buy-and-hold benchmarks run through the same engine as a one-asset strategy, so they pay
 * the same fee and slippage on their first purchase and trade at the next open just like
 * the strategy. They never trade again: the target stays 100% of one asset. If the asset
 * has no price yet on the first day, the purchase waits until it does (see `warnings`).
 *
 * @throws Error for a malformed benchmark string; InvalidStrategyError for an unsupported
 *   token or invalid strategy.
 */
export function runBenchmark(
  benchmark: Benchmark,
  provider: BacktestPriceProvider,
  options: BacktestOptions,
): LabeledResult {
  if (typeof benchmark !== "string") {
    return { label: benchmark.name, result: runBacktest(benchmark, provider, options) };
  }
  const match = /^buy-hold:(.+)$/.exec(benchmark);
  if (!match) {
    throw new Error(`unknown benchmark "${benchmark}"; use "buy-hold:<SYMBOL>" or a strategy`);
  }
  const symbol = match[1]!;
  const strategy: Strategy = {
    id: `buy-hold-${symbol}`,
    name: `Buy & hold ${symbol}`,
    description: `Buy ${symbol} on the first day and hold it.`,
    version: 1,
    rebalance: "quarterly",
    root: { type: "asset", symbol },
  };
  return { label: strategy.name, result: runBacktest(strategy, provider, options) };
}
