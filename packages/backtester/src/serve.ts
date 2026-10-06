#!/usr/bin/env node
// Starts the backtest API. Usage: pnpm backtest:serve   (PORT and HOST env vars optional)

import { defaultCacheDir, FilePriceProvider } from "@solana-symphony/data";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
// Loopback only by default, so the API is not exposed to the network.
const host = process.env.HOST ?? "127.0.0.1";

const cacheDir = defaultCacheDir();
let provider: FilePriceProvider;
try {
  provider = await FilePriceProvider.load({ cacheDir });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
if (provider.symbols.length === 0) {
  console.error(
    `No cached prices in ${cacheDir}. Run pnpm data:fetch (or pnpm data:import) first.`,
  );
  process.exit(1);
}

const app = await buildServer({ provider, logger: true });
await app.listen({ port, host });
console.log(
  `Prices loaded for ${provider.symbols.join(", ")}. POST http://${host}:${port}/backtest`,
);
