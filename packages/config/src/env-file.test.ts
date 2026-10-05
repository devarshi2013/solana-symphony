import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findEnvFile, readEnvFile } from "./env-file.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "config-test-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "apps", "keeper"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findEnvFile", () => {
  it("finds a .env at the workspace root from a nested package", () => {
    writeFileSync(join(root, ".env"), "A=1\n");
    expect(findEnvFile(join(root, "apps", "keeper"))).toBe(join(root, ".env"));
  });

  it("prefers the nearest .env", () => {
    writeFileSync(join(root, ".env"), "A=1\n");
    writeFileSync(join(root, "apps", "keeper", ".env"), "A=2\n");
    expect(findEnvFile(join(root, "apps", "keeper"))).toBe(join(root, "apps", "keeper", ".env"));
  });

  it("does not search above the workspace root", () => {
    expect(findEnvFile(join(root, "apps", "keeper"))).toBeUndefined();
  });
});

describe("readEnvFile", () => {
  it("parses comments, quotes, and blank lines", () => {
    const path = join(root, ".env");
    writeFileSync(path, '# comment\nA=1\n\nB="two words"\n');
    expect(readEnvFile(path)).toEqual({ A: "1", B: "two words" });
  });
});
