import { loadConfig, loadPriceApiConfig, type Config, type PriceApiConfig } from "./config.js";
import { findEnvFile, readEnvFile } from "./env-file.js";

export {
  CLUSTERS,
  ConfigError,
  ENV_VARS,
  loadConfig,
  loadPriceApiConfig,
  PRICE_API_PROVIDERS,
  type Cluster,
  type Config,
  type EnvVarName,
  type InvalidEnvVar,
  type PriceApiConfig,
  type PriceApiProvider,
} from "./config.js";
export { findEnvFile, readEnvFile } from "./env-file.js";

let cached: Config | undefined;

/** Real environment variables, layered over the nearest `.env` file. */
function readEnv(): Record<string, string | undefined> {
  const envFile = findEnvFile(process.cwd());
  return { ...(envFile ? readEnvFile(envFile) : {}), ...process.env };
}

/**
 * Returns the app config: reads the nearest `.env` (real environment variables take
 * precedence), validates it, and caches the result. Throws ConfigError naming every
 * missing or invalid variable.
 */
export function getConfig(): Config {
  cached ??= loadConfig(readEnv());
  return cached;
}

/** Reads and validates only the price API variables. Throws ConfigError naming any problem. */
export function getPriceApiConfig(): PriceApiConfig {
  return loadPriceApiConfig(readEnv());
}
