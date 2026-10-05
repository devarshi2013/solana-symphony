import { describe, expectTypeOf, it } from "vitest";
import type { Node, Operand, Strategy, WeightNode } from "./types.js";

// These tests are checked by `pnpm typecheck`; at runtime they only confirm the file loads.
describe("strategy types", () => {
  it("accepts a strategy using every node type", () => {
    const strategy = {
      id: "sol-trend",
      name: "SOL trend with risk-off",
      description: "Hold SOL above its 200-day SMA, otherwise rotate into stables.",
      version: 1,
      rebalance: "weekly",
      driftThresholdPct: 5,
      root: {
        type: "if",
        condition: {
          lhs: { type: "indicator", name: "price", symbol: "SOL" },
          op: ">",
          rhs: { type: "indicator", name: "sma", symbol: "SOL", window: 200 },
        },
        then: {
          type: "weight",
          mode: "specified",
          weights: [0.7, 0.3],
          children: [
            { type: "asset", symbol: "SOL" },
            {
              type: "filter",
              sortBy: { type: "indicator", name: "cumulativeReturn", symbol: "", window: 30 },
              order: "top",
              select: 2,
              children: [
                { type: "asset", symbol: "JUP" },
                { type: "asset", symbol: "JTO" },
                { type: "asset", symbol: "BONK" },
              ],
            },
          ],
        },
        else: {
          type: "group",
          name: "Risk-off",
          child: {
            type: "weight",
            mode: "inverse-volatility",
            window: 30,
            children: [
              { type: "asset", symbol: "USDC" },
              { type: "asset", symbol: "mSOL" },
            ],
          },
        },
      },
    } satisfies Strategy;

    expectTypeOf(strategy).toExtend<Strategy>();
  });

  it("narrows nodes on type and mode", () => {
    expectTypeOf<Extract<Node, { type: "if" }>["then"]>().toEqualTypeOf<Node>();
    expectTypeOf<Extract<WeightNode, { mode: "specified" }>["weights"]>().toEqualTypeOf<number[]>();
    expectTypeOf<{ type: "number"; value: number }>().toExtend<Operand>();
  });

  it("rejects invalid trees", () => {
    // @ts-expect-error unknown node type
    const badType: Node = { type: "asset-group", symbol: "SOL" };
    // @ts-expect-error "specified" weighting requires weights
    const missingWeights: Node = { type: "weight", mode: "specified", children: [] };
    // @ts-expect-error weights are only allowed with "specified"
    const extraWeights: Node = { type: "weight", mode: "equal", children: [], weights: [1] };
    // @ts-expect-error "inverse-volatility" weighting requires a window
    const missingWindow: Node = { type: "weight", mode: "inverse-volatility", children: [] };
    // @ts-expect-error unknown indicator
    const badIndicator: Operand = { type: "indicator", name: "macd", symbol: "SOL" };
    // @ts-expect-error unknown rebalance frequency
    const badRebalance: Strategy["rebalance"] = "hourly";

    expectTypeOf([
      badType,
      missingWeights,
      extraWeights,
      missingWindow,
      badIndicator,
      badRebalance,
    ]).not.toBeAny();
  });
});
