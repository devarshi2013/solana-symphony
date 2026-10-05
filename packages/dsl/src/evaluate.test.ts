import { describe, expect, it } from "vitest";
import { InMemoryPriceProvider, type DailyClose } from "./data.js";
import { InvalidStrategyError, evaluate } from "./evaluate.js";
import type { Condition, Indicator, Node, Strategy } from "./types.js";

// One close per day; each series' last candle is the day before ASOF, which has closed by ASOF.
const ASOF = new Date("2024-03-31T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function series(closes: number[]): DailyClose[] {
  return closes.map((close, i) => ({
    date: new Date(ASOF.getTime() - (closes.length - i) * DAY_MS).toISOString().slice(0, 10),
    close,
  }));
}

const provider = new InMemoryPriceProvider({
  // rising every day; SMA2 = (98.7 + 142.1) / 2 = 120.4; RSI = 100 (no losses)
  SOL: series([80, 90, 95, 98.7, 142.1]),
  // 1d return: 1.125 / 1 - 1 = +12.5%
  JUP: series([1, 1.125]),
  // 1d return: 1.08 / 1 - 1 = +8%
  JTO: series([1, 1.08]),
  // 1d return: 0.97 / 1 - 1 = -3%
  BONK: series([1, 0.97]),
  // flat: every return 0
  USDC: series([1, 1, 1, 1, 1]),
  // returns +10%, -10% -> population sd = 10%
  JitoSOL: series([100, 110, 99]),
  // returns +5%, -5% -> population sd = 5%
  mSOL: series([100, 105, 99.75]),
});

const strategy = (root: Node): Strategy => ({
  id: "t",
  name: "Test",
  description: "",
  version: 1,
  rebalance: "daily",
  root,
});

const run = (root: Node) => evaluate(strategy(root), provider, ASOF);
const asset = (symbol: string): Node => ({ type: "asset", symbol });
const ind = (name: Indicator["name"], symbol: string, window?: number): Indicator =>
  window === undefined
    ? { type: "indicator", name, symbol }
    : { type: "indicator", name, symbol, window };
const ifNode = (condition: Condition, then: Node, otherwise: Node): Node => ({
  type: "if",
  condition,
  then,
  else: otherwise,
});
const sum = (weights: Record<string, number>) => Object.values(weights).reduce((s, w) => s + w, 0);

describe("asset", () => {
  it("allocates 100% to its symbol and records no decision", () => {
    expect(run(asset("SOL"))).toEqual({ weights: { SOL: 1 }, trace: [] });
  });
});

describe("group", () => {
  it("passes its child through unchanged", () => {
    const { weights, trace } = run({ type: "group", name: "Core", child: asset("JUP") });
    expect(weights).toEqual({ JUP: 1 });
    expect(trace).toEqual([]);
  });

  it("puts child paths under .child", () => {
    const { trace } = run({
      type: "group",
      name: "Core",
      child: ifNode(
        { lhs: ind("price", "SOL"), op: ">", rhs: { type: "number", value: 1 } },
        asset("SOL"),
        asset("USDC"),
      ),
    });
    expect(trace[0]!.path).toBe("root.child");
  });
});

describe("weight: equal", () => {
  it("splits evenly between children", () => {
    const { weights } = run({
      type: "weight",
      mode: "equal",
      children: [asset("SOL"), asset("JUP"), asset("JTO")],
    });
    expect(Object.keys(weights)).toEqual(["JTO", "JUP", "SOL"]);
    for (const w of Object.values(weights)) expect(w).toBeCloseTo(1 / 3, 11);
    expect(sum(weights)).toBe(1);
  });

  it("multiplies nested allocations and merges repeated symbols", () => {
    // SOL: 1/2 directly + 1/2 * 1/2 nested = 0.75; JUP: 1/2 * 1/2 = 0.25
    const { weights } = run({
      type: "weight",
      mode: "equal",
      children: [
        asset("SOL"),
        { type: "weight", mode: "equal", children: [asset("SOL"), asset("JUP")] },
      ],
    });
    expect(weights).toEqual({ SOL: 0.75, JUP: 0.25 });
  });

  it("falls back to USDC when there are no children", () => {
    expect(run({ type: "weight", mode: "equal", children: [] })).toEqual({
      weights: { USDC: 1 },
      trace: [{ path: "root", message: "weight node has no children → 100% USDC" }],
    });
  });
});

describe("weight: specified", () => {
  it("uses the given weights, multiplied through nesting", () => {
    // SOL 0.6; JUP 0.4 * 0.5 = 0.2; JTO 0.4 * 0.5 = 0.2
    const { weights } = run({
      type: "weight",
      mode: "specified",
      weights: [0.6, 0.4],
      children: [
        asset("SOL"),
        { type: "weight", mode: "equal", children: [asset("JUP"), asset("JTO")] },
      ],
    });
    expect(weights.SOL).toBeCloseTo(0.6, 11);
    expect(weights.JUP).toBeCloseTo(0.2, 11);
    expect(weights.JTO).toBeCloseTo(0.2, 11);
    expect(sum(weights)).toBe(1);
  });

  it("removes zero weights", () => {
    const { weights } = run({
      type: "weight",
      mode: "specified",
      weights: [1, 0],
      children: [asset("SOL"), asset("JUP")],
    });
    expect(weights).toEqual({ SOL: 1 });
  });
});

describe("weight: inverse-volatility", () => {
  it("weights each child by 1 / volatility", () => {
    // JitoSOL sd 10%, mSOL sd 5% -> inverses 1/10 and 1/5 = 0.1 and 0.2, total 0.3
    // JitoSOL 0.1 / 0.3 = 1/3; mSOL 0.2 / 0.3 = 2/3
    const { weights, trace } = run({
      type: "weight",
      mode: "inverse-volatility",
      window: 2,
      children: [asset("JitoSOL"), asset("mSOL")],
    });
    expect(weights.mSOL).toBeCloseTo(2 / 3, 10);
    expect(weights.JitoSOL).toBeCloseTo(1 / 3, 10);
    expect(sum(weights)).toBe(1);
    expect(trace).toEqual([
      { path: "root", message: "Inverse volatility (2d): JitoSOL 10% → 33.3%, mSOL 5% → 66.7%" },
    ]);
  });

  it("gives everything to zero-volatility children", () => {
    const { weights, trace } = run({
      type: "weight",
      mode: "inverse-volatility",
      window: 2,
      children: [asset("JitoSOL"), asset("USDC")],
    });
    expect(weights).toEqual({ USDC: 1 });
    expect(trace[0]!.message).toBe("Inverse volatility (2d): JitoSOL 10% → 0%, USDC 0% → 100%");
  });

  it("falls back to USDC when a child lacks enough history", () => {
    // a 3-day volatility needs 4 closes: USDC has 5, JUP only 2
    expect(
      run({
        type: "weight",
        mode: "inverse-volatility",
        window: 3,
        children: [asset("USDC"), asset("JUP")],
      }),
    ).toEqual({
      weights: { USDC: 1 },
      trace: [{ path: "root", message: "JUP 3d volatility: not enough price data → 100% USDC" }],
    });
  });
});

describe("if", () => {
  it("follows then when the condition holds", () => {
    const { weights, trace } = run(
      ifNode(
        { lhs: ind("price", "SOL"), op: ">", rhs: ind("sma", "SOL", 2) },
        asset("SOL"),
        asset("USDC"),
      ),
    );
    expect(weights).toEqual({ SOL: 1 });
    expect(trace).toEqual([
      { path: "root", message: "SOL price 142.1 > SMA2 120.4 → then branch" },
    ]);
  });

  it("follows else when the condition fails", () => {
    // SOL rose every day -> RSI2 = 100, which is not < 30
    const { weights, trace } = run(
      ifNode(
        { lhs: ind("rsi", "SOL", 2), op: "<", rhs: { type: "number", value: 30 } },
        asset("SOL"),
        asset("JUP"),
      ),
    );
    expect(weights).toEqual({ JUP: 1 });
    expect(trace).toEqual([{ path: "root", message: "SOL RSI2 100 < 30 is false → else branch" }]);
  });

  it("names both symbols when they differ", () => {
    const { trace } = run(
      ifNode(
        { lhs: ind("price", "JUP"), op: "<=", rhs: ind("price", "SOL") },
        asset("JUP"),
        asset("SOL"),
      ),
    );
    expect(trace[0]!.message).toBe("JUP price 1.125 <= SOL price 142.1 → then branch");
  });

  it("shows percent indicators with a % sign", () => {
    // JUP 1d return 12.5%, which is >= 10
    const { trace } = run(
      ifNode(
        { lhs: ind("cumulativeReturn", "JUP", 1), op: ">=", rhs: { type: "number", value: 10 } },
        asset("JUP"),
        asset("USDC"),
      ),
    );
    expect(trace[0]!.message).toBe("JUP 1d return 12.5% >= 10 → then branch");
  });

  it("evaluates only the chosen branch", () => {
    // the else branch would need a 200-day SMA, but is never evaluated
    const missing = ifNode(
      { lhs: ind("price", "SOL"), op: ">", rhs: ind("sma", "SOL", 200) },
      asset("SOL"),
      asset("USDC"),
    );
    const { trace } = run(
      ifNode(
        { lhs: ind("price", "SOL"), op: ">", rhs: { type: "number", value: 100 } },
        asset("SOL"),
        missing,
      ),
    );
    expect(trace).toEqual([{ path: "root", message: "SOL price 142.1 > 100 → then branch" }]);
  });

  it("falls back to USDC for just that branch when an indicator lacks data", () => {
    // left child: SMA200 needs 200 closes, SOL has 5 -> USDC; right child unaffected
    const { weights, trace } = run({
      type: "weight",
      mode: "equal",
      children: [
        ifNode(
          { lhs: ind("price", "SOL"), op: ">", rhs: ind("sma", "SOL", 200) },
          asset("SOL"),
          asset("JTO"),
        ),
        asset("JUP"),
      ],
    });
    expect(weights).toEqual({ JUP: 0.5, USDC: 0.5 });
    expect(trace).toEqual([
      { path: "root.children[0]", message: "SOL SMA200: not enough price data → 100% USDC" },
    ]);
  });
});

describe("filter", () => {
  const candidates = [asset("JUP"), asset("JTO"), asset("BONK")];
  const byReturn = ind("cumulativeReturn", "", 1);

  it("keeps the top N and weights them equally", () => {
    const { weights, trace } = run({
      type: "filter",
      sortBy: byReturn,
      order: "top",
      select: 2,
      children: candidates,
    });
    expect(weights).toEqual({ JTO: 0.5, JUP: 0.5 });
    expect(trace).toEqual([
      {
        path: "root",
        message:
          "Ranked by 1d return (top 2 of 3): JUP 12.5%, JTO 8%, BONK -3% → selected JUP, JTO",
      },
    ]);
  });

  it("keeps the bottom N", () => {
    const { weights, trace } = run({
      type: "filter",
      sortBy: byReturn,
      order: "bottom",
      select: 1,
      children: candidates,
    });
    expect(weights).toEqual({ BONK: 1 });
    expect(trace[0]!.message).toBe(
      "Ranked by 1d return (bottom 1 of 3): BONK -3%, JTO 8%, JUP 12.5% → selected BONK",
    );
  });

  it("ranks a compound child by its main asset and keeps its whole allocation", () => {
    // child 0's main asset is SOL (0.8 > 0.2); SOL 1d return 142.1 / 98.7 - 1 = 43.97% beats JUP
    const { weights, trace } = run({
      type: "filter",
      sortBy: byReturn,
      order: "top",
      select: 1,
      children: [
        {
          type: "weight",
          mode: "specified",
          weights: [0.8, 0.2],
          children: [asset("SOL"), asset("USDC")],
        },
        asset("JUP"),
      ],
    });
    expect(weights.SOL).toBeCloseTo(0.8, 11);
    expect(weights.USDC).toBeCloseTo(0.2, 11);
    expect(trace[0]!.message).toBe(
      "Ranked by 1d return (top 1 of 2): SOL 43.9716%, JUP 12.5% → selected SOL",
    );
  });

  it("breaks ties by child order", () => {
    const { weights } = run({
      type: "filter",
      sortBy: ind("price", ""),
      order: "top",
      select: 1,
      children: [asset("USDC"), { type: "group", name: "Also USDC", child: asset("USDC") }],
    });
    expect(weights).toEqual({ USDC: 1 });
  });

  it("falls back to USDC when a child's indicator lacks data", () => {
    expect(
      run({
        type: "filter",
        sortBy: ind("cumulativeReturn", "", 3),
        order: "top",
        select: 1,
        children: candidates,
      }),
    ).toEqual({
      weights: { USDC: 1 },
      trace: [{ path: "root", message: "JUP 3d return: not enough price data → 100% USDC" }],
    });
  });
});

describe("final weights", () => {
  it.each([3, 6, 7, 8])("sum to exactly 1 for an equal split of %i", (n) => {
    const symbols = ["SOL", "USDC", "JUP", "JTO", "BONK", "JitoSOL", "mSOL", "WIF"].slice(0, n);
    const { weights } = run({ type: "weight", mode: "equal", children: symbols.map(asset) });
    expect(Object.keys(weights)).toHaveLength(n);
    expect(sum(weights)).toBe(1);
  });

  it("sum to exactly 1 and stay positive for 300 random nested trees", () => {
    // mulberry32: small seeded PRNG so failures are reproducible
    let seed = 42;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const symbols = ["SOL", "USDC", "JUP", "JTO", "BONK", "JitoSOL", "mSOL"];

    const tree = (depth: number): Node => {
      if (depth === 0 || random() < 0.25) return asset(pick(symbols));
      const children = Array.from({ length: 1 + Math.floor(random() * 4) }, () => tree(depth - 1));
      switch (pick(["equal", "specified", "inverse-volatility", "filter", "group"] as const)) {
        case "equal":
          return { type: "weight", mode: "equal", children };
        case "specified": {
          const raw = children.map(() => random() + 0.01);
          const total = raw.reduce((a, b) => a + b, 0);
          return {
            type: "weight",
            mode: "specified",
            weights: raw.map((w) => w / total),
            children,
          };
        }
        case "inverse-volatility":
          return { type: "weight", mode: "inverse-volatility", window: 1, children };
        case "filter":
          return {
            type: "filter",
            sortBy: ind("price", ""),
            order: pick(["top", "bottom"] as const),
            select: 1 + Math.floor(random() * children.length),
            children,
          };
        case "group":
          return { type: "group", name: "g", child: children[0]! };
      }
    };

    for (let i = 0; i < 300; i++) {
      const { weights } = run(tree(3));
      expect(sum(weights)).toBe(1);
      for (const w of Object.values(weights)) expect(w).toBeGreaterThan(0);
    }
  });

  it("are ordered largest first", () => {
    const { weights } = run({
      type: "weight",
      mode: "specified",
      weights: [0.2, 0.5, 0.3],
      children: [asset("JTO"), asset("SOL"), asset("JUP")],
    });
    expect(Object.keys(weights)).toEqual(["SOL", "JUP", "JTO"]);
  });
});

describe("input checking", () => {
  it("rejects an invalid strategy instead of producing bad weights", () => {
    const zeroWeights = {
      type: "weight",
      mode: "specified",
      weights: [0, 0],
      children: [asset("SOL"), asset("JUP")],
    } as Node;
    expect(() => run(zeroWeights)).toThrow(InvalidStrategyError);
    expect(() => run(zeroWeights)).toThrow("root.weights: weights must sum to 1, got 0");

    const negative = { ...zeroWeights, weights: [2, -1] } as Node;
    expect(() => run(negative)).toThrow("root.weights[1]: weights must not be negative");
  });

  it("rejects an unknown node type with its path", () => {
    const unknown = {
      type: "weight",
      mode: "equal",
      children: [{ type: "token" }],
    } as unknown as Node;
    expect(() => run(unknown)).toThrow("root.children[0].type: Invalid discriminator value");
  });

  it("throws on a NaN price instead of silently taking the else branch", () => {
    const nanProvider = { getCloses: () => [Number.NaN] };
    const root = ifNode(
      { lhs: ind("price", "SOL"), op: "<", rhs: { type: "number", value: 1e9 } },
      asset("SOL"),
      asset("USDC"),
    );
    expect(() => evaluate(strategy(root), nanProvider, ASOF)).toThrow(RangeError);
  });

  it("does not see a close before its day has ended", () => {
    // SOL's last candle is dated the day before ASOF; one millisecond earlier it has not closed
    const justBefore = new Date(ASOF.getTime() - 1);
    const root = ifNode(
      { lhs: ind("price", "SOL"), op: ">", rhs: { type: "number", value: 100 } },
      asset("SOL"),
      asset("USDC"),
    );
    expect(evaluate(strategy(root), provider, ASOF).trace[0]!.message).toBe(
      "SOL price 142.1 > 100 → then branch",
    );
    expect(evaluate(strategy(root), provider, justBefore).trace[0]!.message).toBe(
      "SOL price 98.7 > 100 is false → else branch",
    );
  });
});
