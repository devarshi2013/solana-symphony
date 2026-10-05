import type { PriceProvider } from "./data.js";
import { computeIndicator } from "./indicators.js";
import { assertNever, formatNumber, isPercentIndicator as isPercent } from "./internal.js";
import { formatPath, validateStrategy } from "./schema.js";
import type {
  ComparisonOp,
  FilterNode,
  IfNode,
  Indicator,
  Node,
  Operand,
  Strategy,
  WeightNode,
} from "./types.js";

/** Where a branch's allocation goes when an indicator it needs has too little data. */
export const FALLBACK_SYMBOL = "USDC";

/** One decision made while evaluating, in plain words. */
export interface TraceStep {
  /** Location of the deciding node, e.g. `root.children[1]`. */
  path: string;
  /** What was decided and why, e.g. `SOL price 142.1 > SMA200 120.4 → then branch`. */
  message: string;
}

/** Thrown by `evaluate` when the strategy fails validation. */
export class InvalidStrategyError extends Error {
  override readonly name = "InvalidStrategyError";

  constructor(readonly errors: readonly string[]) {
    super(`Invalid strategy:\n${errors.join("\n")}`);
  }
}

export interface EvaluationResult {
  /**
   * Target weight per symbol: each above 0, summing to exactly 1 (in any order), largest
   * first. Weights are multiples of 2^-40, so may differ from exact fractions by under 1e-12.
   */
  weights: Record<string, number>;
  /** Decisions in the order they were made. */
  trace: TraceStep[];
}

/** Weight per symbol for one sub-tree. Sums to 1. */
type Allocation = Map<string, number>;
type Path = Array<string | number>;

interface Context {
  provider: PriceProvider;
  asOf: Date;
  trace: TraceStep[];
}

/**
 * Evaluates a strategy's tree as of `asOf` and returns target weights plus a trace of
 * every decision.
 *
 * - `asset`: 100% that symbol.
 * - `weight`: combines the children's allocations by equal, specified, or
 *   inverse-volatility weights.
 * - `if`: compares the condition's operands and evaluates only the chosen branch.
 * - `filter`: ranks children by `sortBy`, computed for each child's main asset (the
 *   asset with the largest weight in that child's allocation), and splits equally
 *   between the selected ones.
 * - `group`: passes its child through.
 *
 * If an indicator a node needs has too little data, that node's whole allocation goes to
 * USDC instead, and the trace says why. Sibling branches are unaffected.
 *
 * @throws InvalidStrategyError if `strategy` fails validateStrategy (checked on every call,
 *   since strategies often arrive as JSON cast to Strategy).
 * @throws RangeError if the provider returns a close that is not a positive finite number.
 */
export function evaluate(
  strategy: Strategy,
  provider: PriceProvider,
  asOf: Date,
): EvaluationResult {
  const validation = validateStrategy(strategy);
  if (!validation.ok) throw new InvalidStrategyError(validation.errors);

  const trace: TraceStep[] = [];
  const allocation = evaluateNode(strategy.root, ["root"], { provider, asOf, trace });
  return { weights: normalize(allocation), trace };
}

function evaluateNode(node: Node, path: Path, ctx: Context): Allocation {
  switch (node.type) {
    case "asset":
      return new Map([[node.symbol, 1]]);
    case "group":
      return evaluateNode(node.child, [...path, "child"], ctx);
    case "if":
      return evaluateIf(node, path, ctx);
    case "weight":
      return evaluateWeight(node, path, ctx);
    case "filter":
      return evaluateFilter(node, path, ctx);
    default:
      return assertNever(node, "node type");
  }
}

function evaluateIf(node: IfNode, path: Path, ctx: Context): Allocation {
  const { lhs, op, rhs } = node.condition;
  const lhsValue = operandValue(lhs, ctx);
  const rhsValue = operandValue(rhs, ctx);
  if (lhsValue === null) return fallback(ctx, path, lhs as Indicator);
  if (rhsValue === null) return fallback(ctx, path, rhs as Indicator);

  const holds = compare(lhsValue, op, rhsValue);
  const lhsText = describeOperand(lhs, lhsValue);
  const sharedSymbol = lhs.type === "indicator" ? lhs.symbol : undefined;
  const rhsText = describeOperand(rhs, rhsValue, sharedSymbol);
  record(
    ctx,
    path,
    holds
      ? `${lhsText} ${op} ${rhsText} → then branch`
      : `${lhsText} ${op} ${rhsText} is false → else branch`,
  );
  return holds
    ? evaluateNode(node.then, [...path, "then"], ctx)
    : evaluateNode(node.else, [...path, "else"], ctx);
}

function evaluateWeight(node: WeightNode, path: Path, ctx: Context): Allocation {
  if (node.children.length === 0)
    return fallbackWithReason(ctx, path, "weight node has no children");
  const children = node.children.map((child, i) =>
    evaluateNode(child, [...path, "children", i], ctx),
  );

  switch (node.mode) {
    case "equal":
      return combine(
        children,
        children.map(() => 1 / children.length),
      );
    case "specified":
      return combine(children, node.weights);
    case "inverse-volatility": {
      const scored = scoreChildren(
        children,
        {
          type: "indicator",
          name: "stdDevReturn",
          symbol: "",
          window: node.window,
        },
        ctx,
      );
      const missing = scored.find((s) => s.value === null);
      if (missing) return fallback(ctx, path, missing.indicator);

      const vols = scored.map((s) => s.value!);
      const zeroVol = vols.filter((v) => v === 0).length;
      const inverses = vols.map((v) => (zeroVol > 0 ? (v === 0 ? 1 : 0) : 1 / v));
      const total = inverses.reduce((sum, x) => sum + x, 0);
      const shares = inverses.map((x) => x / total);
      const parts = scored.map(
        (s, i) => `${s.symbol} ${formatNumber(vols[i]!)}% → ${formatShare(shares[i]!)}`,
      );
      record(ctx, path, `Inverse volatility (${node.window}d): ${parts.join(", ")}`);
      return combine(children, shares);
    }
    default:
      return assertNever(node, "weight mode");
  }
}

function evaluateFilter(node: FilterNode, path: Path, ctx: Context): Allocation {
  const children = node.children.map((child, i) =>
    evaluateNode(child, [...path, "children", i], ctx),
  );
  const scored = scoreChildren(children, node.sortBy, ctx);
  const missing = scored.find((s) => s.value === null);
  if (missing) return fallback(ctx, path, missing.indicator);

  const direction = node.order === "top" ? -1 : 1;
  const ranked = scored
    .map((s, index) => ({ ...s, index, value: s.value! }))
    .sort((a, b) => direction * (a.value - b.value) || a.index - b.index);
  const selected = ranked.slice(0, node.select);

  const unit = isPercent(node.sortBy.name) ? "%" : "";
  const ranking = ranked.map((s) => `${s.symbol} ${formatNumber(s.value)}${unit}`).join(", ");
  record(
    ctx,
    path,
    `Ranked by ${indicatorLabel(node.sortBy)} (${node.order} ${node.select} of ${children.length}): ` +
      `${ranking} → selected ${selected.map((s) => s.symbol).join(", ")}`,
  );

  const shares = children.map(() => 0);
  for (const s of selected) shares[s.index] = 1 / selected.length;
  return combine(children, shares);
}

/** Computes `indicator` for each child's main asset. */
function scoreChildren(children: Allocation[], indicator: Indicator, ctx: Context) {
  return children.map((allocation) => {
    const symbol = mainAsset(allocation);
    const forChild: Indicator = { ...indicator, symbol };
    return {
      symbol,
      indicator: forChild,
      value: computeIndicator(forChild, ctx.provider, ctx.asOf),
    };
  });
}

/** The asset with the largest weight; the first one found wins a tie. */
function mainAsset(allocation: Allocation): string {
  let best: [string, number] | undefined;
  for (const entry of allocation) if (!best || entry[1] > best[1]) best = entry;
  return best![0];
}

function combine(children: Allocation[], shares: readonly number[]): Allocation {
  const result: Allocation = new Map();
  children.forEach((allocation, i) => {
    const share = shares[i]!;
    if (share === 0) return;
    for (const [symbol, weight] of allocation) {
      result.set(symbol, (result.get(symbol) ?? 0) + weight * share);
    }
  });
  return result;
}

function fallback(ctx: Context, path: Path, indicator: Indicator): Allocation {
  return fallbackWithReason(ctx, path, `${describeIndicator(indicator)}: not enough price data`);
}

function fallbackWithReason(ctx: Context, path: Path, reason: string): Allocation {
  record(ctx, path, `${reason} → 100% ${FALLBACK_SYMBOL}`);
  return new Map([[FALLBACK_SYMBOL, 1]]);
}

function record(ctx: Context, path: Path, message: string): void {
  ctx.trace.push({ path: formatPath(path), message });
}

/** Final weights are whole multiples of 2^-40 (about 1e-12); see normalize. */
const WEIGHT_UNITS = 2 ** 40;

/**
 * Drops zero weights, scales to sum to 1, and orders largest first (ties by symbol).
 *
 * Each weight is rounded to a whole number of 2^-40 units, with leftover units going to the
 * largest remainders. Sums of such values are exact in floating point, so the weights add
 * up to exactly 1 in any order. Each weight moves by under 1e-12; weights that round to
 * zero are dropped.
 */
function normalize(allocation: Allocation): Record<string, number> {
  const entries = [...allocation].filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0 && Number.isFinite(total))) {
    throw new Error(`cannot normalize weights: total is ${total}`);
  }

  // Order by the unrounded weights, so a 1e-12 rounding difference never reorders them.
  const scaled = entries
    .map(([symbol, weight]) => {
      const exact = (weight / total) * WEIGHT_UNITS;
      return { symbol, exact, units: Math.floor(exact), remainder: exact - Math.floor(exact) };
    })
    .sort((a, b) => b.exact - a.exact || (a.symbol < b.symbol ? -1 : 1));
  let leftover = WEIGHT_UNITS - scaled.reduce((sum, e) => sum + e.units, 0);
  for (const entry of [...scaled].sort((a, b) => b.remainder - a.remainder)) {
    if (leftover <= 0) break;
    entry.units += 1;
    leftover -= 1;
  }

  const weights = scaled
    .filter((e) => e.units > 0)
    .map((e): [string, number] => [e.symbol, e.units / WEIGHT_UNITS]);
  const sum = weights.reduce((s, [, weight]) => s + weight, 0);
  if (sum !== 1) throw new Error(`weights sum to ${sum} after normalizing, expected exactly 1`);
  return Object.fromEntries(weights);
}

function operandValue(operand: Operand, ctx: Context): number | null {
  return operand.type === "number"
    ? operand.value
    : computeIndicator(operand, ctx.provider, ctx.asOf);
}

function compare(lhs: number, op: ComparisonOp, rhs: number): boolean {
  switch (op) {
    case ">":
      return lhs > rhs;
    case "<":
      return lhs < rhs;
    case ">=":
      return lhs >= rhs;
    case "<=":
      return lhs <= rhs;
    default:
      return assertNever(op, "comparison operator");
  }
}

/** e.g. "SOL price 142.1", or "SMA200 120.4" when the symbol matches the other side. */
function describeOperand(operand: Operand, value: number, omitSymbol?: string): string {
  if (operand.type === "number") return formatNumber(operand.value);
  const unit = isPercent(operand.name) ? "%" : "";
  const label =
    operand.symbol === omitSymbol ? indicatorLabel(operand) : describeIndicator(operand);
  return `${label} ${formatNumber(value)}${unit}`;
}

/** e.g. "SOL SMA200". */
function describeIndicator(indicator: Indicator): string {
  return `${indicator.symbol} ${indicatorLabel(indicator)}`;
}

/** e.g. "price", "SMA200", "RSI14", "30d return". */
function indicatorLabel({ name, window }: Indicator): string {
  switch (name) {
    case "price":
      return "price";
    case "sma":
      return `SMA${window}`;
    case "ema":
      return `EMA${window}`;
    case "rsi":
      return `RSI${window}`;
    case "cumulativeReturn":
      return `${window}d return`;
    case "stdDevReturn":
      return `${window}d volatility`;
    case "maxDrawdown":
      return `${window}d max drawdown`;
    default:
      return assertNever(name, "indicator");
  }
}

/** A 0–1 share as a percent with one decimal: 0.3333 → "33.3%". */
function formatShare(share: number): string {
  return `${Number((share * 100).toFixed(1))}%`;
}
