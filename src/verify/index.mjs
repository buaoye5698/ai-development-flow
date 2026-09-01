import path from "node:path";

import { buildAssetPolicy, evaluateTaskAssetWrites } from "../core/asset-policy.mjs";
import { digestJson } from "../core/canonical.mjs";
import { pathMatchesPattern } from "../core/path-policy.mjs";
import { analyzeImpact } from "../task/impact-analysis.mjs";
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

function emptyActualImpact(impactMap) {
  return {
    schemaVersion: 1,
    mapId: impactMap.mapId,
    baselineId: impactMap.baselineId,
    changedPaths: [],
    matchedRuleIds: [],
    unmatchedPaths: [],
    impactedRequirementIds: [],
    globalInvariantIds: [...new Set(impactMap.globalRequirementIds ?? [])].sort(),
    acceptanceIds: [],
    verifierIds: [...new Set(impactMap.globalVerifierIds ?? [])].sort(),
  };
}

function actualTaskImpact(plan, changedPaths) {
  return changedPaths.length === 0
    ? emptyActualImpact(plan.impactMap)
    : analyzeImpact({
      changedPaths,
      impactMap: plan.impactMap,
      baselineId: plan.task.baselineId,
      requireAllPathsMapped: plan.task.taskKind === "implementation"
        || plan.task.taskKind === "evidence_collection",
    });
}

function impactExpansions(actualImpact, task) {
  const checks = [
    ["requirements", [
      ...actualImpact.impactedRequirementIds,
      ...actualImpact.globalInvariantIds,
    ], task.requirementIds ?? []],
    ["acceptance", actualImpact.acceptanceIds, task.acceptanceIds ?? []],
    ["verifiers", actualImpact.verifierIds, task.verification?.verifierIds ?? []],
  ];
  return checks.flatMap(([field, actualValues, declaredValues]) => {
    const expanded = [...new Set(actualValues)].filter((entry) => !declaredValues.includes(entry)).sort();
    return expanded.length > 0 ? [{ field, expanded }] : [];
  });
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
  let actualAssets = null;
  let actualImpact = null;
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
    const assetPolicy = buildAssetPolicy({
      config: plan.config,
      baseline: plan.baseline,
      impactMap: plan.impactMap,
    });
    actualAssets = evaluateTaskAssetWrites({
      taskKind: plan.task.taskKind,
      paths: changedPaths,
      policy: assetPolicy,
    });
    if (!actualAssets.ok) {
      return blocked("TASK_ASSET_VIOLATION", "actual Git changes use an asset class forbidden for the task kind", {
        errors: actualAssets.violations,
        scope,
        actualAssets: actualAssets.classified,
      });
    }
    try {
      actualImpact = actualTaskImpact(plan, changedPaths);
    } catch (error) {
      return blocked("TASK_IMPACT_INVALID", "actual Git changes cannot be justified by base Active Control", {
        errors: [{
          code: error.code ?? "TASK_IMPACT_INVALID",
          message: error.message,
          ...(error.details ?? {}),
        }],
        scope,
      });
    }
    const expansions = impactExpansions(actualImpact, plan.task);
    if (expansions.length > 0) {
      return blocked("TASK_IMPACT_EXPANDED", "actual impact exceeds the TaskPacket declaration", {
        errors: expansions.map((entry) => ({
          code: "TASK_IMPACT_EXPANDED",
          message: `actual ${entry.field} impact exceeds the TaskPacket`,
          ...entry,
        })),
        scope,
        actualImpact,
      });
    }
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
      tier: plan.executedTier,
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
      ...(actualAssets ? { actualAssets: actualAssets.classified } : {}),
      ...(actualImpact ? { actualImpact } : {}),
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
