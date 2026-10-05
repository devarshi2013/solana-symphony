import { describe as suite, expect, it } from "vitest";
import * as dsl from "./index.js";

suite("public API", () => {
  // Changing this list changes the package's API: update it deliberately.
  it("exports exactly these runtime values", () => {
    expect(Object.keys(dsl).sort()).toEqual([
      "FALLBACK_SYMBOL",
      "InMemoryPriceProvider",
      "InvalidStrategyError",
      "StrategySchema",
      "TOKENS",
      "TOKEN_SYMBOLS",
      "WEIGHT_SUM_TOLERANCE",
      "WINDOW_MAX_DAYS",
      "WINDOW_MIN_DAYS",
      "computeIndicator",
      "cumulativeReturn",
      "describe",
      "ema",
      "evaluate",
      "isSupportedSymbol",
      "isTodo",
      "lookbackFor",
      "maxDrawdown",
      "rsi",
      "sma",
      "stdDevReturn",
      "validateStrategy",
    ]);
  });
});
