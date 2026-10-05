// Public API of @solana-symphony/dsl. Anything not exported here is internal.

// Strategy language
export type {
  AssetNode,
  ComparisonOp,
  Condition,
  EqualWeightNode,
  FilterNode,
  GroupNode,
  IfNode,
  Indicator,
  IndicatorName,
  InverseVolatilityWeightNode,
  Node,
  NumberOperand,
  Operand,
  RebalanceFrequency,
  SpecifiedWeightNode,
  Strategy,
  WeightNode,
} from "./types.js";

// Validation
export {
  StrategySchema,
  validateStrategy,
  WEIGHT_SUM_TOLERANCE,
  WINDOW_MAX_DAYS,
  WINDOW_MIN_DAYS,
  type ValidationResult,
} from "./schema.js";

// Evaluation
export {
  evaluate,
  FALLBACK_SYMBOL,
  InvalidStrategyError,
  type EvaluationResult,
  type TraceStep,
} from "./evaluate.js";
export { describe } from "./describe.js";

// Price data
export { InMemoryPriceProvider, type DailyClose, type PriceProvider } from "./data.js";

// Indicators
export {
  computeIndicator,
  cumulativeReturn,
  ema,
  lookbackFor,
  maxDrawdown,
  rsi,
  sma,
  stdDevReturn,
} from "./indicators.js";

// Token registry
export {
  isSupportedSymbol,
  isTodo,
  TOKEN_SYMBOLS,
  TOKENS,
  type Todo,
  type TokenInfo,
  type TokenSymbol,
} from "./tokens.js";
