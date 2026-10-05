/**
 * Strategy language types, modelled on Composer's "symphonies".
 *
 * A strategy is a JSON logic tree. At each rebalance the tree is evaluated top-down: `if`
 * nodes pick a branch, `filter` nodes rank and pick children, `weight` nodes split the
 * allocation between children, and `asset` leaves receive the final weights.
 *
 * Units used throughout:
 * - Fields and indicators ending in "Pct" or described as percent use a 0–100 scale
 *   (`5` means 5%).
 * - Weights are fractions on a 0–1 scale (`0.25` means a quarter of the allocation).
 * - Windows are counted in days of price history.
 */

/** How often the vault is rebalanced back to the strategy's target weights. */
export type RebalanceFrequency = "daily" | "weekly" | "monthly" | "quarterly";

/** A complete strategy: metadata plus the logic tree that produces target weights. */
export interface Strategy {
  /** Stable unique identifier. Does not change when the strategy is edited. */
  id: string;
  /** Human-readable name shown in the builder and on the vault. */
  name: string;
  /** Free-text explanation of what the strategy does and why. */
  description: string;
  /** Version of the strategy format this document is written in, for future migrations. */
  version: number;
  /** Scheduled rebalance frequency. */
  rebalance: RebalanceFrequency;
  /**
   * Optional drift trigger, in percent. Between scheduled rebalances, if any asset's actual
   * weight differs from its target by more than this many percentage points, rebalance
   * early. Omit to rebalance only on schedule.
   */
  driftThresholdPct?: number;
  /** Root of the logic tree. */
  root: Node;
}

/** Any node in the logic tree, discriminated on `type`. */
export type Node = AssetNode | WeightNode | IfNode | FilterNode | GroupNode;

/** Leaf node: holds a single asset. Receives whatever weight its ancestors assign it. */
export interface AssetNode {
  type: "asset";
  /** Token symbol, e.g. `"SOL"` or `"JUP"`. Resolved to a mint address at execution time. */
  symbol: string;
}

/** Fields shared by every weighting mode. */
interface WeightNodeBase {
  type: "weight";
  /** Children that share this node's allocation. */
  children: Node[];
}

/** Splits the allocation evenly: each of n children gets 1/n. */
export interface EqualWeightNode extends WeightNodeBase {
  mode: "equal";
}

/** Splits the allocation by fixed weights. */
export interface SpecifiedWeightNode extends WeightNodeBase {
  mode: "specified";
  /**
   * Fraction of the allocation per child, in the same order as `children`. Must have one
   * entry per child, each non-negative, summing to 1 (within 0.0001).
   */
  weights: number[];
}

/**
 * Weights each child by the inverse of its return volatility, so calmer children get
 * more. Weights are normalised to sum to 1.
 */
export interface InverseVolatilityWeightNode extends WeightNodeBase {
  mode: "inverse-volatility";
  /** Days of returns used to measure each child's volatility, a whole number from 1 to 365. */
  window: number;
}

/**
 * Splits its allocation between children. Narrowed on `mode`: `weights` is only allowed
 * (and required) for `"specified"`, `window` only for `"inverse-volatility"`.
 */
export type WeightNode = EqualWeightNode | SpecifiedWeightNode | InverseVolatilityWeightNode;

/** Conditional branch: evaluates `condition` at each rebalance and follows one side. */
export interface IfNode {
  type: "if";
  /** Comparison evaluated against the latest available data. */
  condition: Condition;
  /** Followed when `condition` is true. Receives this node's full allocation. */
  then: Node;
  /** Followed when `condition` is false. Receives this node's full allocation. */
  else: Node;
}

/**
 * Ranks children by an indicator and keeps the best or worst few. The selected children
 * share this node's allocation equally; the rest get nothing.
 */
export interface FilterNode {
  type: "filter";
  /**
   * Indicator used to rank each child. Its `symbol` is ignored here: the indicator is
   * computed for each child instead.
   */
  sortBy: Indicator;
  /** `"top"` keeps the highest-ranked children, `"bottom"` the lowest. */
  order: "top" | "bottom";
  /** How many children to keep. A positive integer, at most `children.length`. */
  select: number;
  /** Candidates to rank. */
  children: Node[];
}

/** Named wrapper with no effect on weights. Used to label a sub-tree in the builder. */
export interface GroupNode {
  type: "group";
  /** Label shown in the builder, e.g. `"Risk-off basket"`. */
  name: string;
  /** The wrapped sub-tree. Receives this node's full allocation. */
  child: Node;
}

/** Comparison operator for a condition. */
export type ComparisonOp = ">" | "<" | ">=" | "<=";

/** A comparison between two values, e.g. "SOL price > SOL 200-day SMA". */
export interface Condition {
  /** Left-hand side of the comparison. */
  lhs: Operand;
  /** How to compare `lhs` with `rhs`. */
  op: ComparisonOp;
  /** Right-hand side of the comparison. */
  rhs: Operand;
}

/** A value in a condition: either a computed indicator or a constant. */
export type Operand = Indicator | NumberOperand;

/** A constant value in a condition. */
export interface NumberOperand {
  type: "number";
  /** The constant, in the same units as the indicator it is compared with. */
  value: number;
}

/**
 * Indicator names and what they compute:
 * - `price`: latest price. No window.
 * - `sma`: simple moving average of price over `window` days.
 * - `ema`: exponential moving average of price over `window` days.
 * - `rsi`: relative strength index over `window` days, on a 0–100 scale.
 * - `cumulativeReturn`: total return over the last `window` days, in percent.
 * - `stdDevReturn`: standard deviation of daily returns over `window` days, in percent.
 * - `maxDrawdown`: largest peak-to-trough fall over `window` days, in percent (positive).
 *
 * Prices are in the quote currency of the historical price data.
 */
export type IndicatorName =
  "price" | "sma" | "ema" | "rsi" | "cumulativeReturn" | "stdDevReturn" | "maxDrawdown";

/** A technical indicator computed from an asset's price history. */
export interface Indicator {
  type: "indicator";
  /** Which indicator to compute. See {@link IndicatorName}. */
  name: IndicatorName;
  /** Token symbol the indicator is computed for, e.g. `"SOL"`. */
  symbol: string;
  /**
   * Look-back period in days, a whole number from 1 to 365. Required by every indicator
   * except `price`, which ignores it.
   */
  window?: number;
}
