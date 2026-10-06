import { isAbsolute } from "node:path";
import { z } from "zod";

export const CLUSTERS = ["devnet", "testnet", "mainnet-beta", "localnet"] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const PRICE_API_PROVIDERS = ["birdeye", "coingecko"] as const;
export type PriceApiProvider = (typeof PRICE_API_PROVIDERS)[number];

const httpUrl = z.url({ protocol: /^https?$/ });

const envSchema = z.object({
  SOLANA_RPC_URL: httpUrl,
  SOLANA_CLUSTER: z.enum(CLUSTERS),
  KEEPER_KEYPAIR_PATH: z.string().refine(isAbsolute, "must be an absolute path"),
  PRICE_API_KEY: z.string(),
  PRICE_API_PROVIDER: z.enum(PRICE_API_PROVIDERS),
  ANTHROPIC_API_KEY: z.string(),
  DATABASE_URL: z.url(),
  ALERT_WEBHOOK_URL: httpUrl,
});

export type EnvVarName = keyof z.infer<typeof envSchema>;
export const ENV_VARS = Object.keys(envSchema.shape) as EnvVarName[];

export interface Config {
  readonly solana: { readonly rpcUrl: string; readonly cluster: Cluster };
  readonly keeper: { readonly keypairPath: string };
  readonly priceApi: PriceApiConfig;
  readonly anthropic: { readonly apiKey: string };
  readonly database: { readonly url: string };
  readonly alerts: { readonly webhookUrl: string };
}

export interface PriceApiConfig {
  readonly provider: PriceApiProvider;
  readonly apiKey: string;
}

export interface InvalidEnvVar {
  readonly name: EnvVarName;
  readonly reason: string;
}

/** Thrown when required variables are missing or invalid. Never includes variable values. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(
    readonly missing: readonly EnvVarName[],
    readonly invalid: readonly InvalidEnvVar[],
  ) {
    const lines = ["Invalid environment configuration."];
    if (missing.length > 0) {
      lines.push(`Missing required environment variables: ${missing.join(", ")}`);
    }
    if (invalid.length > 0) {
      lines.push("Invalid environment variables:");
      for (const { name, reason } of invalid) lines.push(`  - ${name}: ${reason}`);
    }
    lines.push("Copy .env.example to .env at the repo root and fill in the values.");
    super(lines.join("\n"));
  }
}

/**
 * Validates `env` and returns a typed, frozen config. Pure: does not read files or
 * process.env. Empty or whitespace-only values count as missing.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const e = validateVars(ENV_VARS, env);
  return deepFreeze({
    solana: { rpcUrl: e.SOLANA_RPC_URL, cluster: e.SOLANA_CLUSTER },
    keeper: { keypairPath: e.KEEPER_KEYPAIR_PATH },
    priceApi: { provider: e.PRICE_API_PROVIDER, apiKey: e.PRICE_API_KEY },
    anthropic: { apiKey: e.ANTHROPIC_API_KEY },
    database: { url: e.DATABASE_URL },
    alerts: { webhookUrl: e.ALERT_WEBHOOK_URL },
  });
}

/**
 * Like loadConfig, but validates only PRICE_API_PROVIDER and PRICE_API_KEY, for tools
 * (such as the price history fetcher) that need nothing else.
 */
export function loadPriceApiConfig(
  env: Readonly<Record<string, string | undefined>>,
): PriceApiConfig {
  const e = validateVars(["PRICE_API_PROVIDER", "PRICE_API_KEY"], env);
  return deepFreeze({ provider: e.PRICE_API_PROVIDER, apiKey: e.PRICE_API_KEY });
}

type EnvValues = z.infer<typeof envSchema>;

/** Validates just `names`, throwing a ConfigError that lists every missing or invalid one. */
function validateVars<K extends EnvVarName>(
  names: readonly K[],
  env: Readonly<Record<string, string | undefined>>,
): Pick<EnvValues, K> {
  const input: Partial<Record<EnvVarName, string>> = {};
  const missing: EnvVarName[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) input[name] = value;
    else missing.push(name);
  }

  // Missing names were collected above; partial() validates only the ones present.
  const result = envSchema.partial().safeParse(input);
  const invalid: InvalidEnvVar[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = issue.path[0] as EnvVarName;
      if (!missing.includes(name) && !invalid.some((i) => i.name === name)) {
        invalid.push({ name, reason: issue.message });
      }
    }
  }

  if (!result.success || missing.length > 0) throw new ConfigError(missing, invalid);
  return result.data as Pick<EnvValues, K>;
}

function deepFreeze<T extends object>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null) deepFreeze(value);
  }
  return Object.freeze(obj);
}
