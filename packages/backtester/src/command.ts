import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkData,
  defaultCacheDir,
  FilePriceProvider,
  findWorkspaceRoot,
} from "@solana-symphony/data";
import {
  describe,
  isSupportedSymbol,
  TOKEN_SYMBOLS,
  validateStrategy,
  type Node,
  type Strategy,
} from "@solana-symphony/dsl";
import { runBenchmark, type LabeledResult } from "./benchmark.js";
import { compare, formatComparison } from "./compare.js";
import { renderReport } from "./report.js";

export const USAGE = `Usage: pnpm backtest <strategy.json> [options]

Options:
  --start YYYY-MM-DD   first trading day (default 2023-01-01)
  --end YYYY-MM-DD     last trading day (default: yesterday, the last complete UTC day)
  --capital N          starting capital in USDC (default 10000)
  --benchmark SYMBOLS  buy-and-hold benchmark(s), comma-separated (default SOL)
  --fee BPS            fee per trade in basis points (default 30)
  --slippage BPS       slippage per trade in basis points (default 20)
  --no-open            do not open the HTML report
  -h, --help           show this help

Prices come from data/cache (run pnpm data:fetch first). Results are written to
out/<strategy-id>/results.json and out/<strategy-id>/report.html.`;

export interface CommandIO {
  /** Directory relative paths are resolved against (where the user ran the command). */
  cwd: string;
  cacheDir?: string;
  /** Where out/<strategy-id>/ goes. Default: the workspace root. */
  outRoot?: string;
  now?: () => Date;
  log?: (message: string) => void;
  error?: (message: string) => void;
  /** Opens a file in the default viewer; returns false if that is not possible. */
  open?: (path: string) => boolean;
}

/** Runs the backtest command. Returns the process exit code. */
export async function main(argv: readonly string[], io: CommandIO): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const now = io.now ?? (() => new Date());

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        start: { type: "string", default: "2023-01-01" },
        end: { type: "string" },
        capital: { type: "string", default: "10000" },
        benchmark: { type: "string", default: "SOL" },
        fee: { type: "string", default: "30" },
        slippage: { type: "string", default: "20" },
        "no-open": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    error(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    log(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    error(`Expected one strategy file.\n\n${USAGE}`);
    return 1;
  }

  const capital = Number(values.capital);
  const feeBps = Number(values.fee);
  const slippageBps = Number(values.slippage);
  const end = values.end ?? yesterday(now());
  const start = values.start;
  for (const [flag, n] of [
    ["--capital", capital],
    ["--fee", feeBps],
    ["--slippage", slippageBps],
  ] as const) {
    if (!Number.isFinite(n) || n < 0 || (flag === "--capital" && n === 0)) {
      error(`${flag} must be a ${flag === "--capital" ? "positive" : "non-negative"} number`);
      return 1;
    }
  }
  const benchmarks = values.benchmark
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = benchmarks.filter((s) => !isSupportedSymbol(s));
  if (unknown.length > 0) {
    error(
      `Unknown benchmark token(s): ${unknown.join(", ")}. Supported: ${TOKEN_SYMBOLS.join(", ")}`,
    );
    return 1;
  }

  // Strategy
  const strategyPath = resolve(io.cwd, positionals[0]!);
  let strategy: Strategy;
  try {
    const result = validateStrategy(JSON.parse(await readFile(strategyPath, "utf8")));
    if (!result.ok) {
      error(`${strategyPath} is not a valid strategy:\n  ${result.errors.join("\n  ")}`);
      return 1;
    }
    strategy = result.strategy;
  } catch (err) {
    error(`Cannot read ${strategyPath}: ${(err as Error).message}`);
    return 1;
  }

  // Prices
  const cacheDir = io.cacheDir ?? defaultCacheDir();
  let provider: FilePriceProvider;
  try {
    provider = await FilePriceProvider.load({ cacheDir });
  } catch (err) {
    error((err as Error).message);
    return 1;
  }
  if (provider.symbols.length === 0) {
    error(`No cached prices in ${cacheDir}. Run pnpm data:fetch (or pnpm data:import) first.`);
    return 1;
  }
  const needed = [...new Set([...strategySymbols(strategy.root), ...benchmarks])].filter(
    (s) => s !== "USDC",
  );
  // Data coverage and quality for every token involved: late listings and bad data are
  // the usual reasons a backtest looks better or worse than it should.
  for (const report of await checkData({ cacheDir, symbols: needed })) {
    if (report.status === "no data" || report.status === "error") {
      log(`Warning: no usable prices for ${report.symbol}; branches using it fall back to USDC.`);
      continue;
    }
    const problems = [
      report.missingDays > 0 ? `${report.missingDays} missing day(s)` : "",
      report.duplicateDates.length > 0 ? `${report.duplicateDates.length} duplicate date(s)` : "",
      report.badPriceDates.length > 0 ? `${report.badPriceDates.length} bad price(s)` : "",
      report.bigMoves.length > 0 ? `${report.bigMoves.length} daily move(s) over 80%` : "",
    ].filter(Boolean);
    const late =
      report.firstDate! > start ? `, first price ${report.firstDate} (after --start)` : "";
    if (problems.length > 0 || late) {
      log(
        `Data: ${report.symbol}${late}${problems.length > 0 ? `; ${problems.join(", ")} (see pnpm data:check)` : ""}`,
      );
    }
  }

  // Backtests
  const options = { start, end, initialCapital: capital, feeBps, slippageBps };
  let results: LabeledResult[];
  try {
    results = [
      runBenchmark(strategy, provider, options),
      ...benchmarks.map((s) => runBenchmark(`buy-hold:${s}`, provider, options)),
    ];
  } catch (err) {
    error(`Backtest failed: ${(err as Error).message}`);
    return 1;
  }
  const comparison = compare(results);

  log(
    `\n${strategy.name}: ${start} to ${end}, ${capital} USDC, fee ${feeBps} bps, slippage ${slippageBps} bps\n`,
  );
  log(formatComparison(comparison));
  for (const r of results) {
    const fellBack = r.result.rebalances.filter((x) => x.fallbacks.length > 0);
    if (fellBack.length === 0) continue;
    const lastFallback = fellBack.at(-1)!.date;
    const firstFull = r.result.rebalances.find(
      (x) => x.fallbacks.length === 0 && x.date > lastFallback,
    );
    log(
      `\n${r.label}: ${fellBack.length} of ${r.result.rebalances.length} rebalances fell back to USDC ` +
        `for missing price history (first ${fellBack[0]!.date}: ${fellBack[0]!.fallbacks[0]}). ` +
        (firstFull
          ? `Runs as written from ${firstFull.date}; consider --start ${firstFull.date}.`
          : "It never ran as written."),
    );
  }
  const warningCount = results.reduce((n, r) => n + r.result.warnings.length, 0);
  if (warningCount > 0) log(`\n${warningCount} warning(s); see results.json or the report.`);

  // Output files
  const outDir = join(io.outRoot ?? findWorkspaceRoot(io.cwd), "out", strategy.id);
  await mkdir(outDir, { recursive: true });
  const generatedAt = now().toISOString();
  const settings = { start, end, capital, feeBps, slippageBps };
  const resultsPath = join(outDir, "results.json");
  const reportPath = join(outDir, "report.html");
  await writeFile(
    resultsPath,
    `${JSON.stringify(
      {
        generatedAt,
        strategy,
        settings: { ...settings, benchmarks },
        comparison: {
          labels: comparison.labels,
          rows: comparison.rows,
          results: comparison.results,
        },
        backtests: results,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    reportPath,
    renderReport({
      strategy,
      description: describe(strategy),
      results,
      comparison,
      settings,
      generatedAt,
    }),
  );

  log(`\nWrote ${relative(io.cwd, resultsPath) || resultsPath}`);
  log(`Wrote ${relative(io.cwd, reportPath) || reportPath}`);
  if (!values["no-open"] && io.open && io.open(reportPath))
    log("Opened the report in your browser.");
  return 0;
}

/** Every token a strategy trades or reads, excluding filter sortBy symbols (unused). */
export function strategySymbols(node: Node): string[] {
  switch (node.type) {
    case "asset":
      return [node.symbol];
    case "group":
      return strategySymbols(node.child);
    case "weight":
    case "filter":
      return node.children.flatMap(strategySymbols);
    case "if": {
      const { lhs, rhs } = node.condition;
      const read = [lhs, rhs].flatMap((o) => (o.type === "indicator" ? [o.symbol] : []));
      return [...read, ...strategySymbols(node.then), ...strategySymbols(node.else)];
    }
    default:
      return [];
  }
}

function yesterday(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10);
}
