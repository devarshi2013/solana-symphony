# @solana-symphony/dsl

The strategy language: a JSON logic tree (like a Composer symphony), plus validation,
evaluation to target weights, and plain-English descriptions. Pure TypeScript with no I/O;
price data is passed in through a `PriceProvider`.

## Usage

```ts
import { readFileSync } from "node:fs";
import { InMemoryPriceProvider, describe, evaluate, validateStrategy } from "@solana-symphony/dsl";

// 1. Validate untrusted JSON.
const result = validateStrategy(JSON.parse(readFileSync("examples/rsi-dip.json", "utf8")));
if (!result.ok) throw new Error(result.errors.join("\n"));
const strategy = result.strategy;

// 2. Supply daily closes. Here SOL falls 1% a day for 30 days, ending 2024-06-29.
const days = Array.from({ length: 30 }, (_, i) =>
  new Date(Date.UTC(2024, 4, 31 + i)).toISOString().slice(0, 10),
);
const prices = new InMemoryPriceProvider({
  SOL: days.map((date, i) => ({ date, close: 150 * 0.99 ** i })),
  USDC: days.map((date) => ({ date, close: 1 })),
});

// 3. Evaluate at midnight UTC on 2024-06-30, once the 2024-06-29 close is final.
const { weights, trace } = evaluate(strategy, prices, new Date("2024-06-30T00:00:00Z"));
console.log(weights); // { SOL: 1 }
console.log(trace); // [{ path: "root", message: "SOL RSI14 0 < 30 → then branch" }]

// 4. Explain the strategy in plain English.
console.log(describe(strategy));
// Rebalances daily.
// If the 14-day RSI of SOL is below 30:
//   Hold SOL.
// Otherwise:
//   Split by fixed weights:
//     - 50%: SOL
//     - 50%: USDC
```

More strategies are in [`examples/`](examples/).

## Things to know

- **No look-ahead.** A candle dated D is the close at 00:00 UTC on D + 1 and is invisible
  before then. Evaluating at `2024-06-30T00:00:00Z` sees the 2024-06-29 close; evaluating
  at any time during 2024-06-30 still does not see 2024-06-30's.
- **Weights** are fractions summing to exactly 1, largest first, with zero weights removed.
  They are rounded to multiples of 2⁻⁴⁰ (about 1e-12) so the sum is exact in floating point.
- **Missing history:** if a node needs an indicator without enough data, that node's whole
  allocation goes to `USDC` and the trace says why. Other branches are unaffected.
- **Errors:** `evaluate` validates its input and throws `InvalidStrategyError`; a close that
  is zero, negative or not finite throws a `RangeError` rather than trading on bad data.
- **Tokens:** strategies may only use symbols in `TOKENS`. WIF's mint is still a `TODO`;
  check `isTodo()` before trading a token.
