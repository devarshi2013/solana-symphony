import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The nearest directory at or above `start` containing pnpm-workspace.yaml. */
export function findWorkspaceRoot(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) throw new Error("not inside the solana-symphony workspace");
  }
}

/** `<repo>/data/cache`, found from the current directory. */
export function defaultCacheDir(): string {
  return join(findWorkspaceRoot(process.cwd()), "data", "cache");
}
