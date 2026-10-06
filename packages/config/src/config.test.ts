import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ENV_VARS,
  loadConfig,
  loadPriceApiConfig,
  type EnvVarName,
} from "./config.js";
import { readEnvFile } from "./env-file.js";

const validEnv: Record<EnvVarName, string> = {
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  SOLANA_CLUSTER: "devnet",
  KEEPER_KEYPAIR_PATH: "/home/me/keeper.json",
  PRICE_API_KEY: "price-secret-123",
  PRICE_API_PROVIDER: "birdeye",
  ANTHROPIC_API_KEY: "anthropic-secret-456",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  ALERT_WEBHOOK_URL: "https://hooks.example.com/abc",
};

function captureError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("returns a typed config for a valid environment", () => {
    expect(loadConfig(validEnv)).toEqual({
      solana: { rpcUrl: "https://api.devnet.solana.com", cluster: "devnet" },
      keeper: { keypairPath: "/home/me/keeper.json" },
      priceApi: { provider: "birdeye", apiKey: "price-secret-123" },
      anthropic: { apiKey: "anthropic-secret-456" },
      database: { url: "postgres://u:p@localhost:5432/db" },
      alerts: { webhookUrl: "https://hooks.example.com/abc" },
    });
  });

  it("returns a frozen config", () => {
    const config = loadConfig(validEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.solana)).toBe(true);
  });

  it("names a single missing variable", () => {
    const err = captureError({ ...validEnv, PRICE_API_KEY: undefined });
    expect(err.missing).toEqual(["PRICE_API_KEY"]);
    expect(err.message).toContain("Missing required environment variables: PRICE_API_KEY");
  });

  it("names every missing variable when the environment is empty", () => {
    const err = captureError({});
    expect(err.missing).toEqual(ENV_VARS);
    for (const name of ENV_VARS) expect(err.message).toContain(name);
  });

  it("treats empty and whitespace-only values as missing", () => {
    const err = captureError({ ...validEnv, DATABASE_URL: "", ANTHROPIC_API_KEY: "   " });
    expect(err.missing).toEqual(["ANTHROPIC_API_KEY", "DATABASE_URL"]);
  });

  it("reports invalid values by name", () => {
    const err = captureError({
      ...validEnv,
      SOLANA_CLUSTER: "mainnet",
      SOLANA_RPC_URL: "not-a-url",
      KEEPER_KEYPAIR_PATH: "keys/keeper.json",
    });
    expect(err.missing).toEqual([]);
    expect(err.invalid.map((i) => i.name).sort()).toEqual([
      "KEEPER_KEYPAIR_PATH",
      "SOLANA_CLUSTER",
      "SOLANA_RPC_URL",
    ]);
    expect(err.message).toContain("KEEPER_KEYPAIR_PATH: must be an absolute path");
  });

  it("rejects non-http RPC and webhook URLs", () => {
    const err = captureError({ ...validEnv, SOLANA_RPC_URL: "ftp://rpc.example.com" });
    expect(err.invalid.map((i) => i.name)).toEqual(["SOLANA_RPC_URL"]);
  });

  it("reports missing and invalid variables together", () => {
    const err = captureError({ ...validEnv, PRICE_API_KEY: undefined, SOLANA_CLUSTER: "x" });
    expect(err.missing).toEqual(["PRICE_API_KEY"]);
    expect(err.invalid.map((i) => i.name)).toEqual(["SOLANA_CLUSTER"]);
  });

  it("never includes variable values in the error message", () => {
    const err = captureError({ ...validEnv, SOLANA_RPC_URL: "not-a-url", DATABASE_URL: "" });
    expect(err.message).not.toContain("price-secret-123");
    expect(err.message).not.toContain("anthropic-secret-456");
    expect(err.message).not.toContain("not-a-url");
  });
});

describe("PRICE_API_PROVIDER", () => {
  it("accepts birdeye and coingecko", () => {
    expect(loadConfig({ ...validEnv, PRICE_API_PROVIDER: "coingecko" }).priceApi.provider).toBe(
      "coingecko",
    );
  });

  it("rejects other providers by name", () => {
    const err = captureError({ ...validEnv, PRICE_API_PROVIDER: "kaiko" });
    expect(err.invalid.map((i) => i.name)).toEqual(["PRICE_API_PROVIDER"]);
    expect(err.message).toContain('expected one of "birdeye"|"coingecko"');
  });
});

describe("loadPriceApiConfig", () => {
  it("needs only the price API variables", () => {
    expect(loadPriceApiConfig({ PRICE_API_PROVIDER: "birdeye", PRICE_API_KEY: "k" })).toEqual({
      provider: "birdeye",
      apiKey: "k",
    });
  });

  it("names only its own missing variables", () => {
    try {
      loadPriceApiConfig({ PRICE_API_PROVIDER: "birdeye" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toEqual(["PRICE_API_KEY"]);
    }
  });
});

describe(".env.example", () => {
  it("lists every variable with a value that passes validation", () => {
    const examplePath = fileURLToPath(new URL("../../../.env.example", import.meta.url));
    const example = readEnvFile(examplePath);
    expect(Object.keys(example).sort()).toEqual([...ENV_VARS].sort());
    expect(() => loadConfig(example)).not.toThrow();
  });
});
