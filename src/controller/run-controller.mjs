import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  computeEvidenceBundleDigest,
  digestJson,
  evaluateTaskAssetWrites,
  validateSchema,
} from "../core/index.mjs";
import {
  CliOperationError,
  assertProjectSchema,
  ensureWithinDirectory,
  listJsonArtifacts,
  loadHealthyProject,
  readProjectJson,
  writeJsonArtifact,
  writeTextArtifact,
} from "../cli/project-artifacts.mjs";
import { resolveWithin, validateRelativePath } from "../cli/path-safety.mjs";
import {
  defaultSpecIndexPath,
  loadContext,
  loadReview,
  loadTask,
  loadVerificationResult,
  taskSemanticErrors,
} from "../cli/project-runtime.mjs";
import { analyzeImpact, buildContextManifest, renderContextBrief } from "../task/index.mjs";
import { createRunRecord, transitionRun } from "../workflow/state-machine.mjs";
import {
  computeSubjectContentSnapshot,
  computeWorktreeSnapshot,
  frameworkProcessArtifactPrefixes,
  inspectTaskScope,
  readProjectSchemaAtRevision,
} from "../verify/git-scope.mjs";
import { digestDeclaredInputs } from "../verify/cache.mjs";
import { runProcess } from "../verify/process-runner.mjs";
import { resolveSafeDirectory } from "../verify/safe-path.mjs";
import { validateBaseControlBinding } from "./active-control.mjs";
import { authorizationRequired, validateExecutionAuthorization } from "./authorization.mjs";
import { adjudicateWorkflowCycle } from "../workflow/adjudicator.mjs";
import { evaluateSealedEvidenceFreshness } from "../workflow/evidence-seal.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ADVANCE_FIELDS = new Set([
  "phase",
  "at",
  "reason",
  "contextId",
  "verificationResultRefs",
  "verificationResultDigests",
  "findingFingerprints",
  "reviewReportRef",
  "evidenceLevel",
  "evidenceBundleRef",
  "exclusions",
  "resolvedCapabilities",
  "usedCapabilities",
  "observations",
  "externalEffects",
]);

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function controllerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw controllerError("RUN_ID_INVALID", "runId must be a portable stable identifier");
  }
}

function assertUtc(value, label = "at") {
  if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw controllerError("RUN_TIME_INVALID", `${label} must be an explicit valid UTC timestamp`);
  }
}

function assertAdvanceRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw controllerError("RUN_ADVANCE_INVALID", "advance request must be an object");
  }
  const unknown = Object.keys(request).filter((key) => !ADVANCE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw controllerError("RUN_ADVANCE_FIELD_UNKNOWN", "advance request contains unsupported fields", {
      fields: unknown.sort(),
    });
  }
  if (typeof request.reason !== "string" || !request.reason.trim()) {
    throw controllerError("RUN_ADVANCE_REASON_INVALID", "advance requires a non-empty reason");
  }
  if (!Array.isArray(request.externalEffects ?? [])) {
    throw controllerError("RUN_EXTERNAL_EFFECTS_INVALID", "externalEffects must be an array");
  }
}

async function git(cwd, args) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000, outputLimitBytes: 16 * 1024 * 1024 });
  if (result.exitCode !== 0) throw controllerError("GIT_COMMAND_FAILED", result.stderr.trim() || result.error || "Git command failed", { result });
  return result.stdout.trim();
}

function comparable(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function judgeRuntimeBindingErrors(ctx, activeControl) {
  const expected = activeControl?.frameworkLock;
  const actual = ctx.lock;
  if (!expected || !actual) {
    return [{ code: "RUN_JUDGE_RUNTIME_STALE", message: "base or current framework distribution lock is unavailable" }];
  }
  const mismatches = [];
  for (const field of ["frameworkName", "frameworkVersion", "distributionDigest"]) {
    if (actual[field] !== expected[field]) {
      mismatches.push({ field, expected: expected[field] ?? null, actual: actual[field] ?? null });
    }
  }
  return mismatches.length === 0
    ? []
    : [{
      code: "RUN_JUDGE_RUNTIME_STALE",
      message: "current trusted runtime differs from the base Active Control framework distribution",
      mismatches,
    }];
}

function assertJudgeRuntimeBinding(ctx, activeControl) {
  const errors = judgeRuntimeBindingErrors(ctx, activeControl);
  if (errors.length > 0) {
    throw controllerError(
      "JUDGE_RUNTIME_STALE",
      "the current runtime cannot judge a task bound to a different base framework distribution",
      { errors },
    );
  }
}

async function validateNewWorktreePath(projectRoot, worktreePath) {
  if (!path.isAbsolute(worktreePath)) throw controllerError("WORKTREE_PATH_NOT_ABSOLUTE", "prepare requires an explicit absolute worktree path");
  const resolved = path.resolve(worktreePath);
  if (resolved === path.parse(resolved).root) throw controllerError("WORKTREE_PATH_UNSAFE", "worktree cannot be a filesystem root");
  const projectKey = comparable(projectRoot);
  const worktreeKey = comparable(resolved);
  if (worktreeKey === projectKey || worktreeKey.startsWith(`${projectKey}/`)) {
    throw controllerError("WORKTREE_PATH_INSIDE_PROJECT", "isolated worktree must be outside the selected project");
  }
  if (await exists(resolved)) throw controllerError("WORKTREE_PATH_EXISTS", "prepare only accepts a path that does not exist");
  const parent = path.dirname(resolved);
  const stats = await lstat(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw controllerError("WORKTREE_PARENT_UNSAFE", "worktree parent must be a real directory");
  return resolved;
}

function runRelativePath(config, runId) {
  return validateRelativePath(path.posix.join(config.paths.runs, `${runId}.json`));
}

function writerLockPath(projectRoot, config) {
  return resolveWithin(projectRoot, validateRelativePath(path.posix.join(config.paths.controller, "writer.lock")));
}

function operationLockPath(projectRoot, config) {
  return resolveWithin(projectRoot, validateRelativePath(path.posix.join(config.paths.controller, "operation.lock")));
}

async function ensureControllerDirectory(projectRoot, config) {
  const relative = validateRelativePath(config.paths.controller);
  await mkdir(resolveWithin(projectRoot, relative), { recursive: true });
  await resolveSafeDirectory(projectRoot, relative);
}

async function acquireWriterLock(projectRoot, config, runId, worktreePath) {
  await ensureControllerDirectory(projectRoot, config);
  const lockPath = writerLockPath(projectRoot, config);
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ runId, worktreePath })}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    throw controllerError("RUN_WRITER_LOCKED", "another run owns the project controller", { owner });
  }
}

async function ensureWriterOwnership(projectRoot, config, runId) {
  const lockPath = writerLockPath(projectRoot, config);
  if (!await exists(lockPath)) throw controllerError("RUN_WRITER_LOCK_MISSING", "run no longer owns the controller lock");
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  if (owner.runId !== runId) throw controllerError("RUN_WRITER_LOCKED", "another run owns the project controller", { owner });
  return owner;
}

async function releaseWriterLock(projectRoot, config, runId) {
  await ensureWriterOwnership(projectRoot, config, runId);
  await rm(writerLockPath(projectRoot, config));
}

async function withOperationLock(projectRoot, config, runId, action) {
  await ensureControllerDirectory(projectRoot, config);
  const lockPath = operationLockPath(projectRoot, config);
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ runId, pid: process.pid })}\n`, "utf8");
  } catch (error) {
    if (error.code === "EEXIST") {
      let owner = null;
      try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* reported as an opaque busy lock */ }
      throw controllerError("RUN_COMPARE_AND_SWAP_BUSY", "another controller operation is in progress", { owner });
    }
    throw error;
  } finally {
    await handle?.close();
  }
  try { return await action(); } finally { await rm(lockPath, { force: true }); }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function recoverOperationLock(projectRoot, config, runId) {
  const lockPath = operationLockPath(projectRoot, config);
  if (!await exists(lockPath)) return false;
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    throw controllerError("RUN_OPERATION_LOCK_INVALID", "the interrupted controller operation lock is malformed");
  }
  if (owner?.runId !== runId) {
    throw controllerError("RUN_COMPARE_AND_SWAP_BUSY", "another run owns the interrupted controller operation", { owner });
  }
  if (processIsAlive(owner.pid)) {
    throw controllerError("RUN_COMPARE_AND_SWAP_BUSY", "the controller operation is still active", { owner });
  }
  await rm(lockPath);
  return true;
}

async function atomicCreateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
}

async function atomicReplaceJson(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadRunFile(ctx, runId) {
  const relativePath = runRelativePath(ctx.config, runId);
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "run-record", "run record", value);
  return { value, relativePath, absolutePath: resolveWithin(ctx.projectRoot, relativePath) };
}

async function assertBaseSchema(ctx, baseRevision, schemaName, label, value) {
  let schema;
  try {
    schema = (await readProjectSchemaAtRevision(
      ctx.projectRoot,
      baseRevision,
      schemaName,
    )).value;
  } catch (error) {
    throw controllerError("BASE_SCHEMA_UNAVAILABLE", `base Active Control ${label} schema is unavailable`, {
      schemaName,
      detail: error.message,
    });
  }
  const errors = validateSchema(value, schema);
  if (errors.length > 0) {
    throw controllerError("BASE_SCHEMA_INVALID", `${label} does not satisfy base Active Control`, {
      schemaName,
      errors,
    });
  }
}

async function worktreeIdentity(worktreePath, expectedBase = null) {
  const resolvedPath = await realpath(worktreePath);
  const [headRevision, gitDirectory] = await Promise.all([
    git(resolvedPath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(resolvedPath, ["rev-parse", "--absolute-git-dir"]),
  ]);
  if (expectedBase && headRevision !== expectedBase) {
    let descendsFromBase = true;
    try { await git(resolvedPath, ["merge-base", "--is-ancestor", expectedBase, "HEAD"]); } catch { descendsFromBase = false; }
    if (!descendsFromBase) throw controllerError("WORKTREE_BASE_MISMATCH", "worktree no longer descends from the bound base commit");
  }
  const identity = { path: resolvedPath.replaceAll("\\", "/"), gitDirectory: gitDirectory.replaceAll("\\", "/") };
  return { ...identity, headRevision, worktreeIdentityDigest: digestJson(identity) };
}

function externalEffectsForTask(taskPacket) {
  const mapping = {
    network: "network_write",
    external_service: "external_service_write",
    physical: "physical",
    production: "production",
  };
  return [...new Set((taskPacket.risk?.sideEffects ?? [])
    .filter((entry) => entry.requiresApproval)
    .map((entry) => mapping[entry.kind])
    .filter(Boolean))].sort();
}

async function consumedNonces(ctx, { ignoreRunId = null, ignoreAuthorizationDigest = null } = {}) {
  const result = [];
  for (const relativePath of await listJsonArtifacts(ctx.projectRoot, ctx.config.paths.runs)) {
    const run = await readProjectJson(ctx.projectRoot, relativePath);
    for (const entry of run.authorizationConsumptions ?? []) {
      if (run.runId === ignoreRunId && entry.authorizationDigest === ignoreAuthorizationDigest) continue;
      result.push(entry.nonce);
    }
  }
  return result;
}

async function loadAuthorization(ctx, relativePath) {
  if (!relativePath) return null;
  const normalized = validateRelativePath(relativePath);
  const expectedRoot = `${validateRelativePath(ctx.config.paths.authorizations)}/`;
  if (!normalized.startsWith(expectedRoot)) throw controllerError("AUTHORIZATION_PATH_INVALID", `authorization must be under ${ctx.config.paths.authorizations}`);
  const value = await readProjectJson(ctx.projectRoot, normalized);
  await assertProjectSchema(ctx.projectRoot, "execution-authorization", "execution authorization", value);
  return { value, path: normalized };
}

function consumeAuthorization(runRecord, authorization, authorizationRef, at, paths, externalEffects) {
  if (!authorization) return runRecord;
  const next = structuredClone(runRecord);
  next.authorizationConsumptions.push({
    authorizationRef,
    authorizationDigest: authorization.authorizationDigest,
    nonce: authorization.nonce,
    consumedAt: at,
    paths: [...new Set(paths)].sort(),
    externalEffects: [...new Set(externalEffects)].sort(),
  });
  return next;
}

async function revalidateRunAuthorization(ctx, runRecord, taskPacket, at, requestedPaths, requestedExternalEffects) {
  const declaredExternalEffects = externalEffectsForTask(taskPacket);
  const expandedEffects = requestedExternalEffects.filter((entry) => !declaredExternalEffects.includes(entry));
  if (expandedEffects.length > 0) {
    throw controllerError("RUN_EXTERNAL_EFFECT_EXPANDED", "observed external effects exceed the TaskPacket", {
      expandedEffects,
    });
  }
  if (!authorizationRequired(taskPacket, declaredExternalEffects)) return;
  if (runRecord.authorizationConsumptions.length !== 1) {
    throw controllerError("RUN_AUTHORIZATION_STALE", "the run must contain exactly one bound execution authorization consumption");
  }
  const consumption = runRecord.authorizationConsumptions[0];
  const loaded = await loadAuthorization(ctx, consumption.authorizationRef);
  const authorization = loaded?.value;
  const expectedPaths = [...new Set(taskPacket.scope.allowedPaths)].sort();
  if (!authorization
    || authorization.authorizationDigest !== consumption.authorizationDigest
    || authorization.nonce !== consumption.nonce
    || digestJson(consumption.paths) !== digestJson(expectedPaths)
    || digestJson(consumption.externalEffects) !== digestJson(declaredExternalEffects)) {
    throw controllerError("RUN_AUTHORIZATION_STALE", "the recorded execution authorization consumption is not self-consistent");
  }
  const validation = validateExecutionAuthorization({
    authorization,
    runId: runRecord.runId,
    taskPacket,
    requestedPaths,
    requestedExternalEffects: declaredExternalEffects,
    now: at,
    consumedNonces: await consumedNonces(ctx, {
      ignoreRunId: runRecord.runId,
      ignoreAuthorizationDigest: consumption.authorizationDigest,
    }),
  });
  if (!validation.ok) {
    throw controllerError("RUN_AUTHORIZATION_STALE", "the execution authorization is no longer valid", {
      errors: validation.errors,
    });
  }
}

function checkpoint(runRecord, phase, at, identity, subjectContentDigest) {
  return {
    checkpointId: `CP:${runRecord.runId}:${String(runRecord.checkpoints.length + 1).padStart(4, "0")}`,
    phase,
    at,
    taskPacketDigest: runRecord.taskPacketDigest,
    controlDigest: runRecord.controlDigest,
    subjectContentDigest,
    worktreeIdentityDigest: identity.worktreeIdentityDigest,
  };
}

function executionEnvelope(runRecord, taskPacket, identity) {
  return {
    runId: runRecord.runId,
    runDigest: digestJson(runRecord),
    taskId: taskPacket.taskId,
    taskKind: taskPacket.taskKind,
    taskPacketRef: runRecord.taskPacketRef,
    taskPacketDigest: runRecord.taskPacketDigest,
    baseRevision: runRecord.baseRevision,
    controlDigest: runRecord.controlDigest,
    subjectContentDigest: runRecord.subjectContentDigest,
    worktreePath: identity.path,
    worktreeIdentityDigest: identity.worktreeIdentityDigest,
    allowedPaths: taskPacket.scope.allowedPaths,
    forbiddenPaths: taskPacket.scope.forbiddenPaths,
    allowedAssetClasses: taskPacket.assets.allowedWriteClasses,
    capabilities: runRecord.capabilities.admitted,
    externalEffects: externalEffectsForTask(taskPacket),
    review: taskPacket.review,
    contextManifestRef: runRecord.contextManifestRef,
    briefRefs: runRecord.briefRefs ?? {},
  };
}

function logicalCommand(name, argumentsList) {
  return { name, arguments: argumentsList };
}

function advanceAction({ projectRoot, runRecord, runDigest, phase, inputTemplate }) {
  return {
    kind: "advance",
    command: logicalCommand("run advance", [
      "--project",
      projectRoot,
      "--run",
      runRecord.runId,
      "--expected-run-digest",
      runDigest,
      "--input",
      "<advance-request.json>",
      "--json",
    ]),
    inputTemplate: { phase, ...inputTemplate },
  };
}

function deriveNextAction({ projectRoot, runRecord, taskPacket = null, runDigest, errors = [] }) {
  const expectedContentDrift = ["implementing", "repairing"].includes(runRecord.state);
  const blockingErrors = errors.filter((entry) => !(expectedContentDrift && (
    entry.code === "RUN_CONTENT_STALE"
    || (entry.code === "RUN_CHECKPOINT_STALE" && entry.field === "subjectContentDigest")
  )));
  if (blockingErrors.length > 0) {
    return {
      kind: "resolve_blockers",
      command: null,
      blockingCodes: [...new Set(blockingErrors.map((entry) => entry.code).filter(Boolean))].sort(),
    };
  }
  if (["accepted", "escalated"].includes(runRecord.state)) {
    return { kind: "none", command: null, terminalState: runRecord.state };
  }
  if (runRecord.state === "ready") {
    return advanceAction({
      projectRoot,
      runRecord,
      runDigest,
      phase: "implementing",
      inputTemplate: {
        at: "<UTC-time>",
        reason: "<reason>",
        contextId: "<implementer-context-id>",
      },
    });
  }
  if (["implementing", "repairing"].includes(runRecord.state)) {
    return advanceAction({
      projectRoot,
      runRecord,
      runDigest,
      phase: "verifying",
      inputTemplate: { at: "<UTC-time>", reason: "<reason>" },
    });
  }
  if (runRecord.state === "verifying") {
    return {
      kind: "verify",
      command: logicalCommand("verify", [
        "--project",
        projectRoot,
        "--tier",
        taskPacket.verification.tier,
        "--run",
        runRecord.runId,
        "--json",
      ]),
      afterSuccess: advanceAction({
        projectRoot,
        runRecord,
        runDigest,
        phase: "reviewing",
        inputTemplate: {
          at: "<UTC-time>",
          reason: "<reason>",
          contextId: "<fresh-reviewer-context-id>",
          verificationResultRefs: ["<verify.verificationResultArtifacts[].reference>"],
          verificationResultDigests: [{
            resultId: "<verify.results[].resultId>",
            resultDigest: "<verify.results[].resultDigest>",
          }],
        },
      }),
    };
  }
  if (runRecord.state === "reviewing") {
    const requiredAuthorityKinds = taskPacket.verification.requiredAuthorityKinds ?? [];
    return {
      kind: "finalize",
      command: logicalCommand("run finalize", [
        "--project",
        projectRoot,
        "--run",
        runRecord.runId,
        "--expected-run-digest",
        runDigest,
        "--input",
        "<finalize-request.json>",
        "--json",
      ]),
      inputTemplate: {
        bundleId: "<bundle-id>",
        createdAt: "<UTC-time>",
        reason: "<reason>",
        reviewReports: ["<independent-review-report-ref>"],
        ...(requiredAuthorityKinds.length > 0 ? {
          authorityReceiptRefs: requiredAuthorityKinds.map((kind) => `<${kind}-receipt-ref>`),
        } : {}),
        limitations: [],
        exclusions: [],
      },
    };
  }
  return { kind: "resolve_blockers", command: null, blockingCodes: ["RUN_STATE_NOT_ACTIONABLE"] };
}

async function materializeRunContext({
  ctx,
  taskPacket,
  baseControl,
  subjectRevision,
  subjectContentDigest,
  at,
  runId,
}) {
  const specIndexPath = defaultSpecIndexPath(ctx.config, taskPacket.specIndexDigest);
  const specIndex = await readProjectJson(ctx.projectRoot, specIndexPath);
  await assertProjectSchema(ctx.projectRoot, "spec-index", "SpecIndex", specIndex);
  if (digestJson(specIndex) !== taskPacket.specIndexDigest) {
    throw controllerError("SPEC_INDEX_DIGEST_MISMATCH", "TaskPacket SpecIndex content address is stale");
  }
  const contextManifest = buildContextManifest({
    taskPacket,
    specIndex,
    subjectRevision,
    subjectContentDigest,
    createdAt: at,
    decisionSource: {
      path: baseControl.active.baseline.decisionRegister,
      digest: digestJson(baseControl.active.decisionRegister),
    },
  });
  const contextManifestRef = validateRelativePath(path.posix.join(
    ctx.config.paths.generated,
    "contexts",
    `${contextManifest.manifestDigest.slice("sha256:".length)}.json`,
  ));
  await writeJsonArtifact({
    projectRoot: ctx.projectRoot,
    relativePath: contextManifestRef,
    allowedDirectory: ctx.config.paths.generated,
    value: contextManifest,
  });
  const briefRefs = {};
  for (const audience of ["agent", "human"]) {
    const brief = renderContextBrief({ taskPacket, contextManifest, audience });
    const relativePath = validateRelativePath(path.posix.join(
      ctx.config.paths.generated,
      "briefs",
      `${runId}-${audience}-${brief.briefDigest.slice("sha256:".length)}.md`,
    ));
    await writeTextArtifact({
      projectRoot: ctx.projectRoot,
      relativePath,
      allowedDirectory: ctx.config.paths.generated,
      content: brief.content,
    });
    briefRefs[audience] = relativePath;
  }
  return { contextManifest, contextManifestRef, briefRefs };
}

export async function prepareRun({ project, task, runId, worktreePath, authorizationPath = null, at }) {
  assertRunId(runId);
  assertUtc(at);
  const ctx = await loadHealthyProject(project);
  const loadedTask = await loadTask(ctx, task);
  const taskPacket = loadedTask.value;
  const semanticErrors = await taskSemanticErrors(ctx, taskPacket);
  if (semanticErrors.length > 0) throw controllerError("TASK_NOT_READY", "TaskPacket is not ready for execution", { errors: semanticErrors });
  const baseControl = await validateBaseControlBinding(ctx.projectRoot, taskPacket);
  if (!baseControl.ok) throw controllerError("BASE_ACTIVE_CONTROL_MISMATCH", "TaskPacket is not bound to base Active Control", { errors: baseControl.errors });
  assertJudgeRuntimeBinding(ctx, baseControl.active);
  const target = await validateNewWorktreePath(ctx.projectRoot, worktreePath);
  const externalEffects = externalEffectsForTask(taskPacket);
  const loadedAuthorization = await loadAuthorization(ctx, authorizationPath);
  const authorization = loadedAuthorization?.value ?? null;
  if (authorizationRequired(taskPacket, externalEffects) && !authorization) {
    throw controllerError("EXECUTION_AUTHORIZATION_REQUIRED", "control-plane or external writes require a one-time execution authorization");
  }
  if (authorization) {
    const validation = validateExecutionAuthorization({
      authorization,
      runId,
      taskPacket,
      requestedPaths: taskPacket.scope.allowedPaths,
      requestedExternalEffects: externalEffects,
      now: at,
      consumedNonces: await consumedNonces(ctx),
    });
    if (!validation.ok) throw controllerError("EXECUTION_AUTHORIZATION_INVALID", "execution authorization is invalid", { errors: validation.errors });
  }
  await acquireWriterLock(ctx.projectRoot, ctx.config, runId, target);
  let recorded = false;
  try {
    await git(ctx.projectRoot, ["worktree", "add", "--detach", target, taskPacket.baseRevision]);
    const identity = await worktreeIdentity(target, taskPacket.baseRevision);
    const snapshot = await computeWorktreeSnapshot(target, identity.headRevision, {
      excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
    });
    const subject = await computeSubjectContentSnapshot(target, taskPacket.baseRevision, {
      excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
    });
    const runContext = await materializeRunContext({
      ctx,
      taskPacket,
      baseControl,
      subjectRevision: snapshot.subjectRevision,
      subjectContentDigest: subject.subjectContentDigest,
      at,
      runId,
    });
    let runRecord = createRunRecord({
      frameworkVersion: ctx.config.frameworkVersion,
      runId,
      taskPacket,
      taskPacketRef: loadedTask.path,
      subjectRevision: snapshot.subjectRevision,
      worktreeDigest: snapshot.worktreeDigest,
      subjectContentDigest: subject.subjectContentDigest,
      controlDigest: taskPacket.controlDigest,
      startedAt: at,
      contextManifestRef: runContext.contextManifestRef,
      workspace: { kind: "worktree", identifier: identity.path },
      worktreeIdentityDigest: identity.worktreeIdentityDigest,
      briefRefs: runContext.briefRefs,
    });
    runRecord = transitionRun(runRecord, { to: "ready", at, reason: "isolated base-bound run prepared", actorRole: "controller" });
    runRecord = consumeAuthorization(
      runRecord,
      authorization,
      loadedAuthorization?.path ?? null,
      at,
      taskPacket.scope.allowedPaths,
      externalEffects,
    );
    await assertProjectSchema(ctx.projectRoot, "run-record", "run record", runRecord);
    const runPath = resolveWithin(ctx.projectRoot, runRelativePath(ctx.config, runId));
    await atomicCreateJson(runPath, runRecord);
    recorded = true;
    return {
      status: "pass",
      runDigest: digestJson(runRecord),
      runRecord,
      envelope: executionEnvelope(runRecord, taskPacket, identity),
    };
  } catch (error) {
    if (!recorded) await releaseWriterLock(ctx.projectRoot, ctx.config, runId).catch(() => {});
    if (await exists(target)) {
      error.errors = [
        ...(error.errors ?? []),
        {
          code: "RUN_PREPARE_WORKTREE_PRESERVED",
          message: "prepare failed after the isolated worktree was created; the worktree was preserved",
          path: target,
        },
      ];
    }
    throw error;
  }
}

async function inspectBoundRun(ctx, runRecord) {
  const loadedTask = await loadTask(ctx, runRecord.taskPacketRef);
  const taskPacket = loadedTask.value;
  const taskPacketDigest = digestJson(taskPacket);
  const identity = await worktreeIdentity(runRecord.workspace.identifier, runRecord.baseRevision);
  const baseControl = await validateBaseControlBinding(ctx.projectRoot, taskPacket);
  const scope = await inspectTaskScope({
    projectRoot: identity.path,
    baseRevision: runRecord.baseRevision,
    taskPath: null,
    allowedPaths: taskPacket.scope.allowedPaths,
    forbiddenPaths: taskPacket.scope.forbiddenPaths,
    controlPaths: [],
    excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
  });
  const subject = await computeSubjectContentSnapshot(identity.path, runRecord.baseRevision, {
    excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
  });
  const errors = [];
  if (taskPacketDigest !== runRecord.taskPacketDigest) errors.push({ code: "RUN_TASK_PACKET_STALE", message: "TaskPacket changed after run preparation" });
  if (taskPacket.controlDigest !== runRecord.controlDigest || !baseControl.ok) errors.push({ code: "RUN_CONTROL_STALE", message: "base Active Control binding changed", details: baseControl.errors });
  errors.push(...judgeRuntimeBindingErrors(ctx, baseControl.active));
  if (identity.worktreeIdentityDigest !== runRecord.worktreeIdentityDigest) errors.push({ code: "RUN_WORKTREE_IDENTITY_STALE", message: "worktree identity changed" });
  if (!scope.ok) errors.push({ code: "RUN_SCOPE_STALE", message: "actual worktree changes exceed TaskPacket scope", details: scope.errors });
  return { taskPacket, identity, subject, scope, errors, baseControl };
}

function preparedCheckpointErrors(runRecord) {
  const errors = [];
  const first = runRecord.checkpoints?.[0];
  if (!first || first.phase !== "prepared") {
    errors.push({ code: "RUN_PREPARED_CHECKPOINT_MISSING", message: "controller run has no prepared checkpoint" });
  }
  for (const [field, expected] of [
    ["taskPacketDigest", runRecord.taskPacketDigest],
    ["controlDigest", runRecord.controlDigest],
    ["worktreeIdentityDigest", runRecord.worktreeIdentityDigest],
  ]) {
    if (first?.[field] !== expected) {
      errors.push({ code: "RUN_PREPARED_CHECKPOINT_STALE", message: `prepared checkpoint ${field} is not bound to the run` });
    }
  }
  return errors;
}

function checkpointErrors(runRecord, inspection) {
  const errors = preparedCheckpointErrors(runRecord);
  const latest = runRecord.checkpoints?.at(-1);
  for (const [field, expected] of [
    ["taskPacketDigest", runRecord.taskPacketDigest],
    ["controlDigest", runRecord.controlDigest],
    ["subjectContentDigest", inspection.subject.subjectContentDigest],
    ["worktreeIdentityDigest", inspection.identity.worktreeIdentityDigest],
  ]) {
    if (latest?.[field] !== expected) {
      errors.push({
        code: "RUN_CHECKPOINT_STALE",
        message: `latest checkpoint ${field} is not bound to current run content`,
        field,
      });
    }
  }
  if (runRecord.subjectContentDigest !== inspection.subject.subjectContentDigest) {
    errors.push({
      code: "RUN_CONTENT_STALE",
      message: "run record content digest differs from current candidate content",
      field: "subjectContentDigest",
    });
  }
  return errors;
}

export async function withBoundRunOperation({ project, runId, expectedRunDigest, at }, action) {
  assertRunId(runId);
  if (!DIGEST.test(expectedRunDigest ?? "")) throw controllerError("RUN_DIGEST_INVALID", "expectedRunDigest must be a SHA-256 digest");
  assertUtc(at);
  if (typeof action !== "function") throw controllerError("RUN_OPERATION_INVALID", "bound run operation requires an action");
  const ctx = await loadHealthyProject(project);
  const owner = await ensureWriterOwnership(ctx.projectRoot, ctx.config, runId);
  return withOperationLock(ctx.projectRoot, ctx.config, runId, async () => {
    const loaded = await loadRunFile(ctx, runId);
    const actualRunDigest = digestJson(loaded.value);
    if (actualRunDigest !== expectedRunDigest) {
      throw controllerError("RUN_COMPARE_AND_SWAP_MISMATCH", "run changed since it was inspected", {
        expected: expectedRunDigest,
        actual: actualRunDigest,
      });
    }
    if (comparable(owner.worktreePath) !== comparable(loaded.value.workspace.identifier)) {
      throw controllerError("RUN_WRITER_BINDING_STALE", "writer lock is not bound to the run worktree");
    }
    const inspection = await inspectBoundRun(ctx, loaded.value);
    inspection.errors.push(...checkpointErrors(loaded.value, inspection));
    if (inspection.errors.length > 0) {
      throw controllerError("RUN_BINDING_STALE", "run bindings are stale; worktree was preserved", {
        errors: inspection.errors,
      });
    }
    validateActualImpact(inspection.taskPacket, inspection.baseControl.active, inspection.scope.changedPaths);
    await revalidateRunAuthorization(
      ctx,
      loaded.value,
      inspection.taskPacket,
      at,
      inspection.scope.changedPaths,
      [],
    );
    return action({ ctx, loaded, inspection, runRecord: loaded.value, taskPacket: inspection.taskPacket });
  });
}

export async function inspectRun({ project, runId }) {
  assertRunId(runId);
  const ctx = await loadHealthyProject(project);
  const loaded = await loadRunFile(ctx, runId);
  const inspection = await inspectBoundRun(ctx, loaded.value);
  inspection.errors.push(...checkpointErrors(loaded.value, inspection));
  const runDigest = digestJson(loaded.value);
  return {
    status: inspection.errors.length === 0 ? "pass" : "blocked",
    runDigest,
    runRecord: loaded.value,
    currentSubjectContentDigest: inspection.subject.subjectContentDigest,
    nextAction: deriveNextAction({
      projectRoot: ctx.projectRoot,
      runRecord: loaded.value,
      taskPacket: inspection.taskPacket,
      runDigest,
      errors: inspection.errors,
    }),
    errors: inspection.errors,
  };
}

export async function resumeRun({ project, runId }) {
  assertRunId(runId);
  const ctx = await loadHealthyProject(project);
  const loaded = await loadRunFile(ctx, runId);
  if (["accepted", "escalated"].includes(loaded.value.state)) {
    let owner = null;
    try {
      owner = await ensureWriterOwnership(ctx.projectRoot, ctx.config, runId);
    } catch (error) {
      if (error.code !== "RUN_WRITER_LOCK_MISSING") throw error;
    }
    if (owner) {
      if (comparable(owner.worktreePath) !== comparable(loaded.value.workspace.identifier)) {
        throw controllerError("RUN_WRITER_BINDING_STALE", "terminal writer lock is not bound to the run worktree");
      }
      await recoverOperationLock(ctx.projectRoot, ctx.config, runId);
      await releaseWriterLock(ctx.projectRoot, ctx.config, runId);
    }
    return {
      status: "pass",
      runRecord: loaded.value,
      terminal: true,
      writerLockReleased: owner !== null,
      worktreePreservedAt: loaded.value.workspace.identifier,
      nextAction: deriveNextAction({
        projectRoot: ctx.projectRoot,
        runRecord: loaded.value,
        runDigest: digestJson(loaded.value),
      }),
    };
  }
  await ensureWriterOwnership(ctx.projectRoot, ctx.config, runId);
  await recoverOperationLock(ctx.projectRoot, ctx.config, runId);
  const inspection = await inspectBoundRun(ctx, loaded.value);
  inspection.errors.push(...checkpointErrors(loaded.value, inspection));
  const runDigest = digestJson(loaded.value);
  if (inspection.errors.length > 0) {
    const details = {
      errors: inspection.errors,
      nextAction: deriveNextAction({
        projectRoot: ctx.projectRoot,
        runRecord: loaded.value,
        taskPacket: inspection.taskPacket,
        runDigest,
        errors: inspection.errors,
      }),
    };
    const error = new CliOperationError(
      "RUN_RESUME_BLOCKED",
      "run cannot resume safely; worktree was preserved",
      details,
    );
    Object.assign(error, details);
    throw error;
  }
  return {
    status: "pass",
    runRecord: loaded.value,
    envelope: executionEnvelope(loaded.value, inspection.taskPacket, inspection.identity),
    nextAction: deriveNextAction({
      projectRoot: ctx.projectRoot,
      runRecord: loaded.value,
      taskPacket: inspection.taskPacket,
      runDigest,
    }),
  };
}

function applyCapabilities(runRecord, request) {
  const next = structuredClone(runRecord);
  const admitted = new Set(next.capabilities.admitted);
  const newlyResolved = request.resolvedCapabilities ?? [];
  const newlyUsed = request.usedCapabilities ?? [];
  for (const capability of [...newlyResolved, ...newlyUsed]) {
    if (!admitted.has(capability)) throw controllerError("CAPABILITY_NOT_ADMITTED", "capability state cannot expand TaskPacket scope", { capability });
  }
  const resolved = new Set([...next.capabilities.resolved, ...newlyResolved]);
  for (const capability of newlyUsed) {
    if (!resolved.has(capability)) throw controllerError("CAPABILITY_NOT_RESOLVED", "a capability must be resolved before it can be recorded as used", { capability });
  }
  next.capabilities.resolved = [...resolved].sort();
  next.capabilities.used = [...new Set([...next.capabilities.used, ...newlyUsed])].sort();
  return next;
}

function validateActualImpact(taskPacket, activeControl, changedPaths) {
  if (changedPaths.length === 0) return null;
  const assetEvaluation = evaluateTaskAssetWrites({
    taskKind: taskPacket.taskKind,
    paths: changedPaths,
    policy: activeControl.assetPolicy,
  });
  if (!assetEvaluation.ok) {
    throw controllerError("RUN_ASSET_WRITE_FORBIDDEN", "actual changes violate the task kind asset matrix", {
      errors: assetEvaluation.violations,
    });
  }
  let impact;
  try {
    impact = analyzeImpact({
      changedPaths,
      impactMap: activeControl.impactMap,
      baselineId: taskPacket.baselineId,
      requireAllPathsMapped: taskPacket.taskKind === "implementation" || taskPacket.taskKind === "evidence_collection",
    });
  } catch (error) {
    throw controllerError("RUN_ACTUAL_IMPACT_INVALID", "actual changes cannot be justified by base Active Control", {
      errors: [{ code: error.code ?? "IMPACT_INVALID", message: error.message, ...(error.details ?? {}) }],
    });
  }
  for (const [field, actualValues, declaredValues] of [
    ["requirements", [...impact.impactedRequirementIds, ...impact.globalInvariantIds], taskPacket.requirementIds],
    ["acceptance", impact.acceptanceIds, taskPacket.acceptanceIds],
    ["verifiers", impact.verifierIds, taskPacket.verification.verifierIds],
  ]) {
    const expanded = [...new Set(actualValues)].filter((entry) => !declaredValues.includes(entry));
    if (expanded.length > 0) {
      throw controllerError("RUN_ACTUAL_IMPACT_EXPANDED", `actual ${field} impact exceeds the TaskPacket`, {
        field,
        expanded,
      });
    }
  }
  return impact;
}

function appendObservations(runRecord, request) {
  const next = structuredClone(runRecord);
  for (const observation of request.observations ?? []) {
    next.observations.push({
      observationId: observation.observationId,
      kind: observation.kind,
      summary: observation.summary,
      paths: [...new Set(observation.paths ?? [])].sort(),
      recordedAt: request.at,
    });
  }
  return next;
}

function transitionForPhase(runRecord, request, snapshot, contextManifestRef = null) {
  const common = { at: request.at, reason: request.reason, actorRole: "controller" };
  if (request.phase === "implementing") return transitionRun(runRecord, { ...common, to: "implementing", contextId: request.contextId });
  if (request.phase === "verifying") return transitionRun(runRecord, {
    ...common,
    to: "verifying",
    ...(runRecord.state === "repairing" ? {
      subjectRevision: snapshot.subjectRevision,
      worktreeDigest: snapshot.worktreeDigest,
      contextManifestRef,
    } : {}),
  });
  if (request.phase === "reviewing") return transitionRun(runRecord, {
    ...common,
    to: "reviewing",
    contextId: request.contextId,
    verificationResultRefs: request.verificationResultRefs,
    verificationResultDigests: request.verificationResultDigests,
  });
  if (request.phase === "repairing") return transitionRun(runRecord, {
    ...common,
    to: "repairing",
    findingFingerprints: request.findingFingerprints,
    reviewReportRef: request.reviewReportRef,
  });
  if (request.phase === "sealed") return transitionRun(runRecord, {
    ...common,
    to: "accepted",
    evidenceLevel: request.evidenceLevel,
    evidenceBundleRef: request.evidenceBundleRef,
    reviewReportRef: request.reviewReportRef,
    exclusions: request.exclusions,
  });
  throw controllerError("RUN_PHASE_INVALID", `unsupported advance phase: ${request.phase}`);
}

async function validateAcceptanceEvidence(ctx, runRecord, taskPacket, request, inspection) {
  if (typeof request.evidenceBundleRef !== "string" || request.evidenceBundleRef.length === 0) {
    throw controllerError("RUN_EVIDENCE_BUNDLE_REQUIRED", "sealed phase requires an EvidenceBundle reference");
  }
  const bundlePath = ensureWithinDirectory(
    validateRelativePath(request.evidenceBundleRef),
    inspection.baseControl.active.config.paths.evidence,
    "evidence bundle",
  );
  const bundle = await readProjectJson(ctx.projectRoot, bundlePath);
  await assertBaseSchema(ctx, runRecord.baseRevision, "evidence-bundle", "EvidenceBundle", bundle);
  await assertBaseSchema(ctx, runRecord.baseRevision, "task-packet", "TaskPacket", taskPacket);
  await assertBaseSchema(ctx, runRecord.baseRevision, "run-record", "RunRecord", runRecord);
  const expectedBindings = {
    frameworkVersion: runRecord.frameworkVersion,
    runId: runRecord.runId,
    taskId: runRecord.taskId,
    baselineId: runRecord.baselineId,
    baseRevision: runRecord.baseRevision,
    taskKind: taskPacket.taskKind,
    specDigest: runRecord.specDigest,
    taskPacketDigest: runRecord.taskPacketDigest,
    expectedTaskDigest: runRecord.expectedTaskDigest,
    controlDigest: runRecord.controlDigest,
    subjectContentDigest: inspection.subject.subjectContentDigest,
    subjectRevision: runRecord.subjectRevision,
    worktreeDigest: runRecord.worktreeDigest,
  };
  const mismatches = Object.entries(expectedBindings)
    .filter(([field, expected]) => bundle[field] !== expected)
    .map(([field, expected]) => ({ field, expected, actual: bundle[field] ?? null }));
  if (mismatches.length > 0) {
    throw controllerError("RUN_EVIDENCE_BINDING_MISMATCH", "EvidenceBundle is not bound to the exact current candidate", { mismatches });
  }
  if (bundle.bundleDigest !== computeEvidenceBundleDigest(bundle)) {
    throw controllerError("RUN_EVIDENCE_DIGEST_INVALID", "EvidenceBundle digest does not match its canonical content");
  }
  if (bundle.activation?.status !== "candidate"
    || bundle.activation?.baseRevision !== runRecord.baseRevision
    || bundle.activation?.subjectContentDigest !== inspection.subject.subjectContentDigest) {
    throw controllerError("RUN_EVIDENCE_ACTIVATION_INVALID", "EvidenceBundle activation binding is invalid");
  }
  if (bundle.declaredMaximumLevel !== request.evidenceLevel) {
    throw controllerError("RUN_EVIDENCE_LEVEL_MISMATCH", "accepted evidence level must equal the sealed bundle maximum");
  }
  if (typeof request.reviewReportRef !== "string" || !bundle.reviewReportRefs.includes(request.reviewReportRef)) {
    throw controllerError("RUN_REVIEW_BINDING_MISMATCH", "accepted review must be contained in the EvidenceBundle");
  }
  const canonicalVerificationBindings = (values) => [...values]
    .sort((left, right) => `${left.resultId}\u0000${left.resultDigest}`.localeCompare(`${right.resultId}\u0000${right.resultDigest}`, "en"));
  if (digestJson(canonicalVerificationBindings(bundle.verificationResultDigests))
    !== digestJson(canonicalVerificationBindings(runRecord.verificationResultDigests))) {
    throw controllerError("RUN_VERIFICATION_BINDING_MISMATCH", "EvidenceBundle verification bindings differ from the run");
  }
  if (digestJson(bundle.exclusions) !== digestJson(request.exclusions ?? [])) {
    throw controllerError("RUN_EVIDENCE_EXCLUSIONS_MISMATCH", "accepted exclusions must equal the sealed EvidenceBundle");
  }
  const expectedDecision = (request.exclusions ?? []).length > 0 ? "accepted_with_exclusions" : "pass";
  if (bundle.decision !== expectedDecision) {
    throw controllerError("RUN_EVIDENCE_DECISION_INVALID", "EvidenceBundle decision is not acceptable", {
      expected: expectedDecision,
      actual: bundle.decision,
    });
  }
  if (digestJson(bundle.subjectEntries) !== digestJson(inspection.subject.entries)
    || digestJson({ baseRevision: bundle.baseRevision, entries: bundle.subjectEntries }) !== bundle.subjectContentDigest) {
    throw controllerError("RUN_EVIDENCE_SUBJECT_INVALID", "EvidenceBundle subject entries do not describe the exact candidate content");
  }

  const contextLoaded = await loadContext(ctx, runRecord.contextManifestRef, taskPacket.taskId);
  await assertBaseSchema(ctx, runRecord.baseRevision, "context-manifest", "ContextManifest", contextLoaded.value);
  const verificationEntries = [];
  for (const evidence of bundle.verifierEvidence) {
    const loaded = await loadVerificationResult(ctx, evidence.resultRef);
    await assertBaseSchema(ctx, runRecord.baseRevision, "verification-result", "VerificationResult", loaded.value);
    verificationEntries.push({ reference: loaded.path, result: loaded.value });
  }
  const reviewEntries = [];
  for (const reference of bundle.reviewReportRefs) {
    const loaded = await loadReview(ctx, reference);
    await assertBaseSchema(ctx, runRecord.baseRevision, "review-report", "ReviewReport", loaded.value);
    reviewEntries.push({ reference: loaded.path, report: loaded.value });
  }
  const authorityDirectory = path.posix.join(
    inspection.baseControl.active.config.paths.evidence,
    "authority",
  );
  const authorityEntries = [];
  for (const reference of bundle.authorityReceiptRefs) {
    const relativePath = ensureWithinDirectory(
      validateRelativePath(reference),
      authorityDirectory,
      "authority receipt",
    );
    const receipt = await readProjectJson(ctx.projectRoot, relativePath);
    await assertBaseSchema(ctx, runRecord.baseRevision, "authority-receipt", "AuthorityReceipt", receipt);
    authorityEntries.push({ reference: relativePath, receipt });
  }
  const verifierById = new Map(
    inspection.baseControl.active.verifierRegistry.verifiers.map((entry) => [entry.verifierId, entry]),
  );
  const verifierDefinitionDigests = {};
  const verifierInputDigests = {};
  for (const { result } of verificationEntries) {
    const verifier = verifierById.get(result.verifierId);
    if (!verifier) {
      throw controllerError("RUN_EVIDENCE_VERIFIER_UNKNOWN", "base Active Control does not contain an evidence verifier", {
        verifierId: result.verifierId,
      });
    }
    verifierDefinitionDigests[result.verifierId] = digestJson(verifier);
    verifierInputDigests[result.verifierId] = (await digestDeclaredInputs({
      projectRoot: inspection.identity.path,
      verifier,
      excludedPaths: frameworkProcessArtifactPrefixes(inspection.baseControl.active.config),
    })).digest;
  }
  const freshness = evaluateSealedEvidenceFreshness(bundle, {
    frameworkVersion: runRecord.frameworkVersion,
    baseline: inspection.baseControl.active.baseline,
    taskPacket,
    subjectContentDigest: inspection.subject.subjectContentDigest,
    contextManifest: contextLoaded.value,
    verificationResults: verificationEntries,
    reviewReports: reviewEntries,
    authorityReceipts: authorityEntries,
    verifierDefinitionDigests,
    verifierInputDigests,
  });
  if (!freshness.fresh) {
    throw controllerError("RUN_EVIDENCE_STALE", "EvidenceBundle is not fresh for the exact current candidate", {
      errors: freshness.reasons,
    });
  }
  const adjudication = adjudicateWorkflowCycle({
    runRecord,
    taskPacket,
    baseline: inspection.baseControl.active.baseline,
    projectConfig: inspection.baseControl.active.config,
    verificationResults: verificationEntries,
    reviewReports: reviewEntries.map((entry) => entry.report),
    authorityReceipts: authorityEntries,
    changedPaths: inspection.scope.changedPaths,
    requestedChangePaths: inspection.scope.changedPaths,
    judgePaths: inspection.baseControl.active.config.automationPolicy.controlPaths,
  });
  if (adjudication.decision !== "accept" || adjudication.evidenceLevel !== bundle.declaredMaximumLevel) {
    throw controllerError("RUN_EVIDENCE_NOT_ACCEPTABLE", "base Active Control does not accept the sealed evidence", {
      adjudication,
    });
  }
  const impact = validateActualImpact(taskPacket, inspection.baseControl.active, inspection.scope.changedPaths);
  const expectedActualImpact = impact
    ? {
      changedPaths: impact.changedPaths,
      matchedImpactRuleIds: impact.matchedRuleIds,
      requirementIds: [...new Set([...impact.impactedRequirementIds, ...impact.globalInvariantIds])].sort(),
      acceptanceIds: impact.acceptanceIds,
      verifierIds: impact.verifierIds,
    }
    : {
      changedPaths: [],
      matchedImpactRuleIds: [],
      requirementIds: [...new Set(taskPacket.requirementIds ?? [])].sort(),
      acceptanceIds: [...new Set(taskPacket.acceptanceIds ?? [])].sort(),
      verifierIds: [...new Set(taskPacket.verification?.verifierIds ?? [])].sort(),
    };
  if (digestJson(bundle.actualImpact) !== digestJson(expectedActualImpact)) {
    throw controllerError("RUN_EVIDENCE_IMPACT_MISMATCH", "EvidenceBundle actual impact differs from base Active Control analysis", {
      expected: expectedActualImpact,
      actual: bundle.actualImpact,
    });
  }
  return { bundleDigest: bundle.bundleDigest, bundlePath };
}

export async function advanceRun({ project, runId, expectedRunDigest, request }) {
  assertRunId(runId);
  if (!DIGEST.test(expectedRunDigest ?? "")) throw controllerError("RUN_DIGEST_INVALID", "expectedRunDigest must be a SHA-256 digest");
  assertAdvanceRequest(request);
  assertUtc(request.at);
  const ctx = await loadHealthyProject(project);
  await ensureWriterOwnership(ctx.projectRoot, ctx.config, runId);
  return withOperationLock(ctx.projectRoot, ctx.config, runId, async () => {
    const loaded = await loadRunFile(ctx, runId);
    const actualRunDigest = digestJson(loaded.value);
    if (actualRunDigest !== expectedRunDigest) throw controllerError("RUN_COMPARE_AND_SWAP_MISMATCH", "run changed since it was inspected", { expected: expectedRunDigest, actual: actualRunDigest });
    const inspection = await inspectBoundRun(ctx, loaded.value);
    inspection.errors.push(...preparedCheckpointErrors(loaded.value));
    if (inspection.errors.length > 0) throw controllerError("RUN_BINDING_STALE", "run bindings are stale; worktree was preserved", { errors: inspection.errors });
    const scope = inspection.scope;
    validateActualImpact(inspection.taskPacket, inspection.baseControl.active, scope.changedPaths);
    const snapshot = await computeWorktreeSnapshot(inspection.identity.path, inspection.identity.headRevision, {
      excludedPrefixes: frameworkProcessArtifactPrefixes(inspection.baseControl.active.config),
    });
    const externalEffects = [...new Set(request.externalEffects ?? [])].sort();
    await revalidateRunAuthorization(
      ctx,
      loaded.value,
      inspection.taskPacket,
      request.at,
      scope.changedPaths,
      externalEffects,
    );
    const contentChanged = loaded.value.subjectContentDigest !== inspection.subject.subjectContentDigest;
    const contentRefreshAllowed = (
      loaded.value.state === "ready" && request.phase === "implementing"
    ) || (
      ["implementing", "repairing"].includes(loaded.value.state) && request.phase === "verifying"
    );
    if (contentChanged && !contentRefreshAllowed) {
      throw controllerError(
        request.phase === "sealed" ? "RUN_EVIDENCE_CONTENT_STALE" : "RUN_PHASE_CONTENT_STALE",
        "candidate content changed outside an implementation-to-verification boundary",
      );
    }
    const refreshedContext = contentChanged && request.phase !== "sealed"
      ? await materializeRunContext({
        ctx,
        taskPacket: inspection.taskPacket,
        baseControl: inspection.baseControl,
        subjectRevision: snapshot.subjectRevision,
        subjectContentDigest: inspection.subject.subjectContentDigest,
        at: request.at,
        runId,
      })
      : null;
    let next = transitionForPhase(
      loaded.value,
      request,
      snapshot,
      refreshedContext?.contextManifestRef ?? loaded.value.contextManifestRef,
    );
    if (contentChanged) {
      next.subjectRevision = snapshot.subjectRevision;
      next.worktreeDigest = snapshot.worktreeDigest;
      next.contextManifestRef = refreshedContext.contextManifestRef;
      next.briefRefs = refreshedContext.briefRefs;
    }
    next.subjectContentDigest = inspection.subject.subjectContentDigest;
    next = applyCapabilities(next, request);
    next = appendObservations(next, request);
    next.checkpoints.push(checkpoint(next, request.phase, request.at, inspection.identity, inspection.subject.subjectContentDigest));
    if (request.phase === "sealed") {
      const finalInspection = await inspectBoundRun(ctx, loaded.value);
      finalInspection.errors.push(...checkpointErrors(loaded.value, finalInspection));
      if (finalInspection.errors.length > 0
        || finalInspection.subject.subjectContentDigest !== inspection.subject.subjectContentDigest
        || digestJson(finalInspection.scope.changedPaths) !== digestJson(inspection.scope.changedPaths)) {
        throw controllerError("RUN_ACCEPTANCE_RACE", "candidate bindings changed during acceptance validation", {
          errors: finalInspection.errors,
        });
      }
      const acceptedEvidence = await validateAcceptanceEvidence(
        ctx,
        loaded.value,
        finalInspection.taskPacket,
        request,
        finalInspection,
      );
      const finalSubject = await computeSubjectContentSnapshot(
        finalInspection.identity.path,
        loaded.value.baseRevision,
        { excludedPrefixes: frameworkProcessArtifactPrefixes(finalInspection.baseControl.active.config) },
      );
      const finalBundle = await readProjectJson(ctx.projectRoot, acceptedEvidence.bundlePath);
      if (finalSubject.subjectContentDigest !== finalInspection.subject.subjectContentDigest
        || finalBundle.bundleDigest !== acceptedEvidence.bundleDigest
        || computeEvidenceBundleDigest(finalBundle) !== acceptedEvidence.bundleDigest) {
        throw controllerError("RUN_ACCEPTANCE_RACE", "candidate content or EvidenceBundle changed before acceptance was recorded");
      }
    }
    await assertProjectSchema(ctx.projectRoot, "run-record", "run record", next);
    await atomicReplaceJson(loaded.absolutePath, next);
    if (next.state === "accepted") await releaseWriterLock(ctx.projectRoot, ctx.config, runId);
    return {
      status: "pass",
      runDigest: digestJson(next),
      runRecord: next,
      envelope: executionEnvelope(next, inspection.taskPacket, inspection.identity),
    };
  });
}

export async function abandonRun({ project, runId, expectedRunDigest, at, reason }) {
  assertRunId(runId);
  if (!DIGEST.test(expectedRunDigest ?? "")) throw controllerError("RUN_DIGEST_INVALID", "expectedRunDigest must be a SHA-256 digest");
  assertUtc(at);
  if (typeof reason !== "string" || !reason.trim()) throw controllerError("RUN_ABANDON_REASON_INVALID", "abandon requires a non-empty reason");
  const ctx = await loadHealthyProject(project);
  await ensureWriterOwnership(ctx.projectRoot, ctx.config, runId);
  return withOperationLock(ctx.projectRoot, ctx.config, runId, async () => {
    const loaded = await loadRunFile(ctx, runId);
    const actual = digestJson(loaded.value);
    if (actual !== expectedRunDigest) throw controllerError("RUN_COMPARE_AND_SWAP_MISMATCH", "run changed since it was inspected", { expected: expectedRunDigest, actual });
    let next = transitionRun(loaded.value, { to: "escalated", at, reason, actorRole: "controller" });
    const latest = loaded.value.checkpoints.at(-1);
    next.checkpoints.push(checkpoint(
      next,
      "abandoned",
      at,
      { worktreeIdentityDigest: loaded.value.worktreeIdentityDigest },
      latest?.subjectContentDigest ?? loaded.value.subjectContentDigest,
    ));
    await assertProjectSchema(ctx.projectRoot, "run-record", "run record", next);
    await atomicReplaceJson(loaded.absolutePath, next);
    await releaseWriterLock(ctx.projectRoot, ctx.config, runId);
    return { status: "pass", runRecord: next, worktreePreservedAt: loaded.value.workspace.identifier, runDigest: digestJson(next) };
  });
}
