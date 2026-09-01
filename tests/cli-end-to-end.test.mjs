import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildAuthorityReceiptBinding,
  canonicalTextDigest,
  computeAuthorityReceiptDigest,
  computeEvidenceBundleDigest,
  computeVerificationResultDigest,
  digestJson,
} from "../src/core/index.mjs";
import {
  computeReviewContextDigest,
} from "../src/workflow/index.mjs";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootCli = path.join(frameworkRoot, "bin", "ai-flow.mjs");

const SPEC = `# Neutral Example Specification

> 版本：1.0.0
> 状态：active

## 1. 来源登记

| 来源 ID | 标题 | authority | 路径 |
|---|---|---|---|
| SRC-001 | Owner input | authoritative_input | docs/owner-input.md |

## 2. 规范性需求

**REQ-001（必须｜core）** 系统必须保存有效记录。
验收：记录在处理完成后可查询。

## 3. 验收矩阵

| 验收 ID | 标题 | 通过条件 |
|---|---|---|
| AT-001 | 保存记录 | 处理完成；记录可查询 |

## 4. 需求追踪

| 需求 ID | 来源 ID | 验收 ID | 决策 ID |
|---|---|---|---|
| REQ-001 | SRC-001 | AT-001 | — |

## 5. 未决决策

无。
`;

function executeCli(cliPath, args, cwd = frameworkRoot) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      let value = null;
      try {
        value = JSON.parse(stdout);
      } catch {
        // Assertions include raw output when JSON parsing fails.
      }
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout,
        stderr,
        value,
      });
    });
  });
}

function executeProgram(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function git(projectRoot, args) {
  const result = await executeProgram("git", args, projectRoot);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function advanceCliRun({ cliPath, projectRoot, inputRef, runId, runRecord, request }) {
  await writeJson(path.join(projectRoot, ...inputRef.split("/")), request);
  const advanced = await executeCli(cliPath, [
    "run", "advance", "--project", projectRoot,
    "--run", runId,
    "--expected-run-digest", digestJson(runRecord),
    "--input", inputRef,
    "--json",
  ]);
  assert.equal(advanced.code, 0, advanced.stderr || advanced.stdout);
  return advanced.value.runRecord;
}

test("start rejects a relative worktree before reading or writing the project", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-start-reject-"));
  t.after(async () => rm(projectRoot, { recursive: true, force: true }));

  const started = await executeCli(rootCli, [
    "start", "--project", projectRoot,
    "--input", "missing.json",
    "--mode", "auto",
    "--worktree", "relative-worktree",
    "--json",
  ]);
  assert.equal(started.code, 2, started.stderr || started.stdout);
  assert.equal(started.value.code, "START_WORKTREE_NOT_ABSOLUTE");
  assert.deepEqual(await readdir(projectRoot), []);
});

test("start turns a three-field local request into in-place quick execution and preserves full isolation on request", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-start-e2e-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const specPath = path.join(fixtureRoot, "spec.md");
  const fullWorktreePath = path.join(fixtureRoot, "full-worktree");
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(specPath, SPEC, "utf8");

  const initialized = await executeCli(rootCli, [
    "init", projectRoot, "--id", "quick-example", "--spec", specPath, "--json",
  ]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const vendoredCli = path.join(projectRoot, "tools", "ai-flow", "bin", "ai-flow.mjs");

  const baselinePath = path.join(projectRoot, "ai-dev", "baseline.json");
  const baseline = await readJson(baselinePath);
  baseline.status = "active";
  await writeJson(baselinePath, baseline);
  await writeJson(path.join(projectRoot, "ai-dev", "decisions", "register.json"), {
    schemaVersion: 1,
    registerId: "QUICK-DECISIONS",
    baselineId: baseline.baselineId,
    status: "resolved",
    decisions: [],
    stageGates: [{
      stageId: "IMPLEMENTATION",
      title: "Authorized implementation",
      status: "authorized",
      blockingDecisionIds: [],
      evidenceRequired: [],
      authorizationBoundary: "Owner-authorized local implementation",
    }],
  });
  await writeJson(path.join(projectRoot, "ai-dev", "impact-map.json"), {
    schemaVersion: 1,
    mapId: "QUICK-IMPACT",
    baselineId: baseline.baselineId,
    rules: [{
      ruleId: "QUICK-APP",
      pathPatterns: ["src/**"],
      requirementIds: ["REQ-001"],
      acceptanceIds: ["AT-001"],
      verifierIds: ["VERIFY-QUICK"],
    }],
    globalRequirementIds: [],
    globalVerifierIds: [],
  });
  await writeJson(path.join(projectRoot, "ai-dev", "verifiers", "registry.json"), {
    schemaVersion: 1,
    registryId: "QUICK-VERIFIERS",
    verifiers: [{
      verifierId: "VERIFY-QUICK",
      tier: "quick",
      command: "node",
      args: ["--version"],
      workingDirectory: ".",
      timeoutMs: 5_000,
      evidenceLevel: "contract",
      deterministic: true,
      inputPatterns: ["src/**"],
      environmentKeys: [],
      triggers: {
        requirementIds: ["REQ-001"],
        acceptanceIds: ["AT-001"],
        pathPatterns: ["src/**"],
        riskDomains: [],
        alwaysRun: false,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    }],
    globalInvariantVerifierIds: [],
  });

  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "AI Flow Tests"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "baseline"]);

  const shortRequest = ".ai-flow/generated/requests/quick.json";
  await writeJson(path.join(projectRoot, ...shortRequest.split("/")), {
    goal: "Fix the bounded local behavior",
    changedPaths: ["src/app.mjs"],
    directRequirementIds: ["REQ-001"],
  });
  const started = await executeCli(vendoredCli, [
    "start", "--project", projectRoot,
    "--input", shortRequest,
    "--mode", "auto",
    "--json",
  ]);
  assert.equal(started.code, 0, started.stderr || started.stdout);
  assert.equal(started.value.status, "pass");
  assert.equal(started.value.requestedMode, "auto");
  assert.equal(started.value.selectedMode, "quick");
  assert.equal(started.value.quickEligible, true);
  assert.deepEqual(started.value.routingReasons, []);
  assert.equal(started.value.executionKind, "in_place");
  assert.match(started.value.taskId, /^TASK-[a-f0-9]{20}$/u);
  assert.equal(Object.hasOwn(started.value, "runId"), false);
  assert.equal(Object.hasOwn(started.value, "runRecord"), false);
  assert.equal(Object.hasOwn(started.value, "runDigest"), false);
  assert.equal(started.value.envelope.executionKind, "in_place");
  assert.equal(started.value.envelope.workspacePath, projectRoot.replaceAll("\\", "/"));
  assert.equal(started.value.envelope.completionClaim, "local_verification_only");
  assert.equal(started.value.nextAction.kind, "implement");
  assert.equal(started.value.nextAction.afterSuccess.kind, "verify");
  await readFile(path.join(projectRoot, "ai-dev", "tasks", `${started.value.taskId}.json`), "utf8");
  const agentBrief = await readFile(
    path.join(projectRoot, ...started.value.envelope.briefRefs.agent.split("/")),
    "utf8",
  );
  assert.match(agentBrief, /REQ-001/u);
  assert.deepEqual(await readdir(path.join(projectRoot, "ai-dev", "runs")), []);

  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "app.mjs"), "export const ready = true;\n", "utf8");
  const verified = await executeCli(vendoredCli, [
    "verify", "--project", projectRoot,
    "--task", started.value.taskPath,
    "--expected-task-digest", started.value.taskDigest,
    "--json",
  ]);
  assert.equal(verified.code, 0, verified.stderr || verified.stdout);
  assert.equal(verified.value.status, "pass");
  assert.equal(verified.value.executedTier, "quick");
  assert.deepEqual(verified.value.actualImpact.changedPaths, ["src/app.mjs"]);

  const full = await executeCli(vendoredCli, [
    "start", "--project", projectRoot,
    "--input", shortRequest,
    "--mode", "auto",
    "--worktree", fullWorktreePath,
    "--json",
  ]);
  assert.equal(full.code, 0, full.stderr || full.stdout);
  assert.equal(full.value.selectedMode, "full");
  assert.equal(full.value.executionKind, "isolated_run");
  assert.equal(full.value.quickEligible, true);
  assert.equal(full.value.routingReasons[0].code, "FULL_RUN_OPTION_REQUESTED");
  assert.equal(full.value.runRecord.state, "ready");
  await readFile(path.join(fullWorktreePath, "AGENTS.md"), "utf8");

  const abandonedAt = new Date(Date.parse(full.value.runRecord.startedAt) + 1_000).toISOString();
  const abandoned = await executeCli(vendoredCli, [
    "run", "abandon", "--project", projectRoot,
    "--run", full.value.runId,
    "--expected-run-digest", full.value.runDigest,
    "--at", abandonedAt,
    "--reason", "Test fixture completed",
    "--json",
  ]);
  assert.equal(abandoned.code, 0, abandoned.stderr || abandoned.stdout);
});

test("an initialized project actually runs vendored spec, task, context, cycle, check, and metrics commands", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-cli-e2e-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const specPath = path.join(fixtureRoot, "spec.md");
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(specPath, SPEC, "utf8");

  const initialized = await executeCli(rootCli, [
    "init", projectRoot, "--id", "neutral-example", "--spec", specPath, "--json",
  ]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const vendoredCli = path.join(projectRoot, "tools", "ai-flow", "bin", "ai-flow.mjs");

  const baselinePath = path.join(projectRoot, "ai-dev", "baseline.json");
  const baseline = await readJson(baselinePath);
  baseline.status = "active";
  await writeJson(baselinePath, baseline);
  await writeJson(path.join(projectRoot, "ai-dev", "decisions", "register.json"), {
    schemaVersion: 1,
    registerId: "NEUTRAL-DECISIONS",
    baselineId: baseline.baselineId,
    status: "resolved",
    decisions: [],
    stageGates: [{
      stageId: "IMPLEMENTATION",
      title: "Authorized implementation",
      status: "authorized",
      blockingDecisionIds: [],
      evidenceRequired: [],
      authorizationBoundary: "Owner-authorized implementation only",
    }],
  });
  await writeJson(path.join(projectRoot, "ai-dev", "impact-map.json"), {
    schemaVersion: 1,
    mapId: "NEUTRAL-IMPACT",
    baselineId: baseline.baselineId,
    rules: [{
      ruleId: "APP-RULE",
      pathPatterns: ["src/**"],
      requirementIds: ["REQ-001"],
      acceptanceIds: ["AT-001"],
      verifierIds: ["VERIFY-APP"],
    }],
    globalRequirementIds: [],
    globalVerifierIds: [],
  });
  await writeJson(path.join(projectRoot, "ai-dev", "verifiers", "registry.json"), {
    schemaVersion: 1,
    registryId: "NEUTRAL-VERIFIERS",
    verifiers: [{
      verifierId: "VERIFY-APP",
      tier: "quick",
      command: "node",
      args: ["--version"],
      workingDirectory: ".",
      timeoutMs: 5_000,
      evidenceLevel: "contract",
      deterministic: true,
      inputPatterns: ["src/**"],
      environmentKeys: [],
      triggers: {
        requirementIds: ["REQ-001"],
        acceptanceIds: ["AT-001"],
        pathPatterns: ["src/**"],
        riskDomains: [],
        alwaysRun: false,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    }],
    globalInvariantVerifierIds: [],
  });
  const customAdapterPath = path.join(projectRoot, "tools", "ai-flow", "custom-spec-adapter.mjs");
  await writeFile(
    customAdapterPath,
    `import { compileStructuredMarkdown } from "./src/spec/index.mjs";
export function compileNeutralSpecification(input) {
  const result = compileStructuredMarkdown(input);
  result.integrity.warnings.push({
    code: "custom_adapter_executed",
    message: "Configured adapter executed."
  });
  return result;
}
`,
    "utf8",
  );
  const projectConfigPath = path.join(projectRoot, "ai-flow.config.json");
  const projectConfig = await readJson(projectConfigPath);
  projectConfig.specAdapter = {
    module: "tools/ai-flow/custom-spec-adapter.mjs",
    exportName: "compileNeutralSpecification",
  };
  await writeJson(projectConfigPath, projectConfig);

  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "AI Flow Tests"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "baseline"]);
  const historicalBaseRevision = await git(projectRoot, ["rev-parse", "HEAD"]);
  await git(projectRoot, ["commit", "--allow-empty", "-m", "active-base"]);
  const baseRevision = await git(projectRoot, ["rev-parse", "HEAD"]);

  const spec = await executeCli(vendoredCli, ["spec", "compile", "--project", projectRoot, "--json"]);
  assert.equal(spec.code, 0, spec.stderr || spec.stdout);
  assert.equal(spec.value.status, "pass");
  assert.match(spec.value.outputPath, /spec-index\/[a-f0-9]{64}\.json$/u);
  assert.equal(spec.value.artifact.action, "written");
  assert.equal(spec.value.specIndex.integrity.warnings.some(
    (entry) => entry.code === "custom_adapter_executed",
  ), true);
  const specAgain = await executeCli(vendoredCli, ["spec", "compile", "--project", projectRoot, "--json"]);
  assert.equal(specAgain.code, 0, specAgain.stderr || specAgain.stdout);
  assert.equal(specAgain.value.artifact.action, "current");

  const requestDirectory = path.join(projectRoot, "requests");
  const taskRequestPath = path.join(requestDirectory, "task.json");
  await writeJson(taskRequestPath, {
    taskId: "TASK-001",
    goal: "Implement the authorized record behavior",
    baseRevision,
    stageId: "IMPLEMENTATION",
    taskKind: "implementation",
    changedPaths: ["src/app.mjs"],
    directRequirementIds: ["REQ-001"],
    requiredEvidenceLevel: "contract",
    requestedTier: "quick",
    routingCapability: "fast",
    risk: { level: "low", domains: ["logic"] },
  });
  const task = await executeCli(vendoredCli, [
    "task", "compile", "--project", projectRoot, "--input", "requests/task.json", "--json",
  ]);
  assert.equal(task.code, 0, task.stderr || task.stdout);
  assert.equal(task.value.status, "pass");
  assert.match(task.value.taskDigest, /^sha256:[a-f0-9]{64}$/u);
  const validated = await executeCli(vendoredCli, [
    "task", "validate", "--project", projectRoot, "--task", "TASK-001", "--json",
  ]);
  assert.equal(validated.code, 0, validated.stderr || validated.stdout);
  assert.equal(validated.value.status, "pass");

  await writeJson(path.join(requestDirectory, "context.json"), {
    task: "TASK-001",
    manifestId: "CONTEXT-001",
    subjectRevision: baseRevision,
    createdAt: "2026-08-27T12:00:00.000Z",
    contracts: [{
      path: "secrets/missing-token.txt",
      alwaysInclude: true,
      reason: "Only the sensitive reference may enter context.",
      required: false,
    }],
    exclusions: [],
  });
  const context = await executeCli(vendoredCli, [
    "context", "build", "--project", projectRoot, "--input", "requests/context.json", "--json",
  ]);
  assert.equal(context.code, 0, context.stderr || context.stdout);
  assert.equal(context.value.status, "pass");
  assert.match(context.value.outputPath, /contexts\/[a-f0-9]{64}\.json$/u);
  const sensitiveReference = context.value.contextManifest.items.find(
    (entry) => entry.path === "secrets/missing-token.txt",
  );
  assert.equal(sensitiveReference.kind, "sensitive_reference");
  assert.equal(sensitiveReference.reason.includes("content must not be loaded"), true);

  const worktreePath = path.join(fixtureRoot, "run-001-worktree");
  const prepared = await executeCli(vendoredCli, [
    "run", "prepare", "--project", projectRoot,
    "--task", "TASK-001", "--run", "RUN-001",
    "--worktree", worktreePath,
    "--at", "2026-08-27T12:01:00.000Z", "--json",
  ]);
  assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
  const runRecord = prepared.value.runRecord;
  await writeJson(path.join(requestDirectory, "cycle.json"), {
    run: "RUN-001",
    expectedRunDigest: digestJson(runRecord),
    at: "2026-08-27T12:01:30.000Z",
  });
  const cycle = await executeCli(vendoredCli, [
    "cycle", "evaluate", "--project", projectRoot, "--input", "requests/cycle.json", "--json",
  ]);
  assert.equal(cycle.code, 0, cycle.stderr || cycle.stdout);
  assert.equal(cycle.value.adjudication.decision, "verify");

  const metrics = await executeCli(vendoredCli, ["metrics", "report", "--project", projectRoot, "--json"]);
  assert.equal(metrics.code, 0, metrics.stderr || metrics.stdout);
  assert.equal(metrics.value.report.generatedFromRunCount, 1);
  const checked = await executeCli(vendoredCli, ["check", "--project", projectRoot, "--json"]);
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  assert.equal(checked.value.status, "pass");

  const historicalSpecIndex = structuredClone(spec.value.specIndex);
  historicalSpecIndex.integrity.warnings.push({
    code: "historical_fixture",
    message: "Historical content-addressed SpecIndex fixture.",
  });
  historicalSpecIndex.provenance.baseRevision = historicalBaseRevision;
  const historicalSpecIndexDigest = digestJson(historicalSpecIndex);
  const historicalSpecIndexPath = path.join(
    projectRoot,
    ".ai-flow",
    "generated",
    "spec-index",
    `${historicalSpecIndexDigest.slice("sha256:".length)}.json`,
  );
  await writeJson(historicalSpecIndexPath, historicalSpecIndex);
  const historicalTask = structuredClone(task.value.taskPacket);
  historicalTask.taskId = "TASK-HISTORICAL";
  historicalTask.baseRevision = historicalBaseRevision;
  historicalTask.specIndexDigest = historicalSpecIndexDigest;
  const historicalTaskDigest = digestJson(historicalTask);
  const historicalTaskPath = path.join(projectRoot, "ai-dev", "tasks", "TASK-HISTORICAL.json");
  await writeJson(historicalTaskPath, historicalTask);
  const historicalRun = structuredClone(runRecord);
  historicalRun.runId = "RUN-HISTORICAL";
  historicalRun.taskId = historicalTask.taskId;
  historicalRun.taskPacketRef = "ai-dev/tasks/TASK-HISTORICAL.json";
  historicalRun.expectedTaskDigest = historicalTaskDigest;
  historicalRun.taskPacketDigest = historicalTaskDigest;
  historicalRun.baseRevision = historicalBaseRevision;
  historicalRun.state = "escalated";
  historicalRun.updatedAt = "2026-08-27T12:01:45.000Z";
  historicalRun.stateTransitions.push({
    from: "ready",
    to: "escalated",
    at: historicalRun.updatedAt,
    reason: "Close the historical fixture.",
    actorRole: "controller",
  });
  historicalRun.checkpoints = historicalRun.checkpoints.map((entry) => ({
    ...entry,
    taskPacketDigest: historicalTaskDigest,
  }));
  historicalRun.result = {
    decision: "blocked",
    evidenceBundleRef: null,
    summary: "Historical fixture closed.",
  };
  const historicalRunPath = path.join(projectRoot, "ai-dev", "runs", "RUN-HISTORICAL.json");
  await writeJson(historicalRunPath, historicalRun);
  const checkedWithHistory = await executeCli(vendoredCli, ["check", "--project", projectRoot, "--json"]);
  assert.equal(checkedWithHistory.code, 0, checkedWithHistory.stderr || checkedWithHistory.stdout);

  historicalRun.controlDigest = `sha256:${"0".repeat(64)}`;
  await writeJson(historicalRunPath, historicalRun);
  const mismatchedHistory = await executeCli(vendoredCli, ["check", "--project", projectRoot, "--json"]);
  assert.equal(mismatchedHistory.code, 1, mismatchedHistory.stderr || mismatchedHistory.stdout);
  assert.equal(mismatchedHistory.value.code, "TASK_INVALID");
  assert.equal(mismatchedHistory.value.errors[0].code, "TASK_HISTORY_BINDING_INVALID");
  await rm(historicalRunPath);
  await rm(historicalTaskPath);
  await rm(historicalSpecIndexPath);

  const misplacedRequestPath = path.join(projectRoot, "ai-dev", "tasks", "request-misplaced.json");
  await writeJson(misplacedRequestPath, {
    taskId: "TASK-MISPLACED",
    goal: "Compile a task from this request.",
    changedPaths: ["src/records.mjs"],
    directRequirementIds: ["REQ-001"],
  });
  const misplacedRequest = await executeCli(vendoredCli, ["check", "--project", projectRoot, "--json"]);
  assert.equal(misplacedRequest.code, 1, misplacedRequest.stderr || misplacedRequest.stdout);
  assert.equal(misplacedRequest.value.code, "TASK_REQUEST_MISPLACED");
  assert.equal(misplacedRequest.value.path, "ai-dev/tasks/request-misplaced.json");
  assert.equal(misplacedRequest.value.expectedDirectory, ".ai-flow/generated/requests");
  await rm(misplacedRequestPath);

  const checkedAfterCleanup = await executeCli(vendoredCli, ["check", "--project", projectRoot, "--json"]);
  assert.equal(checkedAfterCleanup.code, 0, checkedAfterCleanup.stderr || checkedAfterCleanup.stdout);

  const missingReview = await executeCli(vendoredCli, [
    "review", "validate", "--project", projectRoot, "--review", "MISSING", "--json",
  ]);
  assert.equal(missingReview.code, 2);
  await writeJson(path.join(requestDirectory, "evidence-invalid.json"), {
    bundleId: "BUNDLE-INVALID",
    createdAt: "2026-08-27T12:02:00.000Z",
    run: "RUN-001",
    expectedRunDigest: digestJson(runRecord),
  });
  const invalidSeal = await executeCli(vendoredCli, [
    "evidence", "seal", "--project", projectRoot,
    "--input", "requests/evidence-invalid.json", "--json",
  ]);
  assert.equal(invalidSeal.code, 2);
  assert.equal(invalidSeal.value.code, "REQUEST_FIELD_MISSING");
  const missingEvidence = await executeCli(vendoredCli, [
    "evidence", "status", "--project", projectRoot,
    "--bundle", "ai-dev/evidence/bundles/missing.json", "--json",
  ]);
  assert.equal(missingEvidence.code, 2);
});

test("vendored CLI binds machine evidence and review to Owner then production receipts", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-cli-evidence-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const specPath = path.join(fixtureRoot, "spec.md");
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(specPath, SPEC, "utf8");

  const initialized = await executeCli(rootCli, [
    "init", projectRoot, "--id", "evidence-example", "--spec", specPath, "--json",
  ]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const vendoredCli = path.join(projectRoot, "tools", "ai-flow", "bin", "ai-flow.mjs");

  const baselinePath = path.join(projectRoot, "ai-dev", "baseline.json");
  const baseline = await readJson(baselinePath);
  baseline.status = "active";
  await writeJson(baselinePath, baseline);
  await writeJson(path.join(projectRoot, "ai-dev", "decisions", "register.json"), {
    schemaVersion: 1,
    registerId: "EVIDENCE-DECISIONS",
    baselineId: baseline.baselineId,
    status: "resolved",
    decisions: [],
    stageGates: [{
      stageId: "IMPLEMENTATION",
      title: "Authorized implementation",
      status: "authorized",
      blockingDecisionIds: [],
      evidenceRequired: ["target_integration", "owner_acceptance", "production_release"],
      authorizationBoundary: "Bounded local implementation only",
    }],
  });
  await writeJson(path.join(projectRoot, "ai-dev", "impact-map.json"), {
    schemaVersion: 1,
    mapId: "EVIDENCE-IMPACT",
    baselineId: baseline.baselineId,
    rules: [{
      ruleId: "APP-RULE",
      pathPatterns: ["src/**"],
      requirementIds: ["REQ-001"],
      acceptanceIds: ["AT-001"],
      verifierIds: ["VERIFY-CONTRACT", "VERIFY-RUNTIME-STUB", "VERIFY-TARGET"],
    }],
    globalRequirementIds: [],
    globalVerifierIds: [],
  });
  const registryPath = path.join(projectRoot, "ai-dev", "verifiers", "registry.json");
  const registry = {
    schemaVersion: 1,
    registryId: "EVIDENCE-VERIFIERS",
    verifiers: [{
      verifierId: "VERIFY-CONTRACT",
      tier: "quick",
      command: "node",
      args: ["--version"],
      workingDirectory: ".",
      timeoutMs: 5_000,
      evidenceLevel: "contract",
      deterministic: true,
      inputPatterns: ["src/**"],
      environmentKeys: [],
      triggers: {
        requirementIds: ["REQ-001"],
        acceptanceIds: ["AT-001"],
        pathPatterns: ["src/**"],
        riskDomains: [],
        alwaysRun: false,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    }, {
      verifierId: "VERIFY-RUNTIME-STUB",
      tier: "quick",
      command: "node",
      args: ["--version"],
      workingDirectory: ".",
      timeoutMs: 5_000,
      evidenceLevel: "runtime_stub",
      deterministic: true,
      inputPatterns: ["src/**"],
      environmentKeys: [],
      triggers: {
        requirementIds: ["REQ-001"],
        acceptanceIds: ["AT-001"],
        pathPatterns: ["src/**"],
        riskDomains: [],
        alwaysRun: false,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    }, {
      verifierId: "VERIFY-TARGET",
      tier: "quick",
      command: "node",
      args: ["--version"],
      workingDirectory: ".",
      timeoutMs: 5_000,
      evidenceLevel: "target_integration",
      deterministic: true,
      inputPatterns: ["src/**"],
      environmentKeys: [],
      triggers: {
        requirementIds: ["REQ-001"],
        acceptanceIds: ["AT-001"],
        pathPatterns: ["src/**"],
        riskDomains: [],
        alwaysRun: false,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    }],
    globalInvariantVerifierIds: [],
  };
  await writeJson(registryPath, registry);
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  const implementedSource = "export const value = 2;\n";
  await writeFile(path.join(projectRoot, "src", "app.mjs"), "export const value = 1;\n", "utf8");

  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "AI Flow Tests"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "baseline"]);
  const baseRevision = await git(projectRoot, ["rev-parse", "HEAD"]);

  const compiledSpec = await executeCli(vendoredCli, [
    "spec", "compile", "--project", projectRoot, "--json",
  ]);
  assert.equal(compiledSpec.code, 0, compiledSpec.stderr || compiledSpec.stdout);
  const requestDirectory = path.join(projectRoot, ".ai-flow", "generated", "requests");
  await writeJson(path.join(requestDirectory, "task.json"), {
    taskId: "TASK-EVIDENCE",
    goal: "Implement and verify the bounded runtime behavior",
    baseRevision,
    stageId: "IMPLEMENTATION",
    taskKind: "implementation",
    changedPaths: ["src/app.mjs"],
    directRequirementIds: ["REQ-001"],
    requiredEvidenceLevel: "production",
    requestedTier: "quick",
    routingCapability: "fast",
    risk: { level: "low", domains: ["logic"] },
  });
  const task = await executeCli(vendoredCli, [
    "task", "compile", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/task.json", "--json",
  ]);
  assert.equal(task.code, 0, task.stderr || task.stdout);
  assert.equal(task.value.compilationStatus, "ready");

  const taskPacket = await readJson(path.join(projectRoot, "ai-dev", "tasks", "TASK-EVIDENCE.json"));
  const worktreePath = path.join(fixtureRoot, "run-evidence-worktree");
  const prepared = await executeCli(vendoredCli, [
    "run", "prepare", "--project", projectRoot,
    "--task", "TASK-EVIDENCE", "--run", "RUN-EVIDENCE",
    "--worktree", worktreePath,
    "--at", "2026-08-27T13:00:00.000Z", "--json",
  ]);
  assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
  let runRecord = prepared.value.runRecord;
  runRecord = await advanceCliRun({
    cliPath: vendoredCli,
    projectRoot,
    inputRef: ".ai-flow/generated/requests/run-implementing.json",
    runId: "RUN-EVIDENCE",
    runRecord,
    request: {
      phase: "implementing",
      at: "2026-08-27T13:01:00.000Z",
      reason: "Bounded implementation started.",
      contextId: "implementer-evidence",
    },
  });
  await writeFile(path.join(worktreePath, "src", "app.mjs"), implementedSource, "utf8");
  await writeFile(path.join(projectRoot, "src", "app.mjs"), implementedSource, "utf8");

  await writeJson(path.join(requestDirectory, "context.json"), {
    task: "TASK-EVIDENCE",
    manifestId: "CONTEXT-EVIDENCE",
    subjectRevision: baseRevision,
    createdAt: "2026-08-27T13:02:30.000Z",
    contracts: [],
    exclusions: [],
  });
  const context = await executeCli(vendoredCli, [
    "context", "build", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/context.json", "--json",
  ]);
  assert.equal(context.code, 0, context.stderr || context.stdout);
  runRecord = await advanceCliRun({
    cliPath: vendoredCli,
    projectRoot,
    inputRef: ".ai-flow/generated/requests/run-verifying.json",
    runId: "RUN-EVIDENCE",
    runRecord,
    request: {
      phase: "verifying",
      at: "2026-08-27T13:03:00.000Z",
      reason: "Implementation completed.",
    },
  });

  const verification = await executeCli(vendoredCli, [
    "verify", "--project", projectRoot, "--tier", "quick",
    "--run", "RUN-EVIDENCE",
    "--json",
  ]);
  assert.equal(verification.code, 0, verification.stderr || verification.stdout);
  assert.equal(verification.value.status, "pass");
  assert.equal(verification.value.complete, true);
  assert.equal(verification.value.results.length, 3);
  assert.equal(verification.value.results.every(
    (entry) => entry.status === "pass" && entry.complete === true,
  ), true);
  const verificationEntries = verification.value.results.map((result, index) => ({
    reference: verification.value.verificationResultArtifacts[index].reference,
    result,
  }));
  for (const entry of verificationEntries) {
    assert.deepEqual(
      await readJson(path.join(projectRoot, ...entry.reference.split("/"))),
      entry.result,
    );
  }
  const verificationDigests = verification.value.results.map((result) => ({
    resultId: result.resultId,
    resultDigest: result.resultDigest,
  }));
  const resultReferences = verificationEntries.map((entry) => entry.reference);
  const verificationResult = verification.value.results.find(
    (entry) => entry.evidenceLevel === "target_integration",
  );
  assert.ok(verificationResult);
  runRecord = await advanceCliRun({
    cliPath: vendoredCli,
    projectRoot,
    inputRef: ".ai-flow/generated/requests/run-reviewing.json",
    runId: "RUN-EVIDENCE",
    runRecord,
    request: {
      phase: "reviewing",
      at: "2026-08-27T13:04:00.000Z",
      reason: "Complete deterministic verification is available.",
      contextId: "reviewer-evidence",
      verificationResultRefs: resultReferences,
      verificationResultDigests: verificationDigests,
    },
  });

  const latestVerificationTime = Math.max(
    ...verification.value.results.map((entry) => Date.parse(entry.completedAt)),
  );
  const reviewCreatedAt = new Date(latestVerificationTime + 1_000).toISOString();
  const ownerIssuedAt = new Date(latestVerificationTime + 2_000).toISOString();
  const productionIssuedAt = new Date(latestVerificationTime + 3_000).toISOString();
  const bundleCreatedAt = new Date(latestVerificationTime + 4_000).toISOString();
  const reviewReference = "ai-dev/reviews/REVIEW-EVIDENCE.json";
  const reviewReport = {
    schemaVersion: 2,
    reportId: "REVIEW-EVIDENCE",
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    taskPacketDigest: task.value.taskDigest,
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest: verificationResult.subjectContentDigest,
    subjectRevision: verificationResult.subjectRevision,
    reviewRound: 0,
    implementerContextId: "implementer-evidence",
    reviewContextId: "reviewer-evidence",
    contextDigest: computeReviewContextDigest({
      reviewContextId: "reviewer-evidence",
      subjectRevision: verificationResult.subjectRevision,
      subjectContentDigest: verificationResult.subjectContentDigest,
      taskPacketDigest: task.value.taskDigest,
      controlDigest: taskPacket.controlDigest,
      verificationResults: verificationEntries,
    }),
    verdict: "pass",
    verificationResultRefs: resultReferences,
    verificationResultDigests: verificationDigests,
    createdAt: reviewCreatedAt,
    evidence: [
      { level: "specification", status: "pass", reference: taskPacket.specDigest },
      ...verificationEntries.map((entry) => ({
        level: entry.result.evidenceLevel,
        status: "pass",
        reference: entry.reference,
      })),
    ],
    findings: [],
    blockingDecisionIds: [],
    profileId: taskPacket.review.profileId,
    lensCoverage: taskPacket.review.mandatoryLensIds.map((lensId) => ({ lensId, status: "covered" })),
    summary: "Independent context confirmed the exact target-integration result set.",
  };
  await writeJson(path.join(projectRoot, ...reviewReference.split("/")), reviewReport);
  const review = await executeCli(vendoredCli, [
    "review", "validate", "--project", projectRoot,
    "--review", "REVIEW-EVIDENCE", "--json",
  ]);
  assert.equal(review.code, 0, review.stderr || review.stdout);
  assert.equal(review.value.status, "pass");

  const cycleRequestPath = path.join(requestDirectory, "cycle.json");
  const cycleRequest = {
    run: "RUN-EVIDENCE",
    expectedRunDigest: digestJson(runRecord),
    at: bundleCreatedAt,
    reviewReports: [reviewReference],
    authorityReceiptRefs: [],
  };
  await writeJson(cycleRequestPath, cycleRequest);
  const noAuthority = await executeCli(vendoredCli, [
    "cycle", "evaluate", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/cycle.json", "--json",
  ]);
  assert.equal(noAuthority.code, 2, noAuthority.stderr || noAuthority.stdout);
  assert.notEqual(noAuthority.value.adjudication.decision, "accept");

  const binding = buildAuthorityReceiptBinding({
    taskId: taskPacket.taskId,
    taskPacketDigest: task.value.taskDigest,
    expectedTaskDigest: task.value.taskDigest,
    specDigest: taskPacket.specDigest,
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest: verificationResult.subjectContentDigest,
    baselineDigest: digestJson(baseline),
    subjectRevision: verificationResult.subjectRevision,
    worktreeDigest: verificationResult.worktreeDigest,
  }, {
    verificationResults: verification.value.results,
    reviewReports: [reviewReport],
    participantContextIds: ["implementer-evidence", "reviewer-evidence"],
  });
  const receiptBindings = {
    schemaVersion: 2,
    taskId: binding.taskId,
    taskPacketDigest: binding.taskPacketDigest,
    expectedTaskDigest: binding.expectedTaskDigest,
    specDigest: binding.specDigest,
    controlDigest: binding.controlDigest,
    subjectContentDigest: binding.subjectContentDigest,
    baselineDigest: binding.baselineDigest,
    subjectRevision: binding.subjectRevision,
    worktreeDigest: binding.worktreeDigest,
    verificationResultDigests: binding.verificationResultDigests,
    reviewReportDigests: binding.reviewReportDigests,
  };
  const ownerReceipt = {
    receiptId: "AUTH-OWNER-E2E",
    kind: "owner_acceptance",
    actorType: "human",
    actorRef: "authenticated-owner-e2e",
    ...receiptBindings,
    issuedAt: ownerIssuedAt,
    reference: "owner-system://acceptance/TASK-EVIDENCE",
  };
  ownerReceipt.receiptDigest = computeAuthorityReceiptDigest(ownerReceipt);
  const ownerReceiptReference = "ai-dev/evidence/authority/owner-e2e.json";
  await writeJson(path.join(projectRoot, ...ownerReceiptReference.split("/")), ownerReceipt);

  cycleRequest.authorityReceiptRefs = [ownerReceiptReference];
  await writeJson(cycleRequestPath, cycleRequest);
  const ownerOnly = await executeCli(vendoredCli, [
    "cycle", "evaluate", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/cycle.json", "--json",
  ]);
  assert.equal(ownerOnly.code, 2, ownerOnly.stderr || ownerOnly.stdout);
  assert.notEqual(ownerOnly.value.adjudication.decision, "accept");

  const productionReceipt = {
    receiptId: "AUTH-PRODUCTION-E2E",
    kind: "production_release",
    actorType: "external_system",
    actorRef: "authenticated-release-system-e2e",
    ...receiptBindings,
    issuedAt: productionIssuedAt,
    reference: "release-system://production/TASK-EVIDENCE",
    priorOwnerReceiptDigest: ownerReceipt.receiptDigest,
  };
  productionReceipt.receiptDigest = computeAuthorityReceiptDigest(productionReceipt);
  const productionReceiptReference = "ai-dev/evidence/authority/production-e2e.json";
  await writeJson(
    path.join(projectRoot, ...productionReceiptReference.split("/")),
    productionReceipt,
  );
  cycleRequest.authorityReceiptRefs = [ownerReceiptReference, productionReceiptReference];
  await writeJson(cycleRequestPath, cycleRequest);
  const cycle = await executeCli(vendoredCli, [
    "cycle", "evaluate", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/cycle.json", "--json",
  ]);
  assert.equal(cycle.code, 0, cycle.stderr || cycle.stdout);
  assert.equal(cycle.value.adjudication.decision, "accept");
  assert.equal(cycle.value.adjudication.evidenceLevel, "production");

  await writeJson(path.join(requestDirectory, "evidence.json"), {
    bundleId: "BUNDLE-EVIDENCE",
    createdAt: bundleCreatedAt,
    run: "RUN-EVIDENCE",
    expectedRunDigest: digestJson(runRecord),
    reviewReports: [reviewReference],
    authorityReceiptRefs: [ownerReceiptReference, productionReceiptReference],
    limitations: ["Only the bounded task and its explicit authority chain were evaluated."],
    exclusions: [],
  });
  const sealed = await executeCli(vendoredCli, [
    "evidence", "seal", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/evidence.json", "--json",
  ]);
  assert.equal(sealed.code, 0, sealed.stderr || sealed.stdout);
  assert.equal(sealed.value.evidenceBundle.declaredMaximumLevel, "production");
  assert.deepEqual(sealed.value.evidenceBundle.authorityReceiptRefs, [
    ownerReceiptReference,
    productionReceiptReference,
  ]);
  assert.deepEqual(
    sealed.value.evidenceBundle.authorityReceipts.map((entry) => entry.receiptDigest),
    [ownerReceipt.receiptDigest, productionReceipt.receiptDigest],
  );

  const evidenceStatus = async () => executeCli(vendoredCli, [
    "evidence", "status", "--project", projectRoot,
    "--bundle", sealed.value.outputPath, "--json",
  ]);
  let status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);
  assert.equal(status.value.fresh, true);
  assert.equal(status.value.highestClaimableLevel, "production");

  const checkWithAuthority = await executeCli(vendoredCli, [
    "check", "--project", projectRoot, "--json",
  ]);
  assert.equal(checkWithAuthority.code, 0, checkWithAuthority.stderr || checkWithAuthority.stdout);
  assert.equal(checkWithAuthority.value.checked.evidence, 1);
  assert.equal(checkWithAuthority.value.checked.authorityReceipts, 2);

  const crossTaskOwner = {
    ...ownerReceipt,
    receiptId: "AUTH-CROSS-TASK-OWNER",
    taskId: "TASK-OTHER",
    actorRef: "authenticated-cross-task-owner",
    reference: "owner-system://acceptance/TASK-OTHER",
  };
  crossTaskOwner.receiptDigest = computeAuthorityReceiptDigest(crossTaskOwner);
  const crossTaskProduction = {
    ...productionReceipt,
    receiptId: "AUTH-CROSS-TASK-PRODUCTION",
    taskId: "TASK-OTHER",
    actorRef: "authenticated-cross-task-release",
    reference: "release-system://production/TASK-OTHER",
    priorOwnerReceiptDigest: crossTaskOwner.receiptDigest,
  };
  crossTaskProduction.receiptDigest = computeAuthorityReceiptDigest(crossTaskProduction);
  const crossOwnerReference = "ai-dev/evidence/authority/cross-owner.json";
  const crossProductionReference = "ai-dev/evidence/authority/cross-production.json";
  await writeJson(path.join(projectRoot, ...crossOwnerReference.split("/")), crossTaskOwner);
  await writeJson(
    path.join(projectRoot, ...crossProductionReference.split("/")),
    crossTaskProduction,
  );
  cycleRequest.authorityReceiptRefs = [crossOwnerReference, crossProductionReference];
  await writeJson(cycleRequestPath, cycleRequest);
  const crossTaskCycle = await executeCli(vendoredCli, [
    "cycle", "evaluate", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/cycle.json", "--json",
  ]);
  assert.equal(crossTaskCycle.code, 2, crossTaskCycle.stderr || crossTaskCycle.stdout);
  assert.notEqual(crossTaskCycle.value.adjudication.decision, "accept");

  await writeJson(path.join(requestDirectory, "evidence-cross-task.json"), {
    bundleId: "BUNDLE-CROSS-TASK",
    createdAt: new Date(latestVerificationTime + 5_000).toISOString(),
    run: "RUN-EVIDENCE",
    expectedRunDigest: digestJson(runRecord),
    reviewReports: [reviewReference],
    authorityReceiptRefs: [crossOwnerReference, crossProductionReference],
    limitations: [],
    exclusions: [],
  });
  const crossTaskSeal = await executeCli(vendoredCli, [
    "evidence", "seal", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/evidence-cross-task.json", "--json",
  ]);
  assert.notEqual(crossTaskSeal.code, 0, crossTaskSeal.stderr || crossTaskSeal.stdout);

  const unknownEvidencePath = path.join(projectRoot, "ai-dev", "evidence", "unknown.json");
  await writeJson(unknownEvidencePath, { schemaVersion: 1 });
  const unknownEvidence = await executeCli(vendoredCli, [
    "check", "--project", projectRoot, "--json",
  ]);
  assert.notEqual(unknownEvidence.code, 0);
  assert.equal(unknownEvidence.value.code, "EVIDENCE_LAYOUT_UNKNOWN");
  await rm(unknownEvidencePath);

  const blockedBundleReference = "ai-dev/evidence/bundles/blocked-acceptance-gate.json";
  const blockedBundle = structuredClone(sealed.value.evidenceBundle);
  blockedBundle.decision = "blocked";
  blockedBundle.bundleDigest = computeEvidenceBundleDigest(blockedBundle);
  await writeJson(path.join(projectRoot, ...blockedBundleReference.split("/")), blockedBundle);
  const runDigestBeforeRejectedAcceptance = digestJson(runRecord);
  await writeJson(path.join(requestDirectory, "run-sealed-blocked.json"), {
    phase: "sealed",
    at: new Date(latestVerificationTime + 6_000).toISOString(),
    reason: "A blocked bundle must not pass the controller acceptance gate.",
    evidenceLevel: sealed.value.evidenceBundle.declaredMaximumLevel,
    evidenceBundleRef: blockedBundleReference,
    reviewReportRef: reviewReference,
    exclusions: sealed.value.evidenceBundle.exclusions,
  });
  const blockedAcceptance = await executeCli(vendoredCli, [
    "run", "advance", "--project", projectRoot,
    "--run", "RUN-EVIDENCE",
    "--expected-run-digest", runDigestBeforeRejectedAcceptance,
    "--input", ".ai-flow/generated/requests/run-sealed-blocked.json", "--json",
  ]);
  assert.equal(blockedAcceptance.code, 2, blockedAcceptance.stderr || blockedAcceptance.stdout);
  assert.equal(blockedAcceptance.value.code, "RUN_EVIDENCE_DECISION_INVALID");
  const afterRejectedAcceptance = await executeCli(vendoredCli, [
    "run", "inspect", "--project", projectRoot, "--run", "RUN-EVIDENCE", "--json",
  ]);
  assert.equal(afterRejectedAcceptance.code, 0, afterRejectedAcceptance.stderr || afterRejectedAcceptance.stdout);
  assert.equal(afterRejectedAcceptance.value.runDigest, runDigestBeforeRejectedAcceptance);
  assert.equal(afterRejectedAcceptance.value.runRecord.state, "reviewing");
  assert.equal(afterRejectedAcceptance.value.nextAction.kind, "finalize");
  assert.equal(afterRejectedAcceptance.value.nextAction.command.name, "run finalize");
  assert.equal(Object.hasOwn(afterRejectedAcceptance.value.nextAction.command, "executable"), false);
  assert.equal(
    afterRejectedAcceptance.value.nextAction.command.arguments.includes(runDigestBeforeRejectedAcceptance),
    true,
  );
  assert.deepEqual(afterRejectedAcceptance.value.nextAction.inputTemplate.authorityReceiptRefs, [
    "<owner_acceptance-receipt-ref>",
    "<production_release-receipt-ref>",
  ]);

  await writeJson(path.join(requestDirectory, "finalize.json"), {
    bundleId: "BUNDLE-EVIDENCE",
    createdAt: bundleCreatedAt,
    reason: "The exact fresh EvidenceBundle satisfies the acceptance gate.",
    reviewReports: [reviewReference],
    authorityReceiptRefs: [ownerReceiptReference, productionReceiptReference],
    limitations: ["Only the bounded task and its explicit authority chain were evaluated."],
    exclusions: [],
  });
  const finalized = await executeCli(vendoredCli, [
    "run", "finalize", "--project", projectRoot,
    "--run", "RUN-EVIDENCE",
    "--expected-run-digest", digestJson(runRecord),
    "--input", ".ai-flow/generated/requests/finalize.json", "--json",
  ]);
  assert.equal(finalized.code, 0, finalized.stderr || finalized.stdout);
  assert.equal(finalized.value.outputPath, sealed.value.outputPath);
  runRecord = finalized.value.runRecord;
  assert.equal(runRecord.state, "accepted");
  assert.equal(runRecord.result.evidenceBundleRef, sealed.value.outputPath);
  assert.equal(runRecord.result.acceptedEvidenceLevel, "production");
  const acceptedInspection = await executeCli(vendoredCli, [
    "run", "inspect", "--project", projectRoot, "--run", "RUN-EVIDENCE", "--json",
  ]);
  assert.equal(acceptedInspection.code, 0, acceptedInspection.stderr || acceptedInspection.stdout);
  assert.equal(acceptedInspection.value.nextAction.kind, "none");
  assert.equal(acceptedInspection.value.nextAction.terminalState, "accepted");

  const authorityDirectory = path.join(projectRoot, "ai-dev", "evidence", "authority");
  const unrelatedReceipt = {
    ...ownerReceipt,
    receiptId: "AUTH-UNREFERENCED-E2E",
    taskId: "TASK-OTHER",
    actorRef: "authenticated-other-owner",
    reference: "owner-system://acceptance/TASK-OTHER",
  };
  unrelatedReceipt.receiptDigest = computeAuthorityReceiptDigest(unrelatedReceipt);
  await writeJson(path.join(authorityDirectory, "unreferenced.json"), unrelatedReceipt);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);
  assert.equal(status.value.fresh, true);

  const extraEvidencePath = path.join(
    projectRoot,
    "ai-dev",
    "evidence",
    "bundles",
    "unreferenced-valid-copy.json",
  );
  await writeJson(extraEvidencePath, sealed.value.evidenceBundle);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);
  assert.equal(status.value.fresh, true);

  await writeFile(path.join(projectRoot, "src", "app.mjs"), "export const value = 3;\n", "utf8");
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);
  assert.equal(status.value.fresh, true);
  await writeFile(path.join(projectRoot, "src", "app.mjs"), implementedSource, "utf8");

  await writeFile(path.join(worktreePath, "src", "app.mjs"), "export const value = 3;\n", "utf8");
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.code, "RUN_BINDING_STALE");
  assert.equal(status.value.errors.some(
    (entry) => entry.code === "RUN_CHECKPOINT_STALE" || entry.code === "RUN_CONTENT_STALE",
  ), true);
  await writeFile(path.join(worktreePath, "src", "app.mjs"), implementedSource, "utf8");
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const changedRegistry = structuredClone(registry);
  changedRegistry.verifiers[0].timeoutMs = 6_000;
  await writeJson(registryPath, changedRegistry);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);
  assert.equal(status.value.fresh, true);
  await writeJson(registryPath, registry);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const changedBaseline = structuredClone(baseline);
  changedBaseline.status = "retired";
  await writeJson(baselinePath, changedBaseline);
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.reasons.some((entry) => entry.code === "EVIDENCE_BASELINE_CONTENT_STALE"), true);
  await writeJson(baselinePath, baseline);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const changedSpec = `${SPEC}\n<!-- changed after evidence seal -->\n`;
  await writeFile(path.join(projectRoot, "docs", "product-spec.md"), changedSpec, "utf8");
  const specChangedBaseline = structuredClone(baseline);
  const canonicalSource = specChangedBaseline.truthSources.find(
    (entry) => entry.sourceId === specChangedBaseline.canonicalSpecSourceId,
  );
  canonicalSource.digest = canonicalTextDigest(changedSpec);
  await writeJson(baselinePath, specChangedBaseline);
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.reasons.some(
    (entry) => entry.code === "EVIDENCE_BASELINE_CONTENT_STALE",
  ), true);
  await writeFile(path.join(projectRoot, "docs", "product-spec.md"), SPEC, "utf8");
  await writeJson(baselinePath, baseline);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const taskPath = path.join(projectRoot, "ai-dev", "tasks", "TASK-EVIDENCE.json");
  const changedTask = { ...taskPacket, goal: "Mutated task must invalidate evidence." };
  await writeJson(taskPath, changedTask);
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.code, "RUN_BINDING_STALE");
  assert.equal(status.value.errors.some(
    (entry) => entry.code === "RUN_TASK_PACKET_STALE",
  ), true);
  await writeJson(taskPath, taskPacket);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const resultPath = path.join(projectRoot, ...resultReferences[0].split("/"));
  const originalResult = await readJson(resultPath);
  const changedResult = {
    ...originalResult,
    summary: "A valid but different verification result.",
  };
  changedResult.resultDigest = computeVerificationResultDigest(changedResult);
  await writeJson(resultPath, changedResult);
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.fresh, false);
  await writeJson(resultPath, originalResult);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const reviewPath = path.join(projectRoot, ...reviewReference.split("/"));
  const changedReview = { ...reviewReport, summary: "A changed review must invalidate evidence." };
  await writeJson(reviewPath, changedReview);
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.reasons.some((entry) => entry.code === "EVIDENCE_REVIEW_STALE"), true);
  await writeJson(reviewPath, reviewReport);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  const ownerReceiptPath = path.join(projectRoot, ...ownerReceiptReference.split("/"));
  const changedOwnerReceipt = { ...ownerReceipt, actorRef: "authenticated-replacement-owner" };
  changedOwnerReceipt.receiptDigest = computeAuthorityReceiptDigest(changedOwnerReceipt);
  await writeJson(ownerReceiptPath, changedOwnerReceipt);
  status = await evidenceStatus();
  assert.equal(status.code, 2);
  assert.equal(status.value.reasons.some(
    (entry) => entry.code === "EVIDENCE_AUTHORITY_RECEIPTS_STALE",
  ), true);
  await writeJson(ownerReceiptPath, ownerReceipt);
  status = await evidenceStatus();
  assert.equal(status.code, 0, status.stderr || status.stdout);

  await git(worktreePath, ["add", "src/app.mjs"]);
  await git(worktreePath, ["commit", "-m", "commit unchanged candidate content"]);
  status = await evidenceStatus();
  assert.equal(status.code, 0);
  assert.equal(status.value.fresh, true);
  assert.equal(status.value.reasons.some((entry) => entry.code === "EVIDENCE_REVISION_STALE"), false);
});

test("help exposes every supported command and malformed subcommands fail with usage status", async () => {
  const help = await executeCli(rootCli, ["help"]);
  assert.equal(help.code, 0);
  for (const phrase of [
    "check --project",
    "spec compile",
    "task compile",
    "task validate",
    "context build",
    "run finalize",
    "review validate",
    "cycle evaluate",
    "evidence seal",
    "evidence status",
    "metrics report",
  ]) {
    assert.match(help.stdout, new RegExp(phrase.replace(" ", "\\s+"), "u"));
  }
  const malformed = await executeCli(rootCli, ["evidence", "publish", "--json"]);
  assert.equal(malformed.code, 64);
  assert.equal(malformed.value.code, "USAGE_ERROR");

  const ambiguousVerification = await executeCli(rootCli, [
    "verify", "--project", frameworkRoot, "--tier", "quick",
    "--run", "RUN-EXAMPLE", "--task", "TASK-EXAMPLE", "--json",
  ]);
  assert.equal(ambiguousVerification.code, 64);
  assert.equal(ambiguousVerification.value.code, "USAGE_ERROR");
});
