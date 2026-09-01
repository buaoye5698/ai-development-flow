import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { digestJson } from "../src/core/canonical.mjs";
import { snapshotDecisionDependency, snapshotStageGate } from "../src/task/index.mjs";
import { digestDeclaredInputs } from "../src/verify/cache.mjs";
import {
  computeWorktreeSnapshot,
  frameworkProcessArtifactPrefixes,
} from "../src/verify/git-scope.mjs";
import { mapWithConcurrency } from "../src/verify/process-runner.mjs";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(frameworkRoot, "bin", "ai-flow.mjs");

function execResult(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout,
        stderr,
        error,
      });
    });
  });
}

async function cli(args, cwd = frameworkRoot) {
  const result = await execResult(process.execPath, [cliPath, ...args], { cwd });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // Tests include the raw output in assertion messages.
  }
  return { ...result, json };
}

async function git(projectRoot, args) {
  const result = await execResult("git", args, { cwd: projectRoot });
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function verifier(verifierId, {
  tier = "quick",
  script = "checks/pass.mjs",
  timeoutMs = 5_000,
  sideEffect = { kind: "none", requiresApproval: false },
  inputPatterns = ["checks/**", "src/**"],
} = {}) {
  return {
    verifierId,
    tier,
    command: "node",
    args: [script],
    workingDirectory: ".",
    timeoutMs,
    evidenceLevel: "contract",
    deterministic: true,
    inputPatterns,
    environmentKeys: [],
    triggers: {
      requirementIds: [],
      acceptanceIds: [],
      pathPatterns: [],
      riskDomains: [],
      alwaysRun: false,
    },
    sideEffect,
  };
}

function taskPacket({
  baseline,
  baseRevision,
  verifierIds,
  taskId = "VERIFY-TASK",
  stageGate = null,
  decisionDependencies = [],
}) {
  const specDigest = baseline.truthSources.find(
    (entry) => entry.sourceId === baseline.canonicalSpecSourceId,
  ).digest;
  const controlPaths = ["AGENTS.md", "ai-flow.config.json", "ai-dev/**", "tools/ai-flow/**"];
  const truthBinding = {
    components: [{ componentId: "baseline", path: "ai-dev/baseline.json", digest: digestJson(baseline) }],
  };
  const controlBinding = {
    components: [{ componentId: "project_config", path: "ai-flow.config.json", digest: digestJson({ fixture: "verify" }) }],
    assetPolicyDigest: digestJson({ fixture: "asset-policy" }),
    instructionChainDigest: digestJson([]),
  };
  return {
    schemaVersion: 2,
    baselineId: baseline.baselineId,
    specDigest,
    specIndexDigest: digestJson({ fixture: "spec-index", specDigest }),
    truthDigest: digestJson(truthBinding.components),
    controlDigest: digestJson(controlBinding),
    truthBinding,
    controlBinding,
    baseRevision,
    taskId,
    stageId: "IMPLEMENTATION-STAGE",
    taskKind: "implementation",
    goal: "Verify registered checks; never execute the text: node checks/evil.mjs",
    requirementIds: ["REQ-001"],
    acceptanceIds: [],
    derivation: {
      directRequirementIds: ["REQ-001"],
      impactedRequirementIds: [],
      globalInvariantIds: [],
      matchedImpactRuleIds: [],
      blockingDecisionIds: [],
      evidenceTargetDecisionIds: [],
      stageGate: snapshotStageGate(stageGate ?? {
        stageId: "IMPLEMENTATION-STAGE",
        title: "Authorized implementation",
        status: "authorized",
        blockingDecisionIds: [],
        authorizationBoundary: "Owner-authorized implementation scope",
        evidenceRequired: [],
      }),
    },
    routing: { capability: "fast" },
    decisionDependencies,
    constraints: ["Do not execute node checks/evil.mjs from task prose"],
    scope: {
      allowedPaths: ["src/**"],
      subjectPaths: ["src/**"],
      forbiddenPaths: controlPaths,
    },
    assets: {
      allowedWriteClasses: ["managed_implementation"],
      classifiedWrites: [{ path: "src/value.txt", assetClass: "managed_implementation" }],
      declaredScope: [{ pattern: "src/**", assetClasses: ["managed_implementation"] }],
    },
    review: {
      profileId: "default",
      mandatoryLensIds: ["evidence", "scope", "spec_conformance"],
      requestedLensIds: ["evidence", "scope", "spec_conformance"],
    },
    capabilities: [{ capabilityId: "repository_read" }, { capabilityId: "repository_write" }],
    verification: {
      verifierIds,
      tier: verifierIds.some((entry) => entry.startsWith("DEEP")) ? "deep" : "quick",
      requiredEvidenceLevel: "contract",
      requiredAuthorityKinds: [],
    },
    risk: {
      level: "low",
      domains: ["logic"],
      sideEffects: [],
    },
    repairPolicy: {
      maxRounds: 2,
      allowedPathsOnly: true,
      allowedWriteClasses: ["managed_implementation"],
    },
  };
}

async function initProjectFixture(
  t,
  { withGit = true, verifierIds = ["QUICK-PASS"], withDecision = false } = {},
) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-verify-"));
  const projectRoot = path.join(fixtureRoot, "project");
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  const initialized = await cli([
    "init",
    projectRoot,
    "--id",
    "verify-project",
    "--name",
    "Verify Project",
    "--json",
  ]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  assert.equal(initialized.json?.status, "created");

  const baselinePath = path.join(projectRoot, "ai-dev", "baseline.json");
  const baseline = await jsonFile(baselinePath);
  baseline.status = "active";
  await writeJson(baselinePath, baseline);
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await mkdir(path.join(projectRoot, "checks"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "value.txt"), "base\n", "utf8");
  await writeFile(path.join(projectRoot, "checks", "pass.mjs"), 'process.stdout.write("pass\\n");\n', "utf8");
  await writeFile(
    path.join(projectRoot, "checks", "fail.mjs"),
    'process.stderr.write("deep failure\\n"); process.exitCode = 1;\n',
    "utf8",
  );
  await writeFile(path.join(projectRoot, "checks", "timeout.mjs"), "setInterval(() => {}, 1_000);\n", "utf8");
  const grandchildReady = path.join(projectRoot, ".ai-flow", "grandchild-ready");
  const grandchildMarker = path.join(projectRoot, ".ai-flow", "grandchild-marker");
  const grandchildSource = `const fs = require("node:fs");
const ready = ${JSON.stringify(grandchildReady)};
const marker = ${JSON.stringify(grandchildMarker)};
fs.writeFileSync(ready, String(Date.now()));
setTimeout(() => fs.writeFileSync(marker, "escaped\\n"), 2500);
setInterval(() => {}, 1000);`;
  await writeFile(
    path.join(projectRoot, "checks", "grandchild.mjs"),
    `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const ready = ${JSON.stringify(grandchildReady)};
spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {
  detached: false,
  stdio: "ignore"
});
const waiter = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(ready)) Atomics.wait(waiter, 0, 0, 10);
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "checks", "marker.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile(new URL("../.ai-flow/should-not-exist", import.meta.url), "executed\\n");\n',
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "checks", "evil.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile(new URL("../.ai-flow/evil-executed", import.meta.url), "executed\\n");\n',
    "utf8",
  );
  await writeJson(path.join(projectRoot, "ai-dev", "verifiers", "registry.json"), {
    schemaVersion: 1,
    registryId: "TEST-VERIFIERS",
    verifiers: [
      verifier("QUICK-PASS"),
      verifier("DEEP-FAIL", { tier: "deep", script: "checks/fail.mjs" }),
      verifier("QUICK-TIMEOUT", { script: "checks/timeout.mjs", timeoutMs: 100 }),
      verifier("QUICK-GRANDCHILD", { script: "checks/grandchild.mjs", timeoutMs: 1_500 }),
      verifier("QUICK-IGNORED", { inputPatterns: ["checks/**", "src/**", "ignored/**"] }),
      verifier("QUICK-PROCESS", { inputPatterns: ["checks/**", "src/**", "ai-dev/**"] }),
      verifier("QUICK-UNCOVERED", { inputPatterns: ["checks/**"] }),
      verifier("QUICK-MARKER", {
        script: "checks/marker.mjs",
        sideEffect: { kind: "filesystem", requiresApproval: false },
      }),
    ],
    globalInvariantVerifierIds: [],
  });
  const decisionRegisterPath = path.join(projectRoot, "ai-dev", "decisions", "register.json");
  const decisionRegister = await jsonFile(decisionRegisterPath);
  decisionRegister.status = "resolved";
  const stageGate = {
    stageId: "IMPLEMENTATION-STAGE",
    title: "Authorized implementation",
    status: "authorized",
    blockingDecisionIds: withDecision ? ["DEC-001"] : [],
    evidenceRequired: [],
    authorizationBoundary: "Owner-authorized implementation scope",
  };
  decisionRegister.stageGates = [stageGate];
  if (withDecision) {
    decisionRegister.decisions = [{
      decisionId: "DEC-001",
      question: "Which bounded strategy is authorized?",
      status: "resolved",
      owner: "Owner",
      options: [{
        optionId: "OPT-A",
        description: "Use strategy A.",
      }, {
        optionId: "OPT-B",
        description: "Use strategy B.",
      }],
      dependencies: [],
      blockedStageIds: ["IMPLEMENTATION-STAGE"],
      relatedRequirementIds: ["REQ-001"],
      relatedAcceptanceIds: [],
      resolutionEvidence: ["owner://decision/DEC-001/v1"],
      selectedOptionId: "OPT-A",
      decidedBy: "Owner",
      resolvedAt: "2026-08-27T09:00:00Z",
      notes: "Initial authorization.",
    }];
  }
  await writeJson(decisionRegisterPath, decisionRegister);
  await writeFile(path.join(projectRoot, ".gitignore"), `${await readFile(path.join(projectRoot, ".gitignore"), "utf8")}ignored/\n`, "utf8");
  await mkdir(path.join(projectRoot, "ignored"), { recursive: true });
  await writeFile(path.join(projectRoot, "ignored", "input.txt"), "ignored-v1\n", "utf8");

  if (!withGit) return { fixtureRoot, projectRoot, baseline, baseRevision: null, taskPath: null };
  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "AI Flow Tests"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "baseline"]);
  const baseRevision = await git(projectRoot, ["rev-parse", "HEAD"]);
  const task = taskPacket({
    baseline,
    baseRevision,
    verifierIds,
    stageGate,
    decisionDependencies: decisionRegister.decisions.map(snapshotDecisionDependency),
  });
  const taskPath = path.join(projectRoot, "ai-dev", "tasks", `${task.taskId}.json`);
  await writeJson(taskPath, task);
  await writeFile(path.join(projectRoot, "src", "value.txt"), "changed\n", "utf8");
  return {
    fixtureRoot,
    projectRoot,
    baseline,
    baseRevision,
    taskPath,
    task,
    taskDigest: digestJson(task),
    baselinePath,
    decisionRegisterPath,
    decisionRegister,
  };
}

function taskVerifyArgs(fixture, tier, task = "VERIFY-TASK", expectedTaskDigest = fixture.taskDigest) {
  return [
    "verify",
    "--project",
    fixture.projectRoot,
    "--task",
    task,
    "--expected-task-digest",
    expectedTaskDigest,
    "--tier",
    tier,
    "--json",
  ];
}

test("a quick run of a deep task is partial and deep execution includes both tiers", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-PASS", "DEEP-FAIL"] });
  const quickArgs = taskVerifyArgs(fixture, "quick");
  const first = await cli(quickArgs);
  assert.equal(first.code, 2, first.stderr || first.stdout);
  assert.equal(first.json.status, "partial");
  assert.equal(first.json.complete, false);
  assert.equal(first.json.requiredTier, "deep");
  assert.equal(first.json.executedTier, "quick");
  assert.deepEqual(first.json.selectedVerifierIds, ["QUICK-PASS"]);
  assert.deepEqual(first.json.deferredVerifierIds, ["DEEP-FAIL"]);
  assert.equal(first.json.results[0].cacheHit, false);
  assert.equal(first.json.results[0].status, "partial");
  assert.equal(first.json.results[0].complete, false);
  assert.match(first.json.results[0].outputDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(first.json.results[0].resultDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.json.results[0].expectedTaskDigest, fixture.taskDigest);

  const deep = await cli(taskVerifyArgs(fixture, "deep"));
  assert.equal(deep.code, 1, deep.stderr || deep.stdout);
  assert.equal(deep.json.status, "fail");
  assert.equal(deep.json.complete, true);
  assert.deepEqual(deep.json.selectedVerifierIds, ["DEEP-FAIL", "QUICK-PASS"]);
  assert.equal(deep.json.results.find((entry) => entry.verifierId === "DEEP-FAIL").status, "fail");
});

test("successful cache reuse and ignored input invalidation are deterministic", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-PASS"] });
  const quickArgs = taskVerifyArgs(fixture, "quick");
  const first = await cli(quickArgs);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(first.json.status, "pass");
  assert.equal(first.json.results[0].cacheHit, false);
  const firstWorktreeDigest = first.json.worktreeDigest;
  const { resultDigest, ...unsignedResult } = first.json.results[0];
  assert.equal(resultDigest, digestJson(unsignedResult));

  const second = await cli(quickArgs);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(second.json.cacheHits, 1);
  assert.equal(second.json.results[0].cacheHit, true);
  assert.equal(second.json.results[0].taskId, "VERIFY-TASK");
  assert.equal(second.json.worktreeDigest, firstWorktreeDigest);

  await writeFile(path.join(fixture.projectRoot, "src", "value.txt"), "changed-again\n", "utf8");
  const invalidated = await cli(quickArgs);
  assert.equal(invalidated.code, 0, invalidated.stderr || invalidated.stdout);
  assert.equal(invalidated.json.results[0].cacheHit, false);
  assert.notEqual(invalidated.json.worktreeDigest, firstWorktreeDigest);
  assert.notEqual(invalidated.json.subjectRevision, first.json.subjectRevision);
  await assert.rejects(access(path.join(fixture.projectRoot, ".ai-flow", "evil-executed")));
});

test("process artifacts stay outside content snapshots while Active Control judge inputs remain bound", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-PASS"] });
  const config = await jsonFile(path.join(fixture.projectRoot, "ai-flow.config.json"));
  const snapshot = () => computeWorktreeSnapshot(
    fixture.projectRoot,
    fixture.baseRevision,
    { excludedPrefixes: frameworkProcessArtifactPrefixes(config) },
  );
  const before = await snapshot();
  const authorityDirectory = path.join(fixture.projectRoot, "ai-dev", "evidence", "authority");
  const receiptPath = path.join(authorityDirectory, "owner.json");
  await mkdir(authorityDirectory, { recursive: true });
  await writeJson(receiptPath, { fixture: "owner-v1" });
  const afterCreate = await snapshot();
  assert.equal(afterCreate.worktreeDigest, before.worktreeDigest);
  assert.equal(afterCreate.subjectRevision, before.subjectRevision);

  await writeJson(receiptPath, { fixture: "owner-v2" });
  const afterModify = await snapshot();
  assert.equal(afterModify.worktreeDigest, before.worktreeDigest);
  assert.equal(afterModify.subjectRevision, before.subjectRevision);

  const judgeInputs = [
    "ai-flow.config.json",
    "ai-dev/baseline.json",
    "ai-dev/verifiers/registry.json",
    "ai-dev/impact-map.json",
    "tools/ai-flow/schemas/task-packet.schema.json",
  ];
  for (const relativePath of judgeInputs) {
    const absolutePath = path.join(fixture.projectRoot, ...relativePath.split("/"));
    const original = await readFile(absolutePath, "utf8");
    await writeFile(absolutePath, original + " ", "utf8");
    const changed = await snapshot();
    assert.notEqual(changed.worktreeDigest, before.worktreeDigest, relativePath);
    await writeFile(absolutePath, original, "utf8");
  }

  const taskOriginal = await readFile(fixture.taskPath, "utf8");
  await writeFile(fixture.taskPath, `${taskOriginal} `, "utf8");
  const afterTaskMutation = await snapshot();
  assert.equal(afterTaskMutation.worktreeDigest, before.worktreeDigest);
  await writeFile(fixture.taskPath, taskOriginal, "utf8");
});

test("process artifacts stay outside verifier input digests", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-PROCESS"] });
  const args = taskVerifyArgs(fixture, "quick");
  const first = await cli(args);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(first.json.results[0].cacheHit, false);

  const authorityDirectory = path.join(fixture.projectRoot, "ai-dev", "evidence", "authority");
  await mkdir(authorityDirectory, { recursive: true });
  await writeJson(path.join(authorityDirectory, "owner.json"), { fixture: "owner" });
  const afterProcessWrite = await cli(args);
  assert.equal(afterProcessWrite.code, 0, afterProcessWrite.stderr || afterProcessWrite.stdout);
  assert.equal(afterProcessWrite.json.results[0].cacheHit, true);
  assert.equal(afterProcessWrite.json.results[0].inputDigest, first.json.results[0].inputDigest);

  await writeFile(path.join(fixture.projectRoot, "src", "value.txt"), "changed-again\n", "utf8");
  const afterSubjectWrite = await cli(args);
  assert.equal(afterSubjectWrite.code, 0, afterSubjectWrite.stderr || afterSubjectWrite.stdout);
  assert.equal(afterSubjectWrite.json.results[0].cacheHit, false);
  assert.notEqual(afterSubjectWrite.json.results[0].inputDigest, first.json.results[0].inputDigest);
});

test("gitignored declared inputs participate in the deterministic cache key", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-IGNORED"] });
  const args = taskVerifyArgs(fixture, "quick");
  const first = await cli(args);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(first.json.results[0].cacheHit, false);
  const second = await cli(args);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(second.json.results[0].cacheHit, true);

  await writeFile(path.join(fixture.projectRoot, "ignored", "input.txt"), "ignored-v2\n", "utf8");
  const changed = await cli(args);
  assert.equal(changed.code, 0, changed.stderr || changed.stdout);
  assert.equal(changed.json.results[0].cacheHit, false);
  assert.notEqual(changed.json.results[0].inputDigest, first.json.results[0].inputDigest);
});

test("registered timeout produces a structured timeout result", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-TIMEOUT"] });
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.json.status, "fail");
  assert.equal(result.json.results[0].status, "timeout");
  assert.equal(result.json.results[0].exitCode, null);
});

test("Git scope violations block before a registered verifier can run", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-PASS"] });
  await writeFile(path.join(fixture.projectRoot, "AGENTS.md"), "out of scope\n", "utf8");
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.status, "blocked");
  assert.equal(result.json.code, "TASK_SCOPE_VIOLATION");
  assert.ok(result.json.errors.some((entry) => entry.code === "SCOPE_CHANGE_FORBIDDEN"));
  await assert.rejects(access(path.join(fixture.projectRoot, ".ai-flow", "should-not-exist")));
});

test("non-Git projects are explicitly blocked instead of claiming verification", async (t) => {
  const fixture = await initProjectFixture(t, { withGit: false });
  const result = await cli([
    "verify", "--project", fixture.projectRoot, "--tier", "quick", "--json",
  ]);
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.status, "blocked");
  assert.equal(result.json.code, "GIT_SCOPE_UNAVAILABLE");
  assert.ok(result.json.errors.some((entry) => entry.code === "GIT_REPOSITORY_REQUIRED"));
});

test("unknown verifier IDs are blocked and cannot fall back to task prose", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["UNKNOWN-VERIFIER"] });
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.code, "VERIFICATION_PLAN_INVALID");
  assert.ok(result.json.errors.some((entry) => entry.code === "VERIFIER_UNKNOWN"));
  await assert.rejects(access(path.join(fixture.projectRoot, ".ai-flow", "evil-executed")));
});

test("task arguments outside the protected task directory are rejected", async (t) => {
  const fixture = await initProjectFixture(t);
  const forgedPath = path.join(fixture.projectRoot, "src", "forged-task.json");
  await writeJson(forgedPath, fixture.task);
  const result = await cli(taskVerifyArgs(fixture, "quick", "src/forged-task.json"));
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.code, "VERIFICATION_PLAN_INVALID");
  assert.ok(result.json.errors.some((entry) => entry.code === "TASK_PATH_INVALID"));
});

test("task verification is blocked without the controller digest, on mismatch, and after task mutation", async (t) => {
  const fixture = await initProjectFixture(t);
  const missing = await cli([
    "verify", "--project", fixture.projectRoot, "--task", "VERIFY-TASK", "--tier", "quick", "--json",
  ]);
  assert.equal(missing.code, 2, missing.stderr || missing.stdout);
  assert.equal(missing.json.code, "TASK_DIGEST_REQUIRED");

  const mismatch = await cli(taskVerifyArgs(
    fixture,
    "quick",
    "VERIFY-TASK",
    `sha256:${"0".repeat(64)}`,
  ));
  assert.equal(mismatch.code, 2, mismatch.stderr || mismatch.stdout);
  assert.equal(mismatch.json.code, "TASK_DIGEST_MISMATCH");

  const mutated = { ...fixture.task, goal: "Mutated self-authorization attempt" };
  await writeJson(fixture.taskPath, mutated);
  const afterMutation = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(afterMutation.code, 2, afterMutation.stderr || afterMutation.stdout);
  assert.equal(afterMutation.json.code, "TASK_DIGEST_MISMATCH");
});

test("candidate truth and control edits cannot replace the base revision judge", async (t) => {
  const fixture = await initProjectFixture(t, { withDecision: true });
  const changedGate = structuredClone(fixture.decisionRegister);
  changedGate.stageGates[0].title = "Changed authorization title";
  await writeJson(fixture.decisionRegisterPath, changedGate);
  const inactiveBaseline = structuredClone(fixture.baseline);
  inactiveBaseline.status = "draft";
  await writeJson(fixture.baselinePath, inactiveBaseline);
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.code, "TASK_SCOPE_VIOLATION");
  assert.equal(result.json.errors.some((entry) => entry.code === "SCOPE_CHANGE_FORBIDDEN"), true);
  assert.equal(result.json.errors.some((entry) => entry.code === "STALE_STAGE_GATE"), false);
  assert.equal(result.json.errors.some((entry) => entry.code === "BASELINE_NOT_ACTIVE"), false);
});

test("every changed path must be covered by a selected verifier input pattern", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-UNCOVERED"] });
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.code, "UNCOVERED_CHANGED_PATH");
  assert.ok(result.json.errors.some((entry) => entry.path === "src/value.txt"));
});

test("the built-in runner never executes a verifier that declares side effects", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-MARKER"] });
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 2, result.stderr || result.stdout);
  assert.equal(result.json.code, "VERIFICATION_PLAN_INVALID");
  assert.ok(result.json.errors.some((entry) => entry.code === "HUMAN_GATE_REQUIRED"));
  await assert.rejects(access(path.join(fixture.projectRoot, ".ai-flow", "should-not-exist")));
});

test("timeout kills the complete verifier process tree before returning", async (t) => {
  const fixture = await initProjectFixture(t, { verifierIds: ["QUICK-GRANDCHILD"] });
  const result = await cli(taskVerifyArgs(fixture, "quick"));
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.json.results[0].status, "timeout");
  const readyAt = Number(await readFile(path.join(fixture.projectRoot, ".ai-flow", "grandchild-ready"), "utf8"));
  assert.equal(Number.isFinite(readyAt), true, "grandchild start handshake");
  const observationDelay = Math.max(0, readyAt + 4_000 - Date.now());
  if (observationDelay > 0) await new Promise((resolve) => setTimeout(resolve, observationDelay));
  await assert.rejects(access(path.join(fixture.projectRoot, ".ai-flow", "grandchild-marker")));
});

test("declared input traversal rejects a directory junction instead of following it", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-input-link-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const externalRoot = path.join(fixtureRoot, "external");
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  await mkdir(path.join(projectRoot, "inputs"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(path.join(externalRoot, "value.txt"), "outside\n", "utf8");
  await symlink(externalRoot, path.join(projectRoot, "inputs", "linked"), "junction");
  await assert.rejects(
    digestDeclaredInputs({
      projectRoot,
      verifier: verifier("LINK-INPUT", { inputPatterns: ["inputs/**"] }),
    }),
    (error) => error.code === "VERIFIER_INPUT_SYMLINK",
  );
});

test("concurrency helper never exceeds its configured bound", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(maximum, 2);
});
