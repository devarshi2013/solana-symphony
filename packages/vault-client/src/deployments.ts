// Reads deployments/<cluster>.json, written by scripts/deploy-devnet.ts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

const pubkey = z.string().refine((s) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}, "not a valid base58 public key");

const program = z.object({ programId: pubkey, build: z.string(), sha256: z.string() });

const DeploymentSchema = z.object({
  cluster: z.string(),
  rpc: z.string(),
  genesisHash: z.string(),
  updatedAt: z.string(),
  deployer: pubkey,
  programs: z.object({ vault: program, mockSwap: program.optional() }),
  mints: z.record(
    z.string(),
    z.object({
      address: pubkey,
      decimals: z.number().int().min(0).max(18),
      pythFeedId: z.string().regex(/^[0-9a-f]{64}$/, "64 hex characters"),
      pythPriceAccount: pubkey,
    }),
  ),
  mockSwap: z
    .object({
      market: pubkey,
      admin: pubkey,
      liquidityAccounts: z.record(z.string(), pubkey),
    })
    .optional(),
});

export type Deployment = z.infer<typeof DeploymentSchema>;
export type DeployedMint = Deployment["mints"][string];

/** Thrown when a deployment file is missing or malformed. */
export class DeploymentError extends Error {
  override name = "DeploymentError";
}

/**
 * Finds `deployments/<cluster>.json`: in `dir` if given, else in the nearest `deployments/`
 * directory at or above `from` (default: the working directory).
 */
export function deploymentPath(cluster: string, options: { dir?: string; from?: string } = {}) {
  if (!/^[a-z0-9-]+$/.test(cluster)) throw new DeploymentError(`invalid cluster name: ${cluster}`);
  if (options.dir) return join(resolve(options.dir), `${cluster}.json`);
  let current = resolve(options.from ?? process.cwd());
  for (;;) {
    const candidate = join(current, "deployments", `${cluster}.json`);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) {
      throw new DeploymentError(
        `deployments/${cluster}.json not found at or above ${options.from ?? process.cwd()}; ` +
          `run the deploy script (pnpm deploy:devnet) first`,
      );
    }
    current = parent;
  }
}

/** Parses and validates a deployment; `source` names it in error messages. */
export function parseDeployment(json: unknown, source = "deployment"): Deployment {
  const result = DeploymentSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new DeploymentError(`${source} is invalid: ${issues}`);
  }
  return result.data;
}

/** Loads `deployments/<cluster>.json` (see `deploymentPath`). */
export function loadDeployment(cluster: string, options: { dir?: string; from?: string } = {}) {
  const path = deploymentPath(cluster, options);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new DeploymentError(`cannot read ${path}: ${(e as Error).message}`);
  }
  return parseDeployment(json, path);
}
