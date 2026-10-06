// Backtest engine: simulates a strategy day by day over historical prices.
export {
  CASH_SYMBOL,
  isScheduledRebalance,
  runBacktest,
  type BacktestOptions,
  type BacktestPriceProvider,
  type BacktestResult,
  type Rebalance,
  type RebalanceReason,
  type Trade,
} from "./engine.js";
export {
  computeMetrics,
  computeTurnover,
  DAYS_PER_YEAR,
  type DatedReturn,
  type Drawdown,
  type EquityPoint,
  type Metrics,
  type MetricsOptions,
  type Turnover,
} from "./metrics.js";
export { runBenchmark, type Benchmark, type LabeledResult } from "./benchmark.js";
export {
  compare,
  correlation,
  formatComparison,
  type Comparison,
  type ComparedResult,
  type ComparisonRow,
} from "./compare.js";
export { main as runBacktestCommand, strategySymbols, USAGE } from "./command.js";
export {
  CHART_JS_INTEGRITY,
  CHART_JS_URL,
  drawdownSeries,
  renderReport,
  type ReportInput,
} from "./report.js";
