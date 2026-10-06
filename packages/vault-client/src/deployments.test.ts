import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deploymentPath, loadDeployment, parseDeployment } from "./deployments.js";
import { sampleDeployment } from "./test-fixtures.js";

describe("parseDeployment", () => {
  it("accepts a deployment written by the deploy script", () => {
    const d = parseDeployment(sampleDeployment());
    expect(d.mints.tUSDC?.decimals).toBe(6);
  });

  it("names every invalid field", () => {
    const bad = sampleDeployment();
    bad.deployer = "not-a-key";
    bad.mints.tSOL!.pythFeedId = "xyz";
    expect(() => parseDeployment(bad, "devnet.json")).toThrow(
      /devnet\.json is invalid: deployer: not a valid base58 public key; mints\.tSOL\.pythFeedId/,
    );
  });
});

describe("loadDeployment", () => {
  it("finds deployments/<cluster>.json in a parent directory", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-client-"));
    mkdirSync(join(root, "deployments"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "deployments", "devnet.json"), JSON.stringify(sampleDeployment()));
    expect(deploymentPath("devnet", { from: join(root, "a", "b") })).toBe(
      join(root, "deployments", "devnet.json"),
    );
    expect(loadDeployment("devnet", { dir: join(root, "deployments") }).cluster).toBe("devnet");
  });

  it("explains a missing file and rejects odd cluster names", () => {
    const empty = mkdtempSync(join(tmpdir(), "vault-client-"));
    expect(() => loadDeployment("devnet", { dir: empty })).toThrow(/cannot read/);
    expect(() => deploymentPath("../etc/passwd")).toThrow(/invalid cluster name/);
  });
});
