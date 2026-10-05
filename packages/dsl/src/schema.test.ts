import type { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AssetNodeSchema,
  ConditionSchema,
  FilterNodeSchema,
  GroupNodeSchema,
  IfNodeSchema,
  IndicatorSchema,
  StrategySchema,
  WeightNodeSchema,
  formatPath,
  validateStrategy,
} from "./schema.js";
import type {
  AssetNode,
  Condition,
  FilterNode,
  GroupNode,
  IfNode,
  Indicator,
  Node,
  Strategy,
  WeightNode,
} from "./types.js";

const meta = {
  id: "test",
  name: "Test strategy",
  description: "",
  version: 1,
  rebalance: "monthly",
} as const;

const asset = (symbol: string): Node => ({ type: "asset", symbol });

const valid: Array<[string, Strategy]> = [
  ["a single asset with no drift threshold", { ...meta, root: asset("SOL") }],
  [
    "equal weights with a drift threshold",
    {
      ...meta,
      rebalance: "daily",
      driftThresholdPct: 5,
      root: { type: "weight", mode: "equal", children: [asset("SOL"), asset("JUP"), asset("JTO")] },
    },
  ],
  [
    "specified weights that sum to 1 within tolerance",
    {
      ...meta,
      root: {
        type: "weight",
        mode: "specified",
        weights: [0.33333, 0.33333, 0.33333],
        children: [asset("SOL"), asset("JUP"), asset("USDC")],
      },
    },
  ],
  [
    "inverse-volatility at the maximum window inside a group",
    {
      ...meta,
      rebalance: "quarterly",
      root: {
        type: "group",
        name: "Low volatility",
        child: {
          type: "weight",
          mode: "inverse-volatility",
          window: 365,
          children: [asset("USDC"), asset("mSOL")],
        },
      },
    },
  ],
  [
    "an if comparing RSI with a number, and price with no window",
    {
      ...meta,
      root: {
        type: "if",
        condition: {
          lhs: { type: "indicator", name: "rsi", symbol: "SOL", window: 14 },
          op: "<",
          rhs: { type: "number", value: 30 },
        },
        then: asset("SOL"),
        else: {
          type: "if",
          condition: {
            lhs: { type: "indicator", name: "price", symbol: "SOL" },
            op: ">=",
            rhs: { type: "indicator", name: "ema", symbol: "SOL", window: 1 },
          },
          then: asset("SOL"),
          else: asset("USDC"),
        },
      },
    },
  ],
  [
    "a filter selecting every child, nested under specified weights",
    {
      ...meta,
      root: {
        type: "weight",
        mode: "specified",
        weights: [0.1, 0.2, 0.7],
        children: [
          asset("USDC"),
          asset("SOL"),
          {
            type: "filter",
            sortBy: { type: "indicator", name: "maxDrawdown", symbol: "", window: 90 },
            order: "bottom",
            select: 3,
            children: [asset("JUP"), asset("JTO"), asset("BONK")],
          },
        ],
      },
    },
  ],
];

const invalid: Array<[string, unknown, string[]]> = [
  [
    "specified weights that do not sum to 1",
    {
      ...meta,
      root: {
        type: "weight",
        mode: "specified",
        weights: [0.5, 0.4],
        children: [asset("SOL"), asset("USDC")],
      },
    },
    ["root.weights: weights must sum to 1, got 0.9"],
  ],
  [
    "a nested weights list that does not match its children",
    {
      ...meta,
      root: {
        type: "weight",
        mode: "equal",
        children: [
          asset("SOL"),
          {
            type: "weight",
            mode: "specified",
            weights: [0.5, 0.25, 0.25],
            children: [asset("JUP"), asset("JTO")],
          },
        ],
      },
    },
    ["root.children[1].weights: expected 2 weights (one per child), got 3"],
  ],
  [
    "a filter selecting zero children",
    {
      ...meta,
      root: {
        type: "filter",
        sortBy: { type: "indicator", name: "cumulativeReturn", symbol: "", window: 30 },
        order: "top",
        select: 0,
        children: [asset("SOL")],
      },
    },
    ["root.select: select must be at least 1"],
  ],
  [
    "a filter selecting more children than it has",
    {
      ...meta,
      root: {
        type: "filter",
        sortBy: { type: "indicator", name: "stdDevReturn", symbol: "", window: 30 },
        order: "top",
        select: 3,
        children: [asset("SOL"), asset("JUP")],
      },
    },
    ["root.select: select must be at most the number of children (2), got 3"],
  ],
  [
    "an indicator window below 1",
    {
      ...meta,
      root: {
        type: "if",
        condition: {
          lhs: { type: "indicator", name: "sma", symbol: "SOL", window: 0 },
          op: ">",
          rhs: { type: "number", value: 100 },
        },
        then: asset("SOL"),
        else: asset("USDC"),
      },
    },
    ["root.condition.lhs.window: window must be at least 1"],
  ],
  [
    "an inverse-volatility window above 365",
    {
      ...meta,
      root: {
        type: "group",
        name: "Too long",
        child: {
          type: "weight",
          mode: "inverse-volatility",
          window: 366,
          children: [asset("SOL")],
        },
      },
    },
    ["root.child.window: window must be at most 365"],
  ],
  [
    "an unknown node type",
    {
      ...meta,
      root: { type: "weight", mode: "equal", children: [{ type: "token", symbol: "SOL" }] },
    },
    [
      "root.children[0].type: Invalid discriminator value. Expected 'asset' | 'weight' | 'if' | 'filter' | 'group'",
    ],
  ],
  [
    "several problems at once",
    {
      ...meta,
      name: "",
      rebalance: "hourly",
      root: {
        type: "if",
        condition: {
          lhs: { type: "indicator", name: "sma", symbol: "SOL" },
          op: ">",
          rhs: { type: "number", value: 1 },
        },
        then: asset("SOL"),
        else: asset("USDC"),
      },
    },
    [
      "name: name must not be empty",
      'rebalance: Invalid option: expected one of "daily"|"weekly"|"monthly"|"quarterly"',
      "root.condition.lhs.window: window is required for sma",
    ],
  ],
];

describe("validateStrategy", () => {
  it.each(valid)("accepts %s", (_name, strategy) => {
    expect(validateStrategy(strategy)).toEqual({ ok: true, strategy });
  });

  it.each(invalid)("rejects %s", (_name, json, errors) => {
    expect(validateStrategy(json)).toEqual({ ok: false, errors });
  });
});

describe("formatPath", () => {
  it("joins keys with dots and indexes with brackets", () => {
    expect(formatPath(["root", "children", 1, "weights"])).toBe("root.children[1].weights");
    expect(formatPath(["root", "children", 0, "children", 2])).toBe("root.children[0].children[2]");
  });

  it("names the strategy itself for an empty path", () => {
    expect(formatPath([])).toBe("(strategy)");
  });
});

// Checked by `pnpm typecheck`: fails to compile if a schema drifts from types.ts.
describe("schemas mirror types.ts", () => {
  it("infers exactly the declared types", () => {
    expectTypeOf<z.infer<typeof StrategySchema>>().toEqualTypeOf<Strategy>();
    expectTypeOf<z.infer<typeof AssetNodeSchema>>().toEqualTypeOf<AssetNode>();
    expectTypeOf<z.infer<typeof WeightNodeSchema>>().toEqualTypeOf<WeightNode>();
    expectTypeOf<z.infer<typeof IfNodeSchema>>().toEqualTypeOf<IfNode>();
    expectTypeOf<z.infer<typeof FilterNodeSchema>>().toEqualTypeOf<FilterNode>();
    expectTypeOf<z.infer<typeof GroupNodeSchema>>().toEqualTypeOf<GroupNode>();
    expectTypeOf<z.infer<typeof ConditionSchema>>().toEqualTypeOf<Condition>();
    expectTypeOf<z.infer<typeof IndicatorSchema>>().toEqualTypeOf<Indicator>();
  });
});
