import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Candle } from "./candle.js";

const cacheSchema = z.array(
  z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number().nullable(),
  }),
);

/** Path of a token's cache file: `<dir>/<SYMBOL>.json`. */
export function cacheFile(dir: string, symbol: string): string {
  return join(dir, `${symbol}.json`);
}

/** Reads cached candles, or [] if the file does not exist. Throws on a corrupt file. */
export async function readCache(path: string): Promise<Candle[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    return cacheSchema.parse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`${path} is not a valid candle cache (${reason}); delete it to re-download`, {
      cause: err,
    });
  }
}

/**
 * Writes candles as a JSON array, one candle per line. Writes to a temporary file and
 * renames it into place, so an interrupted run never leaves a half-written cache.
 */
export async function writeCache(path: string, candles: readonly Candle[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body =
    candles.length === 0
      ? "[]\n"
      : `[\n${candles.map((c) => `  ${JSON.stringify(c)}`).join(",\n")}\n]\n`;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}
