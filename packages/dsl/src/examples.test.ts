import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryPriceProvider, type DailyClose } from "./data.js";
import { evaluate, type EvaluationResult } from "./evaluate.js";
import { validateStrategy } from "./schema.js";
import { TOKEN_SYMBOLS, type TokenSymbol } from "./tokens.js";
import type { Strategy } from "./types.js";

const EXAMPLES_DIR = new URL("../examples/", import.meta.url);
const ASOF = new Date("2024-06-30T00:00:00Z");
const DAYS = 250; // longer than any lookback the examples need (SMA100)
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic price path: compound daily `drift`, times a sine wobble of size `amp`. */
interface Path {
  start: number;
  drift?: number;
  amp?: number;
  period?: number;
}

function synth({ start, drift = 0, amp = 0, period = 7 }: Path): DailyClose[] {
  return Array.from({ length: DAYS }, (_, i) => ({
    date: new Date(ASOF.getTime() - (DAYS - i) * DAY_MS).toISOString().slice(0, 10),
    close: start * (1 + drift) ** i * (1 + amp * Math.sin((2 * Math.PI * i) / period)),
  }));
}

/** A market with a gently rising, wobbling path for every registry token, plus overrides. */
function market(overrides: Partial<Record<TokenSymbol, Path>> = {}): InMemoryPriceProvider {
  const data: Record<string, DailyClose[]> = {};
  for (const symbol of TOKEN_SYMBOLS) {
    const path = overrides[symbol] ?? { start: 10, drift: 0.001, amp: 0.02 };
    data[symbol] = synth(symbol === "USDC" && !overrides.USDC ? { start: 1 } : path);
  }
  return new InMemoryPriceProvider(data);
}

function loadExample(file: string): Strategy {
  const result = validateStrategy(JSON.parse(readFileSync(new URL(file, EXAMPLES_DIR), "utf8")));
  if (!result.ok) throw new Error(`${file} is invalid:\n${result.errors.join("\n")}`);
  return result.strategy;
}

function run(file: string, provider: InMemoryPriceProvider): EvaluationResult {
  const result = evaluate(loadExample(file), provider, ASOF);
  // Synthetic data covers every lookback, so no example should hit the USDC fallback.
  expect(result.trace.map((s) => s.message).join("\n")).not.toContain("not enough price data");
  expect(Object.values(result.weights).reduce((s, w) => s + w, 0)).toBe(1);
  return result;
}

const bull = { start: 100, drift: 0.005, amp: 0.01 };
const bear = { start: 100, drift: -0.005, amp: 0.01 };

describe("example strategies", () => {
  const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".json"));

  it("includes the five documented examples", () => {
    expect(files.sort()).toEqual([
      "inverse-vol-majors.json",
      "momentum-top2.json",
      "nested.json",
      "rsi-dip.json",
      "sol-trend.json",
    ]);
  });

  it.each(files)("%s passes validation and its id matches the file name", (file) => {
    expect(loadExample(file).id).toBe(file.replace(/\.json$/, ""));
  });

  describe("sol-trend.json", () => {
    it("holds SOL when SOL is above its 100-day SMA", () => {
      const { weights, trace } = run("sol-trend.json", market({ SOL: bull }));
      expect(weights).toEqual({ SOL: 1 });
      expect(trace[0]!.message).toMatch(/^SOL price [\d.]+ > SMA100 [\d.]+ → then branch$/);
    });

    it("holds USDC when SOL is below its 100-day SMA", () => {
      const { weights, trace } = run("sol-trend.json", market({ SOL: bear }));
      expect(weights).toEqual({ USDC: 1 });
      expect(trace[0]!.message).toMatch(/is false → else branch$/);
    });
  });

  describe("momentum-top2.json", () => {
    it("holds the two best 30-day performers equally", () => {
      const { weights, trace } = run(
        "momentum-top2.json",
        market({
          SOL: { start: 100, drift: 0.003 },
          JUP: { start: 1, drift: 0.01 },
          JTO: { start: 3, drift: -0.002 },
          BONK: { start: 0.00002, drift: 0.006 },
          WIF: { start: 2, drift: -0.005 },
        }),
      );
      expect(weights).toEqual({ BONK: 0.5, JUP: 0.5 });
      expect(trace[0]!.message).toMatch(
        /^Ranked by 30d return \(top 2 of 5\): JUP .*→ selected JUP, BONK$/,
      );
    });
  });

  describe("inverse-vol-majors.json", () => {
    it("gives the calmest token the most weight, in inverse proportion to volatility", () => {
      const { weights } = run(
        "inverse-vol-majors.json",
        market({
          SOL: { start: 150, amp: 0.04 },
          JitoSOL: { start: 170, amp: 0.02 },
          JUP: { start: 1, amp: 0.08 },
        }),
      );
      expect(Object.keys(weights)).toEqual(["JitoSOL", "SOL", "JUP"]);
      // Same wave shape, so volatility scales with amplitude: weights ~ 1/2 : 1/4 : 1/8 = 4 : 2 : 1
      expect(weights.JitoSOL! / weights.SOL!).toBeCloseTo(2, 1);
      expect(weights.SOL! / weights.JUP!).toBeCloseTo(2, 1);
    });
  });

  describe("rsi-dip.json", () => {
    it("goes all-in on SOL when RSI(14) is oversold", () => {
      // falling every day -> no gains -> RSI 0
      const { weights, trace } = run("rsi-dip.json", market({ SOL: { start: 100, drift: -0.01 } }));
      expect(weights).toEqual({ SOL: 1 });
      expect(trace[0]!.message).toBe("SOL RSI14 0 < 30 → then branch");
    });

    it("holds 50/50 SOL/USDC otherwise", () => {
      // rising every day -> no losses -> RSI 100
      const { weights, trace } = run("rsi-dip.json", market({ SOL: { start: 100, drift: 0.01 } }));
      expect(weights).toEqual({ SOL: 0.5, USDC: 0.5 });
      expect(trace[0]!.message).toBe("SOL RSI14 100 < 30 is false → else branch");
    });
  });

  describe("nested.json", () => {
    it("risk-on: 60% SOL plus 40% in the best of JUP, JTO, BONK", () => {
      const { weights, trace } = run(
        "nested.json",
        market({
          SOL: bull,
          JUP: { start: 1, drift: 0.001 },
          JTO: { start: 3, drift: 0.008 },
          BONK: { start: 0.00002, drift: -0.003 },
        }),
      );
      expect(weights.SOL).toBeCloseTo(0.6, 11);
      expect(weights.JTO).toBeCloseTo(0.4, 11);
      expect(Object.keys(weights)).toEqual(["SOL", "JTO"]);
      expect(trace.map((s) => s.path)).toEqual(["root", "root.then.child.children[1]"]);
      expect(trace[1]!.message).toMatch(/→ selected JTO$/);
    });

    it("risk-off: liquid staking tokens weighted by inverse volatility", () => {
      const { weights, trace } = run(
        "nested.json",
        market({
          SOL: bear,
          JitoSOL: { start: 170, amp: 0.01 },
          mSOL: { start: 180, amp: 0.03 },
        }),
      );
      expect(Object.keys(weights)).toEqual(["JitoSOL", "mSOL"]);
      // volatility ratio 1 : 3 -> weights 3/4 : 1/4
      expect(weights.JitoSOL).toBeCloseTo(0.75, 1);
      expect(trace.map((s) => s.path)).toEqual(["root", "root.else.child"]);
    });
  });
});
