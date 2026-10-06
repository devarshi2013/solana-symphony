import {
  evaluate,
  FALLBACK_SYMBOL,
  type PriceProvider,
  type RebalanceFrequency,
  type Strategy,
} from "@solana-symphony/dsl";

/** The cash asset. Capital starts here, and it is valued at exactly 1. */
export const CASH_SYMBOL = "USDC";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Trades smaller than this fraction of portfolio value are skipped as rounding dust. */
const DUST = 1e-9;

/** Prices for backtesting: closes for the strategy (no look-ahead) plus opens to trade at. */
export interface BacktestPriceProvider extends PriceProvider {
  /** Opening price on `date` (`"YYYY-MM-DD"`, 00:00 UTC), or null if unknown. */
  getOpen(symbol: string, date: string): number | null;
}

export interface BacktestOptions {
  /** First trading day, `"YYYY-MM-DD"` (UTC). */
  start: string;
  /** Last trading day, inclusive. */
  end: string;
  /** Starting capital, held in USDC. */
  initialCapital: number;
  /** Fee per trade in basis points of notional. Default 30 (0.3%). */
  feeBps?: number;
  /** Slippage per trade in basis points of the open price. Default 20 (0.2%). */
  slippageBps?: number;
}

export interface Trade {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  /** Token units bought or sold. */
  amount: number;
  /** Execution price in USDC per token, including slippage. */
  price: number;
  /** Fee paid in USDC. */
  fee: number;
}

export type RebalanceReason = "initial" | "scheduled" | "drift";

export interface Rebalance {
  date: string;
  reason: RebalanceReason;
  /** The strategy's target weights. */
  target: Record<string, number>;
  /** The strategy's decisions, as evaluate() reported them. */
  trace: Array<{ path: string; message: string }>;
  /**
   * Trace messages where a branch fell back to USDC because an indicator lacked price
   * history (e.g. a token not yet listed). Empty when the strategy ran as written.
   */
  fallbacks: string[];
}

export interface BacktestResult {
  /** Starting capital in USDC, i.e. the value before the first day. */
  initialCapital: number;
  /** Portfolio value in USDC at each day's close. */
  equityCurve: Array<{ date: string; value: number }>;
  /** Actual weights at each day's close, largest first. */
  holdings: Array<{ date: string; weights: Record<string, number> }>;
  trades: Trade[];
  /** Fees paid, in USDC. */
  totalFees: number;
  /** Value lost to slippage versus trading at the open, in USDC. */
  totalSlippage: number;
  /** Each executed rebalance, with why it happened and the strategy's target weights. */
  rebalances: Rebalance[];
  /** Things that did not go as planned, such as a rebalance postponed for missing prices. */
  warnings: string[];
}

/**
 * Simulates `strategy` day by day from `start` to `end`.
 *
 * Each day:
 * 1. Decide whether to rebalance: on the first day, on scheduled days for
 *    `strategy.rebalance` (weekly = Mondays, monthly = the 1st, quarterly = 1 Jan/Apr/Jul/Oct,
 *    all UTC), or, if `driftThresholdPct` is set, when any weight at the previous close is
 *    more than that many percentage points from the last target.
 * 2. To rebalance, evaluate the strategy at 00:00 UTC, when only closes up to the previous
 *    day exist, then trade at today's open: sells first, then buys with the proceeds.
 *    Slippage worsens the execution price and the fee is charged on each trade's notional.
 *    If costs leave too little cash, buys are scaled down proportionally.
 * 3. Value the holdings (token units) at today's close.
 *
 * If a needed open price is missing, the rebalance is postponed to the next day and a
 * warning is recorded. A missing close is carried forward from the last known price.
 *
 * @throws InvalidStrategyError if the strategy is invalid; RangeError on bad options.
 */
export function runBacktest(
  strategy: Strategy,
  provider: BacktestPriceProvider,
  options: BacktestOptions,
): BacktestResult {
  const { start, end, initialCapital, feeBps = 30, slippageBps = 20 } = options;
  validateOptions(start, end, initialCapital, feeBps, slippageBps);
  const fee = feeBps / 10_000;
  const slip = slippageBps / 10_000;

  const units = new Map<string, number>([[CASH_SYMBOL, initialCapital]]);
  const lastPrice = new Map<string, number>();
  const result: BacktestResult = {
    initialCapital,
    equityCurve: [],
    holdings: [],
    trades: [],
    totalFees: 0,
    totalSlippage: 0,
    rebalances: [],
    warnings: [],
  };

  let pending: RebalanceReason | null = "initial";
  let lastTarget: Record<string, number> | undefined;
  let previousCloseWeights: Record<string, number> | undefined;

  for (let date = start; date <= end; date = addDays(date, 1)) {
    let reason: RebalanceReason | null = pending;
    if (!reason && isScheduledRebalance(date, strategy.rebalance)) reason = "scheduled";
    if (
      !reason &&
      strategy.driftThresholdPct !== undefined &&
      lastTarget &&
      previousCloseWeights &&
      maxDrift(previousCloseWeights, lastTarget) * 100 > strategy.driftThresholdPct
    ) {
      reason = "drift";
    }

    if (reason) {
      // At 00:00 UTC the latest visible close is the previous day's.
      const { weights: target, trace } = evaluate(strategy, provider, new Date(dayStartMs(date)));
      const missing = rebalance(date, target);
      if (missing.length === 0) {
        const fallbacks = trace
          .filter((t) => t.message.endsWith(`→ 100% ${FALLBACK_SYMBOL}`))
          .map((t) => `${t.path}: ${t.message}`);
        result.rebalances.push({ date, reason, target, trace, fallbacks });
        lastTarget = target;
        pending = null;
      } else {
        result.warnings.push(
          `${date}: ${reason} rebalance postponed, no open price for ${missing.join(", ")}`,
        );
        pending = reason;
      }
    }

    // Close of `date` is visible from 00:00 UTC the next day.
    const closeAsOf = new Date(dayStartMs(date) + DAY_MS);
    const values = new Map<string, number>();
    for (const [symbol, amount] of units) {
      values.set(symbol, amount * priceAtClose(symbol, date, closeAsOf));
    }
    const total = sum(values.values());
    result.equityCurve.push({ date, value: total });
    previousCloseWeights = toWeights(values, total);
    result.holdings.push({ date, weights: previousCloseWeights });
  }
  return result;

  /** Trades to `target` at `date`'s open. Returns symbols lacking an open price (no trades then). */
  function rebalance(date: string, target: Record<string, number>): string[] {
    const symbols = [...new Set([...units.keys(), ...Object.keys(target)])]
      .filter((s) => s !== CASH_SYMBOL)
      .sort();
    const opens = new Map<string, number>();
    const missing: string[] = [];
    for (const symbol of symbols) {
      const open = provider.getOpen(symbol, date);
      if (open === null) missing.push(symbol);
      else opens.set(symbol, open);
    }
    if (missing.length > 0) return missing;
    for (const [symbol, open] of opens) lastPrice.set(symbol, open);

    const cash = () => units.get(CASH_SYMBOL) ?? 0;
    const held = (symbol: string) => units.get(symbol) ?? 0;
    const portfolio = cash() + sum(symbols.map((s) => held(s) * opens.get(s)!));
    const targetValue = (symbol: string) => (target[symbol] ?? 0) * portfolio;

    // Sells first, so their proceeds can fund the buys.
    for (const symbol of symbols) {
      const open = opens.get(symbol)!;
      const excess = held(symbol) * open - targetValue(symbol);
      if (excess <= DUST * portfolio) continue;
      const amount = targetValue(symbol) === 0 ? held(symbol) : excess / open;
      const price = open * (1 - slip);
      const notional = amount * price;
      const cost = notional * fee;
      units.set(symbol, held(symbol) - amount);
      units.set(CASH_SYMBOL, cash() + notional - cost);
      record(date, symbol, "sell", amount, price, cost, amount * open * slip);
    }

    // Buys, scaled down together if fees and slippage leave too little cash.
    const wants = symbols
      .map((symbol) => ({ symbol, value: targetValue(symbol) - held(symbol) * opens.get(symbol)! }))
      .filter((w) => w.value > DUST * portfolio);
    const needed = sum(wants.map((w) => w.value * (1 + slip) * (1 + fee)));
    const spendable = Math.max(0, cash() - targetValue(CASH_SYMBOL));
    const scale = needed > spendable ? spendable / needed : 1;
    for (const { symbol, value } of wants) {
      const open = opens.get(symbol)!;
      const amount = (value * scale) / open;
      if (amount * open <= DUST * portfolio) continue;
      const price = open * (1 + slip);
      const notional = amount * price;
      const cost = notional * fee;
      units.set(symbol, held(symbol) + amount);
      units.set(CASH_SYMBOL, cash() - notional - cost);
      record(date, symbol, "buy", amount, price, cost, amount * open * slip);
    }

    // Clear rounding dust so sold-out positions disappear.
    for (const [symbol, amount] of units) {
      const value = symbol === CASH_SYMBOL ? amount : amount * (opens.get(symbol) ?? 0);
      if (Math.abs(value) <= DUST * portfolio) units.delete(symbol);
    }
    return [];
  }

  function record(
    date: string,
    symbol: string,
    side: "buy" | "sell",
    amount: number,
    price: number,
    cost: number,
    slippage: number,
  ): void {
    result.trades.push({ date, symbol, side, amount, price, fee: cost });
    result.totalFees += cost;
    result.totalSlippage += slippage;
  }

  function priceAtClose(symbol: string, date: string, closeAsOf: Date): number {
    if (symbol === CASH_SYMBOL) return 1;
    const close = provider.getCloses(symbol, closeAsOf, 1)?.[0];
    if (close !== undefined) {
      lastPrice.set(symbol, close);
      return close;
    }
    const fallback = lastPrice.get(symbol);
    if (fallback === undefined)
      throw new Error(`${date}: no price at all for held token ${symbol}`);
    result.warnings.push(`${date}: no close for ${symbol}, valued at last known price ${fallback}`);
    return fallback;
  }
}

/** Whether `date` is a scheduled rebalance day for `frequency` (UTC calendar). */
export function isScheduledRebalance(date: string, frequency: RebalanceFrequency): boolean {
  const day = new Date(dayStartMs(date));
  switch (frequency) {
    case "daily":
      return true;
    case "weekly":
      return day.getUTCDay() === 1;
    case "monthly":
      return day.getUTCDate() === 1;
    case "quarterly":
      return day.getUTCDate() === 1 && day.getUTCMonth() % 3 === 0;
    default:
      throw new Error(`unknown rebalance frequency: ${String(frequency)}`);
  }
}

/** Largest absolute difference between two weight maps, as a fraction. */
function maxDrift(actual: Record<string, number>, target: Record<string, number>): number {
  const symbols = new Set([...Object.keys(actual), ...Object.keys(target)]);
  let max = 0;
  for (const s of symbols) max = Math.max(max, Math.abs((actual[s] ?? 0) - (target[s] ?? 0)));
  return max;
}

function toWeights(values: Map<string, number>, total: number): Record<string, number> {
  return Object.fromEntries(
    [...values]
      .filter(([, value]) => value > 0)
      .map(([symbol, value]): [string, number] => [symbol, value / total])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  );
}

function validateOptions(
  start: string,
  end: string,
  initialCapital: number,
  feeBps: number,
  slippageBps: number,
): void {
  for (const [name, date] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || addDays(date, 0) !== date) {
      throw new RangeError(`${name} must be a YYYY-MM-DD date, got "${date}"`);
    }
  }
  if (start > end) throw new RangeError(`start ${start} is after end ${end}`);
  if (!(Number.isFinite(initialCapital) && initialCapital > 0)) {
    throw new RangeError(`initialCapital must be a positive number, got ${initialCapital}`);
  }
  for (const [name, bps] of [
    ["feeBps", feeBps],
    ["slippageBps", slippageBps],
  ] as const) {
    if (!(Number.isFinite(bps) && bps >= 0 && bps < 10_000)) {
      throw new RangeError(`${name} must be between 0 and 10000, got ${bps}`);
    }
  }
}

function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function addDays(date: string, days: number): string {
  const ms = dayStartMs(date);
  return Number.isNaN(ms) ? "" : new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
