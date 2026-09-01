import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  attachExecutionAuthorizationDigest,
  authorizationRequired,
  prepareRun,
  inspectRun,
  resumeRun,
  advanceRun,
  abandonRun,
  validateBaseControlBinding,
  resolveCodexInstructionChain,
  resolveTaskInstructionBinding,
  validateExecutionAuthorization,
} from "../src/controller/index.mjs";
import { resumeRunCommand } from "../src/cli/controller-commands.mjs";
import {
  buildAssetPolicy,
  digestJson,
  evaluateTaskAssetWrites,
  validateSchema,
} from "../src/core/index.mjs";
import { digestFileContent } from "../src/cli/digest.mjs";
import { buildContextManifest, renderContextBrief } from "../src/task/index.mjs";
import { computeSubjectContentSnapshot } from "../src/verify/git-scope.mjs";
import { validateReviewCoverage } from "../src/workflow/index.mjs";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(frameworkRoot, "bin", "ai-flow.mjs");
const DIGEST = (character) => `sha256:${character.repeat(64)}`;

const SPEC = `# Controller Test Specification

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

function execute(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    }, (error, stdout, stderr) => resolve({
      code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
      stdout,
      stderr,
    }));
  });
}

async function git(cwd, args) {
  const result = await execute("git", args, cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function cli(args, cwd = frameworkRoot) {
  const result = await execute(process.execPath, [cliPath, ...args], cwd);
  let value = null;
  try { value = JSON.parse(result.stdout); } catch { /* assertion includes raw output */ }
  return { ...result, value };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function authorizationTask(taskKind = "control_plane") {
  return {
    taskId: "TASK-AUTH",
    taskKind,
    baseRevision: "a".repeat(40),
    controlDigest: DIGEST("b"),
  };
}

test("execution authorization is bound, expiring, path-limited, and one-time", async () => {
  const taskPacket = authorizationTask();
  const authorization = attachExecutionAuthorizationDigest({
    schemaVersion: 1,
    authorizationId: "AUTH-001",
    runId: "RUN-001",
    taskId: taskPacket.taskId,
    taskPacketDigest: digestJson(taskPacket),
    baseRevision: taskPacket.baseRevision,
    controlDigest: taskPacket.controlDigest,
    allowedPaths: ["schemas/**"],
    allowedExternalEffects: ["network_write"],
    issuedAt: "2026-08-30T00:00:00Z",
    expiresAt: "2026-08-30T01:00:00Z",
    nonce: "nonce-auth-00000001",
    issuedBy: "Owner",
  });
  const schema = JSON.parse(await readFile(new URL("../schemas/execution-authorization.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSchema(authorization, schema), []);
  const valid = validateExecutionAuthorization({
    authorization,
    runId: "RUN-001",
    taskPacket,
    requestedPaths: ["schemas/task-packet.schema.json"],
    requestedExternalEffects: ["network_write"],
    now: "2026-08-30T00:30:00Z",
  });
  assert.equal(valid.ok, true);
  assert.equal(authorizationRequired(taskPacket), true);
  assert.equal(authorizationRequired(authorizationTask("implementation")), false);
  assert.equal(authorizationRequired(authorizationTask("implementation"), ["network_write"]), true);

  const tampered = { ...authorization, allowedPaths: ["src/**"] };
  assert.equal(validateExecutionAuthorization({
    authorization: tampered,
    runId: "RUN-001",
    taskPacket,
    now: "2026-08-30T00:30:00Z",
  }).errors.some((entry) => entry.code === "AUTHORIZATION_TAMPERED"), true);
  assert.equal(validateExecutionAuthorization({
    authorization,
    runId: "RUN-001",
    taskPacket,
    now: "2026-08-30T01:00:00Z",
  }).errors.some((entry) => entry.code === "AUTHORIZATION_EXPIRED"), true);
  assert.equal(validateExecutionAuthorization({
    authorization,
    runId: "RUN-001",
    taskPacket,
    now: "2026-08-30T00:30:00Z",
    consumedNonces: [authorization.nonce],
  }).errors.some((entry) => entry.code === "AUTHORIZATION_NONCE_REPLAY"), true);
  const overreach = validateExecutionAuthorization({
    authorization,
    runId: "RUN-001",
    taskPacket,
    requestedPaths: ["src/app.mjs"],
    requestedExternalEffects: ["production"],
    now: "2026-08-30T00:30:00Z",
  });
  assert.deepEqual(new Set(overreach.errors.map((entry) => entry.code)), new Set([
    "AUTHORIZATION_PATH_FORBIDDEN",
    "AUTHORIZATION_EFFECT_FORBIDDEN",
  ]));
});

test("the task-kind asset matrix blocks truth, control, sensitive, unmanaged, and evidence writes deterministically", () => {
  const config = {
    baselinePath: "ai-dev/baseline.json",
    specAdapter: { module: "tools/ai-flow/spec-adapter.mjs" },
    paths: {
      tasks: "ai-dev/tasks",
      reviews: "ai-dev/reviews",
      runs: "ai-dev/runs",
      evidence: "ai-dev/evidence",
      authorizations: "ai-dev/authorizations",
      generated: ".ai-flow/generated",
      cache: ".ai-flow/cache",
      controller: ".ai-flow/controller",
    },
    automationPolicy: {
      controlPaths: ["AGENTS.md", "schemas/**", "tools/ai-flow/**"],
      sensitivePaths: [".env", "secrets/**"],
    },
  };
  const baseline = {
    decisionRegister: "ai-dev/decisions/register.json",
    truthSources: [{ sourceId: "SPEC-001", path: "docs/product-spec.md" }],
  };
  const impactMap = { rules: [{ pathPatterns: ["src/**"] }] };
  const policy = buildAssetPolicy({ config, baseline, impactMap });
  const permitted = [
    ["implementation", "src/app.mjs", "managed_implementation"],
    ["truth_proposal", "docs/product-spec.md", "active_truth"],
    ["control_plane", "schemas/task-packet.schema.json", "active_control"],
  ];
  for (const [taskKind, target, assetClass] of permitted) {
    const result = evaluateTaskAssetWrites({ taskKind, paths: [target], policy });
    assert.equal(result.ok, true, `${taskKind}:${target}`);
    assert.equal(result.classified[0].assetClass, assetClass);
  }
  for (const [taskKind, target, assetClass] of [
    ["implementation", "docs/product-spec.md", "active_truth"],
    ["implementation", "schemas/task-packet.schema.json", "active_control"],
    ["implementation", ".env", "sensitive"],
    ["implementation", "misc/unmanaged.txt", "unmanaged"],
    ["implementation", "ai-dev/evidence/bundle.json", "process"],
    ["truth_proposal", "src/app.mjs", "managed_implementation"],
    ["truth_proposal", "schemas/task-packet.schema.json", "active_control"],
    ["control_plane", "docs/product-spec.md", "active_truth"],
    ["control_plane", "src/app.mjs", "managed_implementation"],
    ["evidence_collection", "src/app.mjs", "managed_implementation"],
  ]) {
    const result = evaluateTaskAssetWrites({ taskKind, paths: [target], policy });
    assert.equal(result.ok, false, `${taskKind}:${target}`);
    assert.equal(result.violations[0].assetClass, assetClass);
  }
});

test("Codex instruction binding follows override, nesting, empty-file, size, and split rules", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-flow-instructions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "feature"), { recursive: true });
  await mkdir(path.join(root, "other"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "root rules\n", "utf8");
  await writeFile(path.join(root, "src", "AGENTS.md"), "  \n", "utf8");
  await writeFile(path.join(root, "src", "feature", "AGENTS.md"), "feature rules\n", "utf8");

  let chain = await resolveCodexInstructionChain(root, "src/feature/app.mjs");
  assert.deepEqual(chain.files.map((entry) => entry.path), ["AGENTS.md", "src/feature/AGENTS.md"]);
  await writeFile(path.join(root, "src", "AGENTS.override.md"), "override rules\n", "utf8");
  chain = await resolveCodexInstructionChain(root, "src/feature/app.mjs");
  assert.deepEqual(chain.files.map((entry) => entry.path), [
    "AGENTS.md",
    "src/AGENTS.override.md",
    "src/feature/AGENTS.md",
  ]);
  await assert.rejects(
    resolveTaskInstructionBinding(root, ["src/feature/app.mjs", "other/app.mjs"]),
    (error) => error.code === "INSTRUCTION_CHAIN_SPLIT_REQUIRED",
  );
  await assert.rejects(
    resolveCodexInstructionChain(root, "src/feature/app.mjs", { maxBytes: 5 }),
    (error) => error.code === "INSTRUCTION_LIMIT_EXCEEDED",
  );
});

test("subject content digest ignores staging, commits, and evidence while preserving raw content identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-flow-content-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "old.txt"), "base\n", "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(root, ["config", "user.name", "AI Flow Tests"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const baseRevision = await git(root, ["rev-parse", "HEAD"]);

  await writeFile(path.join(root, "src", "old.txt"), "changed\n", "utf8");
  const unstaged = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  await git(root, ["add", "src/old.txt"]);
  const staged = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(staged.subjectContentDigest, unstaged.subjectContentDigest);
  await git(root, ["commit", "-m", "same content"]);
  const committed = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(committed.subjectContentDigest, unstaged.subjectContentDigest);

  await mkdir(path.join(root, "ai-dev", "evidence"), { recursive: true });
  await writeJson(path.join(root, "ai-dev", "evidence", "bundle.json"), { self: true });
  const withEvidence = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(withEvidence.subjectContentDigest, unstaged.subjectContentDigest);
  assert.equal(withEvidence.entries.some((entry) => entry.path.includes("evidence")), false);

  await git(root, ["update-index", "--chmod=+x", "src/old.txt"]);
  const stagedMode = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(stagedMode.entries.find((entry) => entry.path === "src/old.txt").mode, "100755");
  assert.notEqual(stagedMode.subjectContentDigest, unstaged.subjectContentDigest);
  await git(root, ["commit", "-m", "mode change"]);
  const committedMode = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(committedMode.subjectContentDigest, stagedMode.subjectContentDigest);

  await writeFile(path.join(root, "src", "old.txt"), "changed\r\n", "utf8");
  const crlf = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.notEqual(crlf.subjectContentDigest, unstaged.subjectContentDigest);
  await writeFile(path.join(root, "src", "old.txt"), "changed\n", "utf8");
  await git(root, ["mv", "src/old.txt", "src/new.txt"]);
  const renamed = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.deepEqual(renamed.entries.map((entry) => [entry.path, entry.type]), [
    ["src/new.txt", "file"],
    ["src/old.txt", "deleted"],
  ]);

  const gitDirectory = await git(root, ["rev-parse", "--git-dir"]);
  const symlinkBlobSource = path.join(root, gitDirectory, "symlink-target");
  await writeFile(symlinkBlobSource, "src/new.txt", "utf8");
  const symlinkBlob = await git(root, ["hash-object", "-w", symlinkBlobSource]);
  await rm(symlinkBlobSource);
  await mkdir(path.join(root, "links"), { recursive: true });
  await writeFile(path.join(root, "links", "current"), "src/new.txt", "utf8");
  const nestedRepository = path.join(root, "deps", "module");
  await mkdir(nestedRepository, { recursive: true });
  await git(nestedRepository, ["init"]);
  await git(nestedRepository, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(nestedRepository, ["config", "user.name", "AI Flow Tests"]);
  await writeFile(path.join(nestedRepository, "module.txt"), "module\n", "utf8");
  await git(nestedRepository, ["add", "."]);
  await git(nestedRepository, ["commit", "-m", "module"]);
  const gitlinkRevision = await git(nestedRepository, ["rev-parse", "HEAD"]);
  await git(root, ["update-index", "--add", "--cacheinfo", `120000,${symlinkBlob},links/current`]);
  await git(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkRevision},deps/module`]);
  const specialEntries = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(specialEntries.entries.find((entry) => entry.path === "links/current").type, "symlink");
  assert.equal(specialEntries.entries.find((entry) => entry.path === "deps/module").type, "gitlink");
  await git(root, ["commit", "-m", "special entries"]);
  const committedSpecialEntries = await computeSubjectContentSnapshot(root, baseRevision, {
    excludedPrefixes: ["ai-dev/evidence"],
  });
  assert.equal(
    committedSpecialEntries.subjectContentDigest,
    specialEntries.subjectContentDigest,
  );
});

test("mandatory review coverage and both briefs are deterministic without creating a second truth source", () => {
  const taskPacket = {
    taskId: "TASK-BRIEF",
    goal: "Change one bounded implementation file",
    taskKind: "implementation",
    baseRevision: "b".repeat(40),
    requirementIds: ["REQ-001"],
    acceptanceIds: ["AT-001"],
    constraints: ["Do not change existing product copy", "Do not deploy"],
    scope: { allowedPaths: ["src/app.mjs"], subjectPaths: ["src/app.mjs"], forbiddenPaths: ["AGENTS.md"] },
    assets: { allowedWriteClasses: ["managed_implementation"] },
    verification: { verifierIds: ["VERIFY-001"], requiredEvidenceLevel: "contract" },
    review: {
      profileId: "default",
      mandatoryLensIds: ["evidence", "scope", "spec_conformance"],
    },
    capabilities: [{ capabilityId: "repository_read" }, { capabilityId: "repository_write" }],
    risk: { level: "low", domains: ["logic"] },
    decisionDependencies: [],
    derivation: { blockingDecisionIds: [] },
  };
  const contextManifest = {
    taskPacketDigest: digestJson(taskPacket),
    controlDigest: DIGEST("c"),
    subjectContentDigest: DIGEST("d"),
    items: [{ kind: "spec_excerpt", path: "docs/product-spec.md", digest: DIGEST("e"), reason: "REQ-001" }],
    exclusions: [],
  };
  const agent = renderContextBrief({ taskPacket, contextManifest, audience: "agent" });
  const repeated = renderContextBrief({ taskPacket, contextManifest, audience: "agent" });
  const human = renderContextBrief({ taskPacket, contextManifest, audience: "human" });
  assert.deepEqual(agent, repeated);
  assert.notEqual(agent.briefDigest, human.briefDigest);
  assert.equal(agent.content.includes("docs/product-spec.md"), true);
  assert.equal(agent.content.includes("## Task constraints"), true);
  assert.equal(agent.content.includes("- Do not change existing product copy"), true);
  assert.equal(agent.content.includes("- Do not deploy"), true);
  assert.equal(human.content.includes("docs/product-spec.md"), false);

  const missing = validateReviewCoverage({
    profileId: "default",
    verdict: "pass",
    lensCoverage: [{ lensId: "scope", status: "covered" }],
  }, taskPacket);
  assert.equal(missing.errors.some((entry) => entry.code === "REVIEW_LENS_MISSING"), true);
  const invalid = validateReviewCoverage({
    profileId: "default",
    verdict: "pass",
    lensCoverage: [
      { lensId: "evidence", status: "not_applicable" },
      { lensId: "scope", status: "covered" },
      { lensId: "spec_conformance", status: "blocked", decisionId: "DEC-OTHER" },
    ],
  }, taskPacket);
  assert.equal(invalid.errors.some((entry) => entry.code === "REVIEW_LENS_NA_UNJUSTIFIED"), true);
  assert.equal(invalid.errors.some((entry) => entry.code === "REVIEW_LENS_BLOCKER_UNBOUND"), true);
  assert.equal(invalid.errors.some((entry) => entry.code === "REVIEW_PASS_WITHOUT_COVERAGE"), true);
  const justified = validateReviewCoverage({
    profileId: "default",
    verdict: "pass",
    lensCoverage: [
      { lensId: "evidence", status: "not_applicable", rationale: "No external evidence is in scope." },
      { lensId: "scope", status: "covered" },
      { lensId: "spec_conformance", status: "covered" },
    ],
  }, taskPacket);
  assert.equal(justified.ok, true);
});

async function initControllerFixture(t, { externalEffect = false } = {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-flow-controller-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const worktreePath = path.join(fixtureRoot, "candidate");
  const secondWorktreePath = path.join(fixtureRoot, "candidate-two");
  const failedWorktreePath = path.join(fixtureRoot, "candidate-failed-prepare");
  const specPath = path.join(fixtureRoot, "spec.md");
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await writeFile(specPath, SPEC, "utf8");
  const initialized = await cli(["init", projectRoot, "--id", "controller-test", "--spec", specPath, "--json"]);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const baselinePath = path.join(projectRoot, "ai-dev", "baseline.json");
  const baseline = await readJson(baselinePath);
  baseline.status = "active";
  await writeJson(baselinePath, baseline);
  await writeJson(path.join(projectRoot, "ai-dev", "decisions", "register.json"), {
    schemaVersion: 1,
    registerId: "CONTROLLER-DECISIONS",
    baselineId: baseline.baselineId,
    status: "resolved",
    decisions: [],
    stageGates: [{
      stageId: "IMPLEMENTATION",
      title: "Authorized implementation",
      status: "authorized",
      blockingDecisionIds: [],
      evidenceRequired: [],
      authorizationBoundary: "Local implementation only",
    }],
  });
  await writeJson(path.join(projectRoot, "ai-dev", "impact-map.json"), {
    schemaVersion: 1,
    mapId: "CONTROLLER-IMPACT",
    baselineId: baseline.baselineId,
    rules: [{
      ruleId: "SRC-RULE",
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
    registryId: "CONTROLLER-VERIFIERS",
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
      sideEffect: externalEffect
        ? { kind: "network", requiresApproval: true }
        : { kind: "none", requiresApproval: false },
    }],
    globalInvariantVerifierIds: [],
  });
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "app.mjs"), "export const value = 1;\n", "utf8");
  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "ai-flow@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "AI Flow Tests"]);
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "base"]);
  const baseRevision = await git(projectRoot, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(projectRoot, "AGENTS.md"),
    "# Candidate instructions\n\nThese uncommitted instructions must not judge the base-bound task.\n",
    "utf8",
  );
  const requestPath = path.join(projectRoot, ".ai-flow", "generated", "requests", "task.json");
  await writeJson(requestPath, {
    taskId: "TASK-CONTROLLER",
    goal: "Change the bounded source file",
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
  const task = await cli([
    "task", "compile", "--project", projectRoot,
    "--input", ".ai-flow/generated/requests/task.json", "--json",
  ]);
  assert.equal(task.code, 0, task.stderr || task.stdout);
  return {
    fixtureRoot,
    projectRoot,
    worktreePath,
    secondWorktreePath,
    failedWorktreePath,
    taskPacket: await readJson(path.join(projectRoot, "ai-dev", "tasks", "TASK-CONTROLLER.json")),
  };
}

test("controller enforces one writer, CAS, exact resume, capability progression, and non-expanding observations", async (t) => {
  const fixture = await initControllerFixture(t);
  const incompleteBinding = structuredClone(fixture.taskPacket);
  incompleteBinding.controlBinding.components = incompleteBinding.controlBinding.components.filter(
    (entry) => entry.componentId !== "verifier_registry",
  );
  incompleteBinding.controlDigest = digestJson(incompleteBinding.controlBinding);
  const incompleteValidation = await validateBaseControlBinding(
    fixture.projectRoot,
    incompleteBinding,
  );
  assert.equal(incompleteValidation.ok, false);
  assert.equal(incompleteValidation.errors.some(
    (entry) => entry.code === "BASE_CONTROL_COMPONENT_SET_MISMATCH",
  ), true);
  const specIndex = await readJson(path.join(
    fixture.projectRoot,
    ".ai-flow",
    "generated",
    "spec-index",
    `${fixture.taskPacket.specIndexDigest.slice("sha256:".length)}.json`,
  ));
  const decisionPath = "ai-dev/decisions/register.json";
  const decisionRegister = await readJson(path.join(fixture.projectRoot, ...decisionPath.split("/")));
  const failedContext = buildContextManifest({
    taskPacket: fixture.taskPacket,
    specIndex,
    subjectRevision: fixture.taskPacket.baseRevision,
    subjectContentDigest: digestJson({ baseRevision: fixture.taskPacket.baseRevision, entries: [] }),
    createdAt: "2026-08-30T00:59:00Z",
    decisionSource: { path: decisionPath, digest: digestJson(decisionRegister) },
  });
  const failedBrief = renderContextBrief({
    taskPacket: fixture.taskPacket,
    contextManifest: failedContext,
    audience: "agent",
  });
  const failedBriefPath = path.join(
    fixture.projectRoot,
    ".ai-flow",
    "generated",
    "briefs",
    `RUN-PREPARE-FAIL-agent-${failedBrief.briefDigest.slice("sha256:".length)}.md`,
  );
  await mkdir(path.dirname(failedBriefPath), { recursive: true });
  await writeFile(failedBriefPath, "conflicting brief\n", "utf8");
  await assert.rejects(prepareRun({
    project: fixture.projectRoot,
    task: "TASK-CONTROLLER",
    runId: "RUN-PREPARE-FAIL",
    worktreePath: fixture.failedWorktreePath,
    at: "2026-08-30T00:59:00Z",
  }), (error) => error.code === "ARTIFACT_CONFLICT"
    && error.errors.some((entry) => entry.code === "RUN_PREPARE_WORKTREE_PRESERVED"));
  await access(fixture.failedWorktreePath);
  await assert.rejects(access(path.join(fixture.projectRoot, ".ai-flow", "controller", "writer.lock")));
  const prepared = await prepareRun({
    project: fixture.projectRoot,
    task: "TASK-CONTROLLER",
    runId: "RUN-CONTROLLER",
    worktreePath: fixture.worktreePath,
    at: "2026-08-30T01:00:00Z",
  });
  assert.equal(prepared.status, "pass");
  assert.equal(prepared.runDigest, digestJson(prepared.runRecord));
  assert.equal(prepared.runRecord.state, "ready");
  assert.equal(prepared.runRecord.checkpoints[0].phase, "prepared");
  assert.deepEqual(Object.keys(prepared.runRecord.briefRefs).sort(), ["agent", "human"]);
  await access(path.join(fixture.projectRoot, ...prepared.runRecord.briefRefs.agent.split("/")));
  await access(path.join(fixture.projectRoot, ...prepared.runRecord.briefRefs.human.split("/")));
  await assert.rejects(prepareRun({
    project: fixture.projectRoot,
    task: "TASK-CONTROLLER",
    runId: "RUN-CONTROLLER-TWO",
    worktreePath: fixture.secondWorktreePath,
    at: "2026-08-30T01:00:01Z",
  }), (error) => error.code === "RUN_WRITER_LOCKED");

  const frameworkLockPath = path.join(fixture.projectRoot, "ai-dev", "framework-lock.json");
  const currentFrameworkLock = await readJson(frameworkLockPath);
  const rollingMarkerRelativePath = "tools/ai-flow/rolling-runtime-marker.txt";
  const rollingMarkerPath = path.join(fixture.projectRoot, ...rollingMarkerRelativePath.split("/"));
  const rollingMarkerContent = Buffer.from("same compatibility line, different trusted runtime\n", "utf8");
  await writeFile(rollingMarkerPath, rollingMarkerContent);
  const rollingFrameworkLock = structuredClone(currentFrameworkLock);
  rollingFrameworkLock.managedFiles.push({
    path: rollingMarkerRelativePath,
    digest: digestFileContent(rollingMarkerRelativePath, rollingMarkerContent),
    ownership: "framework",
    source: "runtime-marker.txt",
  });
  rollingFrameworkLock.managedFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  rollingFrameworkLock.distributionDigest = digestJson({
    frameworkName: rollingFrameworkLock.frameworkName,
    frameworkVersion: rollingFrameworkLock.frameworkVersion,
    managedFiles: rollingFrameworkLock.managedFiles,
  });
  await writeJson(frameworkLockPath, rollingFrameworkLock);
  const runtimeStale = await inspectRun({ project: fixture.projectRoot, runId: "RUN-CONTROLLER" });
  assert.equal(runtimeStale.status, "blocked");
  assert.equal(runtimeStale.errors.some((entry) => entry.code === "RUN_JUDGE_RUNTIME_STALE"), true);
  assert.equal(runtimeStale.nextAction.kind, "resolve_blockers");
  assert.equal(runtimeStale.nextAction.command, null);
  assert.equal(runtimeStale.nextAction.blockingCodes.includes("RUN_JUDGE_RUNTIME_STALE"), true);
  await assert.rejects(
    resumeRun({ project: fixture.projectRoot, runId: "RUN-CONTROLLER" }),
    (error) => error.code === "RUN_RESUME_BLOCKED"
      && error.errors.some((entry) => entry.code === "RUN_JUDGE_RUNTIME_STALE")
      && error.nextAction.kind === "resolve_blockers"
      && error.nextAction.blockingCodes.includes("RUN_JUDGE_RUNTIME_STALE"),
  );
  const serializedRuntimeStale = await resumeRunCommand({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
  });
  assert.equal(serializedRuntimeStale.status, "blocked");
  assert.equal(serializedRuntimeStale.code, "RUN_RESUME_BLOCKED");
  assert.equal(serializedRuntimeStale.nextAction.kind, "resolve_blockers");
  assert.equal(serializedRuntimeStale.nextAction.command, null);
  assert.equal(
    serializedRuntimeStale.nextAction.blockingCodes.includes("RUN_JUDGE_RUNTIME_STALE"),
    true,
  );
  await writeJson(frameworkLockPath, currentFrameworkLock);
  await rm(rollingMarkerPath);

  const inspected = await inspectRun({ project: fixture.projectRoot, runId: "RUN-CONTROLLER" });
  assert.equal(inspected.status, "pass");
  assert.equal(inspected.nextAction.kind, "advance");
  assert.equal(inspected.nextAction.inputTemplate.phase, "implementing");
  assert.equal(inspected.nextAction.command.name, "run advance");
  assert.equal(Object.hasOwn(inspected.nextAction.command, "executable"), false);
  assert.equal(inspected.nextAction.command.arguments.includes(inspected.runDigest), true);
  const preparedDigest = inspected.runDigest;
  const implementing = await advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
    expectedRunDigest: preparedDigest,
    request: {
      phase: "implementing",
      at: "2026-08-30T01:01:00Z",
      reason: "Implementation started",
      contextId: "implementer-controller",
      resolvedCapabilities: ["repository_read"],
      usedCapabilities: ["repository_read"],
      observations: [{
        observationId: "OBS-OUTSIDE",
        kind: "out_of_scope_defect",
        summary: "A separate documentation issue was noticed.",
        paths: ["docs/unrelated.md"],
      }],
    },
  });
  assert.equal(implementing.runDigest, digestJson(implementing.runRecord));
  assert.equal(implementing.runRecord.state, "implementing");
  assert.deepEqual(implementing.runRecord.capabilities.used, ["repository_read"]);
  assert.deepEqual(implementing.runRecord.observations[0].paths, ["docs/unrelated.md"]);
  assert.deepEqual(implementing.envelope.allowedPaths, ["src/app.mjs"]);
  assert.equal(implementing.envelope.taskPacketRef, "ai-dev/tasks/TASK-CONTROLLER.json");
  assert.deepEqual(implementing.envelope.allowedAssetClasses, ["managed_implementation"]);
  const resumedImplementing = await resumeRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
  });
  assert.equal(resumedImplementing.nextAction.kind, "advance");
  assert.equal(resumedImplementing.nextAction.inputTemplate.phase, "verifying");
  await assert.rejects(advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
    expectedRunDigest: preparedDigest,
    request: {
      phase: "verifying",
      at: "2026-08-30T01:01:30Z",
      reason: "stale caller",
    },
  }), (error) => error.code === "RUN_COMPARE_AND_SWAP_MISMATCH");

  const ignoredSensitivePath = path.join(fixture.worktreePath, ".env");
  await writeFile(ignoredSensitivePath, "SECRET=must-not-be-observed\n", "utf8");
  await assert.rejects(
    resumeRun({ project: fixture.projectRoot, runId: "RUN-CONTROLLER" }),
    (error) => error.code === "RUN_RESUME_BLOCKED"
      && error.errors.some((entry) => entry.code === "RUN_SCOPE_STALE"),
  );
  await rm(ignoredSensitivePath);

  await writeFile(path.join(fixture.worktreePath, "src", "app.mjs"), "export const value = 2;\n", "utf8");
  const editedImplementation = await inspectRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
  });
  assert.equal(editedImplementation.status, "blocked");
  assert.equal(editedImplementation.errors.some((entry) => entry.code === "RUN_CONTENT_STALE"), true);
  assert.equal(editedImplementation.nextAction.kind, "advance");
  assert.equal(editedImplementation.nextAction.inputTemplate.phase, "verifying");
  await assert.rejects(
    resumeRun({ project: fixture.projectRoot, runId: "RUN-CONTROLLER" }),
    (error) => error.code === "RUN_RESUME_BLOCKED"
      && error.nextAction.kind === "advance"
      && error.nextAction.inputTemplate.phase === "verifying",
  );
  assert.equal(await readFile(path.join(fixture.worktreePath, "src", "app.mjs"), "utf8"), "export const value = 2;\n");
  await assert.rejects(advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
    expectedRunDigest: digestJson(implementing.runRecord),
    request: {
      phase: "verifying",
      at: "2026-08-30T01:02:00Z",
      reason: "Unresolved capability use",
      usedCapabilities: ["repository_write"],
    },
  }), (error) => error.code === "CAPABILITY_NOT_RESOLVED");
  const verifying = await advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
    expectedRunDigest: digestJson(implementing.runRecord),
    request: {
      phase: "verifying",
      at: "2026-08-30T01:02:00Z",
      reason: "Implementation completed",
      resolvedCapabilities: ["repository_write"],
      usedCapabilities: ["repository_write"],
    },
  });
  assert.equal(verifying.runDigest, digestJson(verifying.runRecord));
  assert.equal(verifying.runRecord.state, "verifying");
  assert.notEqual(verifying.runRecord.subjectContentDigest, prepared.runRecord.subjectContentDigest);
  const resumedVerifying = await resumeRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
  });
  assert.equal(resumedVerifying.nextAction.kind, "verify");
  assert.equal(resumedVerifying.nextAction.command.name, "verify");
  assert.equal(Object.hasOwn(resumedVerifying.nextAction.command, "executable"), false);
  assert.equal(
    resumedVerifying.nextAction.command.arguments.includes(fixture.taskPacket.verification.tier),
    true,
  );
  assert.equal(resumedVerifying.nextAction.afterSuccess.inputTemplate.phase, "reviewing");
  await writeFile(path.join(fixture.worktreePath, "src", "app.mjs"), "export const value = 3;\n", "utf8");
  await assert.rejects(advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
    expectedRunDigest: digestJson(verifying.runRecord),
    request: {
      phase: "reviewing",
      at: "2026-08-30T01:02:30Z",
      reason: "Stale verification must not follow changed content",
      contextId: "reviewer-controller",
      verificationResultRefs: [],
      verificationResultDigests: [],
    },
  }), (error) => error.code === "RUN_PHASE_CONTENT_STALE");
  await writeFile(path.join(fixture.worktreePath, "src", "app.mjs"), "export const value = 2;\n", "utf8");
  const deadPid = await new Promise((resolve) => {
    const child = execFile(process.execPath, ["-e", ""], { windowsHide: true }, () => resolve(child.pid));
  });
  const interruptedOperationLock = path.join(
    fixture.projectRoot,
    ".ai-flow",
    "controller",
    "operation.lock",
  );
  await writeFile(interruptedOperationLock, `${JSON.stringify({ runId: "RUN-CONTROLLER", pid: deadPid })}\n`, "utf8");
  assert.equal((await resumeRun({ project: fixture.projectRoot, runId: "RUN-CONTROLLER" })).status, "pass");
  await assert.rejects(access(interruptedOperationLock));

  const abandoned = await abandonRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
    expectedRunDigest: digestJson(verifying.runRecord),
    at: "2026-08-30T01:03:00Z",
    reason: "Test completed without deleting candidate work",
  });
  assert.equal(abandoned.runRecord.state, "escalated");
  await access(path.join(fixture.worktreePath, "src", "app.mjs"));
  const writerLock = path.join(fixture.projectRoot, ".ai-flow", "controller", "writer.lock");
  await assert.rejects(access(writerLock));
  await writeFile(writerLock, `${JSON.stringify({
    runId: "RUN-CONTROLLER",
    worktreePath: fixture.worktreePath.replaceAll("\\", "/"),
  })}\n`, "utf8");
  const recoveredTerminal = await resumeRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
  });
  assert.equal(recoveredTerminal.terminal, true);
  assert.equal(recoveredTerminal.writerLockReleased, true);
  assert.equal(recoveredTerminal.nextAction.kind, "none");
  assert.equal(recoveredTerminal.nextAction.terminalState, "escalated");
  await assert.rejects(access(writerLock));
  const repeatedRecovery = await resumeRun({
    project: fixture.projectRoot,
    runId: "RUN-CONTROLLER",
  });
  assert.equal(repeatedRecovery.writerLockReleased, false);
});

test("controller rechecks one consumed authorization without requiring a second nonce", async (t) => {
  const fixture = await initControllerFixture(t, { externalEffect: true });
  const authorization = attachExecutionAuthorizationDigest({
    schemaVersion: 1,
    authorizationId: "AUTH-CONTROLLER",
    runId: "RUN-AUTHORIZED",
    taskId: fixture.taskPacket.taskId,
    taskPacketDigest: digestJson(fixture.taskPacket),
    baseRevision: fixture.taskPacket.baseRevision,
    controlDigest: fixture.taskPacket.controlDigest,
    allowedPaths: ["src/app.mjs"],
    allowedExternalEffects: ["network_write"],
    issuedAt: "2026-08-30T01:00:00Z",
    expiresAt: "2026-08-30T01:02:00Z",
    nonce: "nonce-controller-0001",
    issuedBy: "Owner",
  });
  const authorizationRelativePath = "ai-dev/authorizations/controller.json";
  const authorizationPath = path.join(fixture.projectRoot, ...authorizationRelativePath.split("/"));
  await writeJson(authorizationPath, authorization);
  const prepared = await prepareRun({
    project: fixture.projectRoot,
    task: "TASK-CONTROLLER",
    runId: "RUN-AUTHORIZED",
    worktreePath: fixture.worktreePath,
    authorizationPath: authorizationRelativePath,
    at: "2026-08-30T01:00:10Z",
  });
  assert.equal(prepared.runRecord.authorizationConsumptions.length, 1);
  assert.equal(
    prepared.runRecord.authorizationConsumptions[0].authorizationRef,
    authorizationRelativePath,
  );
  const implementing = await advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-AUTHORIZED",
    expectedRunDigest: digestJson(prepared.runRecord),
    request: {
      phase: "implementing",
      at: "2026-08-30T01:00:30Z",
      reason: "Authorized external-capability task started",
      contextId: "authorized-implementer",
      externalEffects: ["network_write"],
    },
  });
  assert.equal(implementing.runRecord.authorizationConsumptions.length, 1);

  await writeJson(authorizationPath, { ...authorization, allowedPaths: ["tests/**"] });
  await assert.rejects(advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-AUTHORIZED",
    expectedRunDigest: digestJson(implementing.runRecord),
    request: {
      phase: "verifying",
      at: "2026-08-30T01:01:00Z",
      reason: "Tampered authorization must fail",
    },
  }), (error) => error.code === "RUN_AUTHORIZATION_STALE");
  await writeJson(authorizationPath, authorization);

  await assert.rejects(advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-AUTHORIZED",
    expectedRunDigest: digestJson(implementing.runRecord),
    request: {
      phase: "verifying",
      at: "2026-08-30T01:01:10Z",
      reason: "Undeclared effect must fail",
      externalEffects: ["production"],
    },
  }), (error) => error.code === "RUN_EXTERNAL_EFFECT_EXPANDED");
  await assert.rejects(advanceRun({
    project: fixture.projectRoot,
    runId: "RUN-AUTHORIZED",
    expectedRunDigest: digestJson(implementing.runRecord),
    request: {
      phase: "verifying",
      at: "2026-08-30T01:02:00Z",
      reason: "Expired authorization must fail",
    },
  }), (error) => error.code === "RUN_AUTHORIZATION_STALE"
    && error.errors.some((entry) => entry.code === "AUTHORIZATION_EXPIRED"));

  const abandoned = await abandonRun({
    project: fixture.projectRoot,
    runId: "RUN-AUTHORIZED",
    expectedRunDigest: digestJson(implementing.runRecord),
    at: "2026-08-30T01:03:00Z",
    reason: "Preserve the authorized candidate after the test",
  });
  assert.equal(abandoned.runRecord.state, "escalated");
  await access(fixture.worktreePath);
});
