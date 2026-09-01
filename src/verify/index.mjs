import path from "node:path";

import { digestJson } from "../core/canonical.mjs";
import { pathMatchesPattern } from "../core/path-policy.mjs";
import { inspectProject } from "../cli/project-state.mjs";
import { assertDirectoryIsNotSymlink } from "../cli/path-safety.mjs";
import { executeVerificationPlan } from "./executor.mjs";
import {
  changedPathsSince,
  computeSubjectContentSnapshot,
  computeWorktreeSnapshot,
  frameworkProcessArtifactPrefixes,
  inspectGitRepository,
  inspectTaskScope,
} from "./git-scope.mjs";
import { loadVerificationPlan } from "./registry.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function blocked(code, message, details = {}) {
  return {
    schemaVersion: 1,
    status: "blocked",
    complete: false,
    code,
    message,
    errors: details.errors ?? [],
    ...Object.fromEntries(Object.entries(details).filter(([key]) => key !== "errors")),
    results: [],
  };
}

function projectVerificationDigest(plan) {
  return digestJson({
    kind: "project-verification",
    projectId: plan.config.projectId,
    baselineId: plan.baseline.baselineId,
    specDigest: plan.specDigest,
  });
}

function uncoveredChanges(changedPaths, selected) {
  return changedPaths.filter((changedPath) =>
    !selected.some((verifier) =>
      verifier.inputPatterns.some((pattern) => pathMatchesPattern(changedPath, pattern))));
}

export async function verifyProject({
  project,
  tier,
  task = null,
  taskPacket = null,
  expectedTaskDigest = null,
}) {
  const projectRoot = path.resolve(project);
  try {
    await assertDirectoryIsNotSymlink(projectRoot);
  } catch (error) {
    return blocked("PROJECT_INVALID", "verification target must be a real directory", {
      errors: [{ code: "PROJECT_INVALID", message: error.message }],
    });
  }

  const git = await inspectGitRepository(projectRoot);
  if (!git.ok) {
    return blocked("GIT_SCOPE_UNAVAILABLE", "Git evidence is required before verification", {
      errors: git.errors,
    });
  }

  const plan = await loadVerificationPlan({
    projectRoot,
    taskArgument: task,
    taskPacket,
    tier,
  });
  if (!plan.ok) {
    return blocked("VERIFICATION_PLAN_INVALID", "verification plan is blocked", {
      errors: plan.errors,
    });
  }
  const doctor = plan.task ? { status: "pass", warnings: [] } : await inspectProject(projectRoot);
  if (doctor.status !== "pass") {
    return blocked("PROJECT_HEALTH_FAILED", "project doctor must pass before project-wide verification", {
      errors: doctor.errors,
      warnings: doctor.warnings,
    });
  }

  let boundTaskDigest;
  if (plan.task) {
    if (!DIGEST_PATTERN.test(expectedTaskDigest ?? "")) {
      return blocked("TASK_DIGEST_REQUIRED", "task verification requires an external expected task digest", {
        errors: [{
          code: "TASK_DIGEST_REQUIRED",
          message: "--expected-task-digest must be supplied by the controller that authorized the task",
        }],
      });
    }
    const actualTaskDigest = digestJson(plan.task);
    if (actualTaskDigest !== expectedTaskDigest) {
      return blocked("TASK_DIGEST_MISMATCH", "the current task packet differs from the controller-authorized digest", {
        errors: [{
          code: "TASK_DIGEST_MISMATCH",
          message: "task packet canonical digest does not match --expected-task-digest",
          expected: expectedTaskDigest,
          actual: actualTaskDigest,
        }],
      });
    }
    boundTaskDigest = actualTaskDigest;
  } else {
    if (expectedTaskDigest !== null) {
      return blocked("TASK_DIGEST_UNEXPECTED", "expected task digest is only valid together with --task", {
        errors: [{
          code: "TASK_DIGEST_UNEXPECTED",
          message: "project verification derives its authorization digest from the active control plane",
        }],
      });
    }
    boundTaskDigest = projectVerificationDigest(plan);
  }

  let scope = null;
  let changedPaths;
  if (plan.task) {
    scope = await inspectTaskScope({
      projectRoot,
      baseRevision: plan.task.baseRevision,
      taskPath: plan.taskPath,
      allowedPaths: plan.task.scope.allowedPaths,
      forbiddenPaths: plan.task.scope.forbiddenPaths,
      controlPaths: [],
      excludedPrefixes: frameworkProcessArtifactPrefixes(plan.config),
    });
    if (!scope.ok) {
      return blocked("TASK_SCOPE_VIOLATION", "actual Git changes are outside the task scope", {
        errors: scope.errors,
        scope,
      });
    }
    changedPaths = scope.changedPaths;
  } else {
    changedPaths = await changedPathsSince(projectRoot, git.headRevision);
  }

  const uncovered = uncoveredChanges(changedPaths, plan.selected);
  if (uncovered.length > 0) {
    return blocked("UNCOVERED_CHANGED_PATH", "one or more changed paths have no selected verifier coverage", {
      errors: uncovered.map((changedPath) => ({
        code: "UNCOVERED_CHANGED_PATH",
        message: "changed path is not matched by any selected verifier input pattern",
        path: changedPath,
      })),
      changedPaths,
      selectedVerifierIds: plan.selected.map((entry) => entry.verifierId),
    });
  }

  let snapshot;
  let subjectContent;
  try {
    snapshot = await computeWorktreeSnapshot(projectRoot, git.headRevision, {
      excludedPrefixes: frameworkProcessArtifactPrefixes(plan.config),
    });
    subjectContent = await computeSubjectContentSnapshot(
      projectRoot,
      plan.task?.baseRevision ?? git.headRevision,
      {
        excludedPaths: scope?.excludedControlPaths ?? [],
        excludedPrefixes: frameworkProcessArtifactPrefixes(plan.config),
      },
    );
  } catch (error) {
    return blocked("WORKTREE_SNAPSHOT_FAILED", "the complete Git worktree snapshot could not be established", {
      errors: [{ code: error.code ?? "WORKTREE_SNAPSHOT_FAILED", message: error.message }],
    });
  }

  try {
    const execution = await executeVerificationPlan({
      projectRoot,
      plan,
      subjectRevision: snapshot.subjectRevision,
      worktreeDigest: snapshot.worktreeDigest,
      subjectContentDigest: subjectContent.subjectContentDigest,
      controlDigest: plan.task?.controlDigest ?? digestJson({ kind: "project-control", baseline: plan.baseline, registry: plan.registry }),
      expectedTaskDigest: boundTaskDigest,
    });
    return {
      schemaVersion: 2,
      status: execution.status,
      complete: execution.complete,
      requiredTier: plan.requiredTier,
      executedTier: plan.executedTier,
      tier,
      projectRoot,
      taskPath: plan.taskPath,
      expectedTaskDigest: boundTaskDigest,
      worktreeDigest: snapshot.worktreeDigest,
      subjectContentDigest: subjectContent.subjectContentDigest,
      selectedVerifierIds: plan.selected.map((entry) => entry.verifierId),
      deferredVerifierIds: plan.deferredVerifierIds,
      git: {
        headRevision: git.headRevision,
        subjectRevision: snapshot.subjectRevision,
        worktreeDigest: snapshot.worktreeDigest,
        subjectContentDigest: subjectContent.subjectContentDigest,
        baseRevision: scope?.revision ?? git.headRevision,
        changedPaths,
        excludedControlPaths: scope?.excludedControlPaths ?? [],
      },
      warnings: doctor.warnings,
      errors: [],
      ...execution,
    };
  } catch (error) {
    const code = error.code ?? "VERIFIER_EXECUTION_FAILED";
    return blocked(code, "verification execution failed safely", {
      errors: [{
        code,
        message: error.message,
        path: error.path,
        details: error.errors ?? [],
      }],
    });
  }
}
