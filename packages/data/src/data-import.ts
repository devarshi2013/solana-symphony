#!/usr/bin/env node
// Imports daily candles from a CSV into data/cache/<SYMBOL>.json.
// Usage: pnpm data:import <file.csv> <SYMBOL>
// CSV header: date,open,high,low,close[,volume]  (dates YYYY-MM-DD, UTC)

import { resolve } from "node:path";
import { importCsv } from "./csv.js";

const [file, symbol, ...rest] = process.argv.slice(2);
if (!file || !symbol || rest.length > 0) {
  console.error("Usage: pnpm data:import <file.csv> <SYMBOL>");
  process.exit(1);
}

// pnpm runs root scripts from the repo root; INIT_CWD is where the user ran the command.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
try {
  const r = await importCsv(path, symbol);
  console.log(
    `${r.symbol}: imported ${r.imported} candle(s) (${r.replaced} replaced cached dates), ` +
      `${r.total} total in ${r.cachePath}`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
