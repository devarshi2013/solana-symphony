import { readFileSync } from "node:fs";
import { describe as suite, expect, it } from "vitest";
import { describe } from "./describe.js";
import { validateStrategy } from "./schema.js";
import type { Node, Strategy } from "./types.js";

function example(file: string): Strategy {
  const json: unknown = JSON.parse(
    readFileSync(new URL(`../examples/${file}`, import.meta.url), "utf8"),
  );
  const result = validateStrategy(json);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.strategy;
}

const strategy = (root: Node): Strategy => ({
  id: "t",
  name: "T",
  description: "",
  version: 1,
  rebalance: "quarterly",
  root,
});

suite("describe: example strategies", () => {
  it("sol-trend.json", () => {
    expect(describe(example("sol-trend.json"))).toMatchInlineSnapshot(`
      "Rebalances daily.
      If the price of SOL is above its 100-day moving average:
        Hold SOL.
      Otherwise:
        Hold USDC."
    `);
  });

  it("momentum-top2.json", () => {
    expect(describe(example("momentum-top2.json"))).toMatchInlineSnapshot(`
      "Rebalances weekly.
      Hold the 2 with the highest 30-day return, split equally, from:
        - SOL
        - JUP
        - JTO
        - BONK
        - WIF"
    `);
  });

  it("inverse-vol-majors.json", () => {
    expect(describe(example("inverse-vol-majors.json"))).toMatchInlineSnapshot(`
      "Rebalances monthly, or sooner if any weight drifts more than 5 percentage points from its target.
      Split by inverse 20-day volatility (calmer assets get more) between:
        - SOL
        - JitoSOL
        - JUP"
    `);
  });

  it("rsi-dip.json", () => {
    expect(describe(example("rsi-dip.json"))).toMatchInlineSnapshot(`
      "Rebalances daily.
      If the 14-day RSI of SOL is below 30:
        Hold SOL.
      Otherwise:
        Split by fixed weights:
          - 50%: SOL
          - 50%: USDC"
    `);
  });

  it("nested.json", () => {
    expect(describe(example("nested.json"))).toMatchInlineSnapshot(`
      "Rebalances weekly, or sooner if any weight drifts more than 10 percentage points from its target.
      If the price of SOL is above its 50-day moving average:
        Risk-on:
          Split by fixed weights:
            - 60%: SOL
            - 40%: Hold whichever has the highest 30-day return of:
                - JUP
                - JTO
                - BONK
      Otherwise:
        Risk-off:
          Split by inverse 20-day volatility (calmer assets get more) between:
            - JitoSOL
            - mSOL"
    `);
  });
});

suite("describe: every indicator and operator", () => {
  it("names each indicator and comparison", () => {
    const sol = { type: "indicator", symbol: "SOL" } as const;
    const leaf = (symbol: string): Node => ({ type: "asset", symbol });
    const root: Node = {
      type: "if",
      condition: {
        lhs: { ...sol, name: "ema", window: 20 },
        op: ">=",
        rhs: { ...sol, name: "sma", window: 50 },
      },
      then: {
        type: "if",
        condition: {
          lhs: { ...sol, name: "cumulativeReturn", window: 30 },
          op: "<=",
          rhs: { type: "number", value: -10 },
        },
        then: leaf("USDC"),
        else: {
          type: "if",
          condition: {
            lhs: { ...sol, name: "stdDevReturn", window: 20 },
            op: "<",
            rhs: { type: "indicator", name: "maxDrawdown", symbol: "JUP", window: 60 },
          },
          then: leaf("SOL"),
          else: leaf("JUP"),
        },
      },
      else: {
        type: "filter",
        sortBy: { type: "indicator", name: "rsi", symbol: "", window: 14 },
        order: "bottom",
        select: 2,
        children: [
          leaf("JUP"),
          leaf("JTO"),
          {
            type: "filter",
            sortBy: { type: "indicator", name: "price", symbol: "" },
            order: "top",
            select: 1,
            children: [leaf("JitoSOL"), leaf("mSOL")],
          },
        ],
      },
    };
    expect(describe(strategy(root))).toMatchInlineSnapshot(`
      "Rebalances quarterly.
      If the 20-day exponential moving average of SOL is at or above its 50-day moving average:
        If the 30-day return of SOL is at or below -10%:
          Hold USDC.
        Otherwise:
          If the 20-day volatility of SOL is below the 60-day maximum drawdown of JUP:
            Hold SOL.
          Otherwise:
            Hold JUP.
      Otherwise:
        Hold the 2 with the lowest 14-day RSI, split equally, from:
          - JUP
          - JTO
          - Hold whichever has the highest price of:
              - JitoSOL
              - mSOL"
    `);
  });

  it("drops the label of an unnamed group", () => {
    expect(
      describe(strategy({ type: "group", name: "", child: { type: "asset", symbol: "SOL" } })),
    ).toBe("Rebalances quarterly.\nHold SOL.");
  });

  it("names an unknown node type instead of crashing obscurely", () => {
    expect(() => describe(strategy({ type: "token", symbol: "SOL" } as unknown as Node))).toThrow(
      'unknown node type: {"type":"token","symbol":"SOL"}',
    );
  });
});
