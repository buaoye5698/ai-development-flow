import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadActiveControl } from "../controller/index.mjs";
import {
  assertObjectKeys,
  guardedOperation,
  loadHealthyProject,
  operationError,
  writeJsonArtifact,
} from "./project-artifacts.mjs";
import { readRequest } from "./project-runtime.mjs";
import { normalizeRepoPath } from "./path-safety.mjs";
import { inspectGitRepository } from "../verify/git-scope.mjs";
import { prepareRunCommand } from "./controller-commands.mjs";
import { compileTaskCommand } from "./static-commands.mjs";
import { evaluateTaskMode } from "./task-routing.mjs";

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const TASK_MODES = new Set(["auto", "quick", "full"]);
const START_FIELDS = Object.freeze([
  "taskId",
  "runId",
  "at",
  "goal",
  "stageId",
  "taskKind",
  "changedPaths",
  "directRequirementIds",
  "evidenceTargetDecisionIds",
  "requiredEvidenceLevel",
  "requestedTier",
  "routingCapability",
  "risk",
  "constraints",
  "declaredCapabilities",
  "reviewLenses",
  "contextHints",
]);
const TASK_REQUEST_FIELDS = Object.freeze([
  "goal",
  "evidenceTargetDecisionIds",
  "requiredEvidenceLevel",
  "requestedTier",
  "routingCapability",
  "risk",
  "constraints",
  "declaredCapabilities",
  "reviewLenses",
  "contextHints",
]);

function generatedId(prefix) {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function portableId(value, label, fallbackPrefix) {
  const candidate = value ?? generatedId(fallbackPrefix);
  if (typeof candidate !== "string" || !PORTABLE_ID.test(candidate)) {
    operationError("START_ID_INVALID", `${label} must be a portable stable identifier`, {
      field: label,
      value: candidate ?? null,
    });
  }
  return candidate;
}

function inferStageId({ requestedStageId, taskKind, evidenceTargetDecisionIds, decisionRegister }) {
  if (requestedStageId !== undefined) return requestedStageId;
  const evidenceCollection = taskKind === "evidence_collection";
  const allowedStatuses = evidenceCollection
    ? new Set(["pending", "blocked", "ready"])
    : new Set(["authorized"]);
  const evidenceTargets = new Set(evidenceTargetDecisionIds ?? []);
  const candidates = (decisionRegister.stageGates ?? []).filter((gate) => {
    if (!allowedStatuses.has(gate.status)) return false;
    if (!evidenceCollection || evidenceTargets.size === 0) return true;
    const blockers = new Set(gate.blockingDecisionIds ?? []);
    return [...evidenceTargets].every((entry) => blockers.has(entry));
  });
  if (candidates.length !== 1) {
    operationError(
      "START_STAGE_REQUIRED",
      "start could not infer one compatible stage gate; provide stageId explicitly",
      { candidateStageIds: candidates.map((entry) => entry.stageId).sort() },
    );
  }
  return candidates[0].stageId;
}

function expandedTaskRequest({ shortRequest, taskId, baseRevision, stageId, taskKind }) {
  const request = {
    taskId,
    goal: shortRequest.goal,
    baseRevision,
    stageId,
    taskKind,
    changedPaths: shortRequest.changedPaths,
    directRequirementIds: shortRequest.directRequirementIds,
  };
  for (const field of TASK_REQUEST_FIELDS) {
    if (Object.hasOwn(shortRequest, field)) request[field] = shortRequest[field];
  }
  return request;
}

function defaultWorktreePath(projectId, runId) {
  return path.join(os.tmpdir(), "ai-flow-worktrees", `${projectId}-${runId}`);
}

export function startTaskCommand({
  project,
  input,
  mode = "auto",
  worktreePath = null,
  authorizationPath = null,
}) {
  return guardedOperation(async () => {
    if (!TASK_MODES.has(mode)) {
      operationError("START_MODE_INVALID", "start mode must be auto, quick, or full", { mode });
    }
    if (worktreePath !== null && !path.isAbsolute(worktreePath)) {
      operationError("START_WORKTREE_NOT_ABSOLUTE", "--worktree must be an absolute path", {
        path: worktreePath,
      });
    }
    const ctx = await loadHealthyProject(project);
    const shortRequest = assertObjectKeys(
      await readRequest(ctx, input),
      START_FIELDS,
      ["goal", "changedPaths", "directRequirementIds"],
    );
    const taskKind = shortRequest.taskKind ?? "implementation";
    const git = await inspectGitRepository(ctx.projectRoot);
    if (!git.ok) {
      operationError("START_GIT_REQUIRED", "start requires a Git repository with a full HEAD commit", {
        errors: git.errors,
      });
    }
    const active = await loadActiveControl(ctx.projectRoot, {
      baseRevision: git.headRevision,
      taskKind,
      scope: {
        allowedPaths: taskKind === "evidence_collection" ? [] : shortRequest.changedPaths,
      },
    });
    const stageId = inferStageId({
      requestedStageId: shortRequest.stageId,
      taskKind,
      evidenceTargetDecisionIds: shortRequest.evidenceTargetDecisionIds,
      decisionRegister: active.decisionRegister,
    });
    const taskId = portableId(shortRequest.taskId, "taskId", "TASK");
    const runId = portableId(shortRequest.runId, "runId", "RUN");
    const at = shortRequest.at ?? new Date().toISOString();
    const taskRequest = expandedTaskRequest({
      shortRequest,
      taskId,
      baseRevision: git.headRevision,
      stageId,
      taskKind,
    });
    const taskRequestPath = normalizeRepoPath(path.posix.join(
      active.config.paths.generated,
      "requests",
      `${taskId}-start.json`,
    ));
    const taskRequestArtifact = await writeJsonArtifact({
      projectRoot: ctx.projectRoot,
      relativePath: taskRequestPath,
      allowedDirectory: active.config.paths.generated,
      value: taskRequest,
    });
    const compilation = await compileTaskCommand({
      project: ctx.projectRoot,
      input: taskRequestPath,
    });
    if (compilation.status !== "pass") {
      return {
        ...compilation,
        requestedMode: mode,
        taskId,
        runId,
        taskRequestPath,
        taskRequestArtifact,
      };
    }

    const routing = evaluateTaskMode({ requestedMode: mode, taskPacket: compilation.taskPacket });
    const usesDefaultWorktree = worktreePath === null;
    const targetWorktree = worktreePath ?? defaultWorktreePath(active.config.projectId, runId);
    if (!path.isAbsolute(targetWorktree)) {
      operationError("START_WORKTREE_NOT_ABSOLUTE", "--worktree must be an absolute path", {
        path: targetWorktree,
      });
    }
    if (usesDefaultWorktree) {
      await mkdir(path.dirname(targetWorktree), { recursive: true });
    }
    const prepared = await prepareRunCommand({
      project: ctx.projectRoot,
      task: taskId,
      runId,
      worktreePath: targetWorktree,
      authorizationPath,
      at,
    });
    return {
      ...prepared,
      target: ctx.projectRoot,
      requestedMode: routing.requestedMode,
      selectedMode: routing.selectedMode,
      quickEligible: routing.quickEligible,
      fallbackFromQuick: routing.fallbackFromQuick,
      routingReasons: routing.reasons,
      taskId,
      runId,
      worktreePath: targetWorktree,
      taskRequestPath,
      taskRequestArtifact,
      taskPath: compilation.outputPath,
      taskDigest: compilation.taskDigest,
      specIndexPath: compilation.specIndexOutputPath,
    };
  });
}
