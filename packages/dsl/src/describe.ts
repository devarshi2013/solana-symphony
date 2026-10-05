import { assertNever, formatNumber, isPercentIndicator } from "./internal.js";
import type {
  ComparisonOp,
  FilterNode,
  Indicator,
  Node,
  Operand,
  Strategy,
  WeightNode,
} from "./types.js";

const INDENT = "  ";

/**
 * Describes a strategy in indented plain English, one decision per line, e.g.
 *
 * ```text
 * Rebalances daily.
 * If the price of SOL is above its 100-day moving average:
 *   Hold SOL.
 * Otherwise:
 *   Hold USDC.
 * ```
 */
export function describe(strategy: Strategy): string {
  return [describeSchedule(strategy), ...describeNode(strategy.root)].join("\n");
}

function describeSchedule({ rebalance, driftThresholdPct }: Strategy): string {
  if (driftThresholdPct === undefined) return `Rebalances ${rebalance}.`;
  return (
    `Rebalances ${rebalance}, or sooner if any weight drifts more than ` +
    `${formatNumber(driftThresholdPct)} percentage points from its target.`
  );
}

function describeNode(node: Node): string[] {
  switch (node.type) {
    case "asset":
      return [`Hold ${node.symbol}.`];
    case "group":
      return node.name === ""
        ? describeNode(node.child)
        : [`${node.name}:`, ...indent(describeNode(node.child))];
    case "if": {
      const { lhs, op, rhs } = node.condition;
      return [
        `If ${describeComparison(lhs, op, rhs)}:`,
        ...indent(describeNode(node.then)),
        "Otherwise:",
        ...indent(describeNode(node.else)),
      ];
    }
    case "weight":
      return describeWeight(node);
    case "filter":
      return describeFilter(node);
    default:
      return assertNever(node, "node type");
  }
}

function describeWeight(node: WeightNode): string[] {
  switch (node.mode) {
    case "equal":
      return ["Split equally between:", ...listItems(node.children)];
    case "specified":
      return [
        "Split by fixed weights:",
        ...listItems(node.children, (i) => `${formatPercent(node.weights[i]! * 100)}: `),
      ];
    case "inverse-volatility":
      return [
        `Split by inverse ${node.window}-day volatility (calmer assets get more) between:`,
        ...listItems(node.children),
      ];
    default:
      return assertNever(node, "weight mode");
  }
}

function describeFilter(node: FilterNode): string[] {
  const extreme = node.order === "top" ? "highest" : "lowest";
  const metric = indicatorNoun(node.sortBy);
  const header =
    node.select === 1
      ? `Hold whichever has the ${extreme} ${metric} of:`
      : `Hold the ${node.select} with the ${extreme} ${metric}, split equally, from:`;
  return [header, ...listItems(node.children)];
}

/**
 * Renders children as `- ` items. A plain asset is just its symbol; a compound child's
 * first line follows the bullet and its other lines are indented under it.
 */
function listItems(children: readonly Node[], prefix: (i: number) => string = () => ""): string[] {
  return children.flatMap((child, i) => {
    const [first, ...rest] = child.type === "asset" ? [child.symbol] : describeNode(child);
    return [`${INDENT}- ${prefix(i)}${first}`, ...indent(indent(rest))];
  });
}

/** e.g. "the price of SOL is above its 100-day moving average". */
function describeComparison(lhs: Operand, op: ComparisonOp, rhs: Operand): string {
  const lhsSymbol = lhs.type === "indicator" ? lhs.symbol : undefined;
  const percent = isPercentOperand(lhs) || isPercentOperand(rhs);
  return `${operandText(lhs, percent)} ${OPERATORS[op]} ${operandText(rhs, percent, lhsSymbol)}`;
}

const OPERATORS: Record<ComparisonOp, string> = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
};

/** An indicator with its symbol ("the price of SOL"), or "its ..." for the other side's symbol. */
function operandText(operand: Operand, percent: boolean, sameSymbolAs?: string): string {
  if (operand.type === "number") {
    return percent ? formatPercent(operand.value) : formatNumber(operand.value);
  }
  const noun = indicatorNoun(operand);
  return operand.symbol === sameSymbolAs ? `its ${noun}` : `the ${noun} of ${operand.symbol}`;
}

/** The indicator's name without a symbol, e.g. "price", "100-day moving average". */
function indicatorNoun({ name, window }: Indicator): string {
  switch (name) {
    case "price":
      return "price";
    case "sma":
      return `${window}-day moving average`;
    case "ema":
      return `${window}-day exponential moving average`;
    case "rsi":
      return `${window}-day RSI`;
    case "cumulativeReturn":
      return `${window}-day return`;
    case "stdDevReturn":
      return `${window}-day volatility`;
    case "maxDrawdown":
      return `${window}-day maximum drawdown`;
    default:
      return assertNever(name, "indicator");
  }
}

function isPercentOperand(operand: Operand): boolean {
  return operand.type === "indicator" && isPercentIndicator(operand.name);
}

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => INDENT + line);
}

function formatPercent(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}
