#!/usr/bin/env node
// Downloads daily candles for every registry token into <repo>/data/cache/<SYMBOL>.json.
// Usage: pnpm data:fetch [SYMBOL ...]   (default: every token in the registry)

import { ConfigError, getPriceApiConfig } from "@solana-symphony/config";
import { isSupportedSymbol, isTodo, TOKEN_SYMBOLS, TOKENS } from "@solana-symphony/dsl";
import { lastCompleteDay } from "./candle.js";
import { fetchHistory } from "./history.js";
import { createHttpClient } from "./http.js";
import { defaultCacheDir } from "./paths.js";
import { BIRDEYE_MIN_INTERVAL_MS, createBirdeyeProvider } from "./providers/birdeye.js";
import { COINGECKO_MIN_INTERVAL_MS, createCoinGeckoProvider } from "./providers/coingecko.js";
import type { TokenRef } from "./providers/types.js";

const START_DATE = "2022-01-01";

async function main(args: string[]): Promise<number> {
  const unknown = args.filter((s) => !isSupportedSymbol(s));
  if (unknown.length > 0) {
    console.error(
      `Unknown token(s): ${unknown.join(", ")}. Supported: ${TOKEN_SYMBOLS.join(", ")}`,
    );
    return 1;
  }

  let config;
  try {
    config = getPriceApiConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const tokens: TokenRef[] = [];
  for (const symbol of args.length > 0 ? args : TOKEN_SYMBOLS) {
    const { mainnetMint } = TOKENS[symbol as keyof typeof TOKENS];
    if (isTodo(mainnetMint)) {
      console.warn(`${symbol}: skipped, mint not confirmed (${mainnetMint})`);
    } else {
      tokens.push({ symbol, mint: mainnetMint });
    }
  }

  const log = (message: string) => console.log(message);
  const provider =
    config.provider === "birdeye"
      ? createBirdeyeProvider(
          config.apiKey,
          createHttpClient({ minIntervalMs: BIRDEYE_MIN_INTERVAL_MS, log }),
        )
      : createCoinGeckoProvider(
          config.apiKey,
          createHttpClient({ minIntervalMs: COINGECKO_MIN_INTERVAL_MS, log }),
        );

  const cacheDir = defaultCacheDir();
  const end = lastCompleteDay(new Date());
  console.log(`Fetching ${START_DATE}..${end} from ${provider.name} into ${cacheDir}`);

  const results = await fetchHistory({ tokens, provider, cacheDir, start: START_DATE, end, log });

  console.log("\nSummary:");
  for (const r of results) {
    if (r.status === "failed") {
      console.log(`  ${r.symbol}: FAILED (${r.error})`);
    } else if (r.status === "updated") {
      console.log(`  ${r.symbol}: +${r.added} candle(s), last ${r.lastDate ?? "none"}`);
    } else {
      console.log(`  ${r.symbol}: up to date, last ${r.lastDate}`);
    }
  }

  const failed = results.filter((r) => r.status === "failed");
  if (failed.some((r) => /HTTP 40[13]/.test(r.error))) {
    console.error(
      config.provider === "coingecko"
        ? "\nCoinGecko rejected the key. Daily OHLC history needs a paid plan (Analyst or above) and a Pro API key."
        : "\nBirdeye rejected the key. Check PRICE_API_KEY in your .env.",
    );
  }
  return failed.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
