import { loadConfig, type Config } from "./config.js";
import { findEnvFile, readEnvFile } from "./env-file.js";

export {
  CLUSTERS,
  ConfigError,
  ENV_VARS,
  loadConfig,
  type Cluster,
  type Config,
  type EnvVarName,
  type InvalidEnvVar,
} from "./config.js";
export { findEnvFile, readEnvFile } from "./env-file.js";

let cached: Config | undefined;

/**
 * Returns the app config: reads the nearest `.env` (real environment variables take
 * precedence), validates it, and caches the result. Throws ConfigError naming every
 * missing or invalid variable.
 */
export function getConfig(): Config {
  if (!cached) {
    const envFile = findEnvFile(process.cwd());
    const fromFile = envFile ? readEnvFile(envFile) : {};
    cached = loadConfig({ ...fromFile, ...process.env });
  }
  return cached;
}
