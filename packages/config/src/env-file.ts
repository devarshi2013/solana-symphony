import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Finds the nearest `.env` walking up from `startDir`. Stops at the workspace root
 * (the directory containing pnpm-workspace.yaml) so it never picks up a stray file above it.
 */
export function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Parses a dotenv file into a plain object. Does not touch process.env. */
export function readEnvFile(path: string): Record<string, string> {
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
}
