#!/usr/bin/env node
// Reports data quality for each cached token. Exits 1 if any token has issues.
// Usage: pnpm data:check [SYMBOL ...]   (default: every token in the registry)

import { checkData, formatReport } from "./check.js";
import { defaultCacheDir } from "./paths.js";

const symbols = process.argv.slice(2);
const cacheDir = defaultCacheDir();
const reports = await checkData({ cacheDir, ...(symbols.length > 0 ? { symbols } : {}) });

console.log(`Candle cache: ${cacheDir}\n`);
console.log(formatReport(reports));

const bad = reports.filter((r) => r.status === "issues" || r.status === "error");
const empty = reports.filter((r) => r.status === "no data");
console.log("");
if (bad.length > 0) {
  console.log(`${bad.length} token(s) need attention: ${bad.map((r) => r.symbol).join(", ")}`);
}
if (empty.length > 0) {
  console.log(
    `${empty.length} token(s) have no cached data: ${empty.map((r) => r.symbol).join(", ")} ` +
      "(run pnpm data:fetch or pnpm data:import)",
  );
}
if (bad.length === 0 && empty.length === 0) console.log("No issues found.");
process.exitCode = bad.length === 0 ? 0 : 1;
