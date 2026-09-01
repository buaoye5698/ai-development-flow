import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { digestFileContent } from "../src/cli/digest.mjs";
import { digestJson } from "../src/core/canonical.mjs";

const execute = promisify(execFile);
const frameworkRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(frameworkRoot, "bin", "ai-flow.mjs");

async function runCli(args) {
  try {
    const result = await execute(process.execPath, [cliPath, ...args], {
      cwd: frameworkRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function initializedProject(t, prefix = "ai-flow-upgrade-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "project");
  const result = await runCli(["init", target, "--id", "upgrade-project", "--json"]);
  assert.equal(result.code, 0, result.stdout);
  return target;
}

function json(result) {
  return JSON.parse(result.stdout);
}

test("upgrade-check reports a newly initialized project as current", async (t) => {
  const target = await initializedProject(t);
  const result = await runCli(["upgrade-check", target, "--json"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(json(result).status, "current");
  assert.deepEqual(json(result).changes, []);
});

test("doctor tolerates CRLF conversion but upgrade-check blocks semantic managed-file drift", async (t) => {
  const target = await initializedProject(t, "ai-flow-line-endings-");
  const managed = path.join(target, "tools", "ai-flow", "src", "spec", "structured-markdown.mjs");
  const original = await readFile(managed, "utf8");
  await writeFile(managed, original.replace(/\r?\n/gu, "\r\n"), "utf8");

  const lineEndingOnly = await runCli(["doctor", target, "--json"]);
  assert.equal(lineEndingOnly.code, 0, lineEndingOnly.stdout);

  await writeFile(managed, `${original}\nexport const localChange = true;\n`, "utf8");
  const drift = await runCli(["upgrade-check", target, "--json"]);
  assert.equal(drift.code, 2);
  const result = json(drift);
  assert.equal(result.status, "blocked");
  assert.equal(result.errors.some((entry) => entry.code === "MANAGED_FILE_DRIFT"), true);
});

test("upgrade-check reports rolling content availability without mutating the project", async (t) => {
  const target = await initializedProject(t, "ai-flow-rolling-content-");
  const lockPath = path.join(target, "ai-dev", "framework-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const managedRelativePath = "tools/ai-flow/src/cli/constants.mjs";
  const managedPath = path.join(target, ...managedRelativePath.split("/"));
  const installedContent = `${await readFile(managedPath, "utf8")}\n// Earlier content from the same rolling compatibility line.\n`;
  await writeFile(managedPath, installedContent, "utf8");
  const managedEntry = lock.managedFiles.find((entry) => entry.path === managedRelativePath);
  assert.ok(managedEntry);
  managedEntry.digest = digestFileContent(managedRelativePath, Buffer.from(installedContent, "utf8"));
  lock.distributionDigest = digestJson({
    frameworkName: lock.frameworkName,
    frameworkVersion: lock.frameworkVersion,
    managedFiles: lock.managedFiles,
  });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  const lockBefore = await readFile(lockPath, "utf8");
  const managedBefore = await readFile(managedPath, "utf8");

  const result = await runCli(["upgrade-check", target, "--json"]);
  assert.equal(result.code, 0, result.stdout);
  const report = json(result);
  assert.equal(report.status, "update_available");
  assert.equal(report.currentVersion, "1.0.0");
  assert.equal(report.installedVersion, "1.0.0");
  assert.equal(report.changes.some((entry) => entry.action === "replace" && entry.path === managedRelativePath), true);
  assert.equal(await readFile(lockPath, "utf8"), lockBefore);
  assert.equal(await readFile(managedPath, "utf8"), managedBefore);
});

test("upgrade-check requires the exact rolling distribution digest", async (t) => {
  const target = await initializedProject(t, "ai-flow-rolling-digest-");
  const lockPath = path.join(target, "ai-dev", "framework-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.managedFiles.reverse();
  lock.distributionDigest = digestJson({
    frameworkName: lock.frameworkName,
    frameworkVersion: lock.frameworkVersion,
    managedFiles: lock.managedFiles,
  });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  const before = await readFile(lockPath, "utf8");

  const doctor = await runCli(["doctor", target, "--json"]);
  assert.equal(doctor.code, 0, doctor.stdout);
  const result = await runCli(["upgrade-check", target, "--json"]);
  assert.equal(result.code, 0, result.stdout);
  const report = json(result);
  assert.equal(report.status, "update_available");
  assert.equal(report.currentVersion, "1.0.0");
  assert.equal(report.installedVersion, "1.0.0");
  assert.deepEqual(report.changes, []);
  assert.equal(await readFile(lockPath, "utf8"), before);
});

test("canonical specification drift blocks doctor and upgrade claims", async (t) => {
  const target = await initializedProject(t, "ai-flow-spec-drift-");
  const specPath = path.join(target, "docs", "product-spec.md");
  await writeFile(specPath, `${await readFile(specPath, "utf8")}\nnew product fact\n`, "utf8");

  const doctor = await runCli(["doctor", target, "--json"]);
  assert.equal(doctor.code, 2);
  assert.equal(json(doctor).errors.some((entry) => entry.code === "SPEC_DIGEST_DRIFT"), true);

  const upgrade = await runCli(["upgrade-check", target, "--json"]);
  assert.equal(upgrade.code, 2);
  assert.equal(json(upgrade).code, "PROJECT_HEALTH_FAILED");
});
