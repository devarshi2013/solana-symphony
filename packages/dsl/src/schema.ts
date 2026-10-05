import { z } from "zod";
import { checkTokenSymbol } from "./tokens.js";
import type { Node, Strategy } from "./types.js";

/** Allowed distance of specified weights from summing to exactly 1. */
export const WEIGHT_SUM_TOLERANCE = 0.0001;
export const WINDOW_MIN_DAYS = 1;
export const WINDOW_MAX_DAYS = 365;

const windowSchema = z
  .number()
  .int("window must be a whole number of days")
  .min(WINDOW_MIN_DAYS, `window must be at least ${WINDOW_MIN_DAYS}`)
  .max(WINDOW_MAX_DAYS, `window must be at most ${WINDOW_MAX_DAYS}`);

/** A token symbol that must be in the registry (see tokens.ts). */
const symbolSchema = z.string().superRefine((symbol, ctx) => {
  const message = symbol === "" ? "symbol must not be empty" : checkTokenSymbol(symbol);
  if (message) ctx.addIssue({ code: "custom", message });
});

// Declared before the node schemas that reference it; the lazy body runs at parse time.
export const NodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.discriminatedUnion("type", [
    AssetNodeSchema,
    WeightNodeSchema,
    IfNodeSchema,
    FilterNodeSchema,
    GroupNodeSchema,
  ]),
);

function indicatorSchema<S extends z.ZodString>(symbol: S) {
  return z
    .strictObject({
      type: z.literal("indicator"),
      name: z.enum([
        "price",
        "sma",
        "ema",
        "rsi",
        "cumulativeReturn",
        "stdDevReturn",
        "maxDrawdown",
      ]),
      symbol,
      window: windowSchema.exactOptional(),
    })
    .superRefine((indicator, ctx) => {
      if (indicator.name !== "price" && indicator.window === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["window"],
          message: `window is required for ${indicator.name}`,
        });
      }
    });
}

export const IndicatorSchema = indicatorSchema(symbolSchema);

export const NumberOperandSchema = z.strictObject({
  type: z.literal("number"),
  value: z.number(),
});

export const OperandSchema = z.discriminatedUnion("type", [IndicatorSchema, NumberOperandSchema]);

export const ConditionSchema = z.strictObject({
  lhs: OperandSchema,
  op: z.enum([">", "<", ">=", "<="]),
  rhs: OperandSchema,
});

export const AssetNodeSchema = z.strictObject({
  type: z.literal("asset"),
  symbol: symbolSchema,
});

export const EqualWeightNodeSchema = z.strictObject({
  type: z.literal("weight"),
  mode: z.literal("equal"),
  children: z.array(NodeSchema),
});

export const SpecifiedWeightNodeSchema = z
  .strictObject({
    type: z.literal("weight"),
    mode: z.literal("specified"),
    children: z.array(NodeSchema),
    weights: z.array(z.number().nonnegative("weights must not be negative")),
  })
  .superRefine((node, ctx) => {
    if (node.weights.length !== node.children.length) {
      ctx.addIssue({
        code: "custom",
        path: ["weights"],
        message: `expected ${node.children.length} weights (one per child), got ${node.weights.length}`,
      });
    }
    const sum = node.weights.reduce((total, w) => total + w, 0);
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["weights"],
        message: `weights must sum to 1, got ${sum}`,
      });
    }
  });

export const InverseVolatilityWeightNodeSchema = z.strictObject({
  type: z.literal("weight"),
  mode: z.literal("inverse-volatility"),
  window: windowSchema,
  children: z.array(NodeSchema),
});

export const WeightNodeSchema = z.discriminatedUnion("mode", [
  EqualWeightNodeSchema,
  SpecifiedWeightNodeSchema,
  InverseVolatilityWeightNodeSchema,
]);

export const IfNodeSchema = z.strictObject({
  type: z.literal("if"),
  condition: ConditionSchema,
  then: NodeSchema,
  else: NodeSchema,
});

export const FilterNodeSchema = z
  .strictObject({
    type: z.literal("filter"),
    // The indicator is computed per child, so its symbol is ignored and may be empty.
    sortBy: indicatorSchema(z.string()),
    order: z.enum(["top", "bottom"]),
    select: z.number().int("select must be a whole number").min(1, "select must be at least 1"),
    children: z.array(NodeSchema),
  })
  .superRefine((node, ctx) => {
    if (node.select > node.children.length) {
      ctx.addIssue({
        code: "custom",
        path: ["select"],
        message: `select must be at most the number of children (${node.children.length}), got ${node.select}`,
      });
    }
  });

export const GroupNodeSchema = z.strictObject({
  type: z.literal("group"),
  name: z.string(),
  child: NodeSchema,
});

export const StrategySchema = z.strictObject({
  id: z.string().min(1, "id must not be empty"),
  name: z.string().min(1, "name must not be empty"),
  description: z.string(),
  version: z.number().int("version must be a whole number").min(1, "version must be at least 1"),
  rebalance: z.enum(["daily", "weekly", "monthly", "quarterly"]),
  driftThresholdPct: z
    .number()
    .gt(0, "driftThresholdPct must be greater than 0")
    .max(100, "driftThresholdPct must be at most 100")
    .exactOptional(),
  root: NodeSchema,
});

export type ValidationResult = { ok: true; strategy: Strategy } | { ok: false; errors: string[] };

/** Formats a zod issue path as `root.children[1].weights`. An empty path is the strategy itself. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out || "(strategy)";
}

/**
 * Validates untrusted JSON (already parsed) as a Strategy. Returns every problem found,
 * each prefixed with its location, e.g. `root.children[1].weights: weights must sum to 1, got 0.9`.
 */
export function validateStrategy(json: unknown): ValidationResult {
  const result = StrategySchema.safeParse(json);
  if (result.success) return { ok: true, strategy: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
  };
}
