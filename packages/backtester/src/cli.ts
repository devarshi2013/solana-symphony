#!/usr/bin/env node
// Backtest CLI. Usage: pnpm backtest <strategy.json> [--start] [--end] [--capital] [--benchmark]

import { spawn } from "node:child_process";
import { main } from "./command.js";

/** Opens a file with the OS default app. Best effort: returns false if it cannot. */
function openFile(path: string): boolean {
  if (process.env.CI) return false;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // e.g. no xdg-open on a headless server
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// pnpm runs root scripts from the repo root; INIT_CWD is where the user ran the command.
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.env.INIT_CWD ?? process.cwd(),
  open: openFile,
});
