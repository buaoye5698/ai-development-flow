import {
  digestJson,
  normalizeRepoPath,
  pathMatchesPattern,
  patternsOverlap,
  validateScope
} from "../core/index.mjs";

function unique(values) {
  return [...new Set(values)].sort();
}

function gate(type, summary, details = {}) {
  const payload = { type, summary, details };
  return {
    gateId: `GATE:${type}:${digestJson(payload).slice("sha256:".length, "sha256:".length + 16)}`,
    type,
    summary,
    details
  };
}

function conflictAffectsTask(conflict, taskPacket, changedPaths) {
  const scopes = conflict?.blockingScopes ?? [];
  if (scopes.length === 0) return true;
  const candidates = [...(taskPacket?.scope?.allowedPaths ?? []), ...changedPaths];
  try {
    return scopes.some((scope) => candidates.some((candidate) => {
      if (candidate.endsWith?.("/**")) return patternsOverlap(scope, candidate);
      return pathMatchesPattern(candidate, scope);
    }));
  } catch {
    return true;
  }
}

export function validateContextIsolation({ runRecord, reviewReports = [], policy = {} }) {
  const errors = [];
  const implementer = runRecord?.implementerContextId;
  const seen = new Set();
  for (const report of reviewReports) {
    const reviewContextId = report?.reviewContextId;
    if (policy.implementerCannotReviewOwnTask !== false
      && (reviewContextId === implementer || reviewContextId === report?.implementerContextId)) {
      errors.push({ code: "review_self_review", reportId: report?.reportId ?? null, reviewContextId });
    }
    if (policy.freshReviewContextRequired !== false && seen.has(reviewContextId)) {
      errors.push({ code: "review_context_reused", reportId: report?.reportId ?? null, reviewContextId });
    }
    if (typeof reviewContextId === "string") seen.add(reviewContextId);
    if (implementer && report?.implementerContextId !== implementer) {
      errors.push({ code: "review_implementer_mismatch", reportId: report?.reportId ?? null });
    }
    if (runRecord?.taskId && report?.taskId !== runRecord.taskId) {
      errors.push({ code: "review_task_mismatch", reportId: report?.reportId ?? null });
    }
    if (runRecord?.subjectRevision && report?.subjectRevision !== runRecord.subjectRevision) {
      errors.push({ code: "review_revision_stale", reportId: report?.reportId ?? null });
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateHumanGates({
  taskPacket,
  baseline,
  projectConfig,
  changedPaths = [],
  requestedChangePaths = [],
  judgePaths = projectConfig?.automationPolicy?.controlPaths ?? [],
  judgeModificationRequested = false,
  executionAuthorized = false,
  verificationResults = []
}) {
  const gates = [];
  const unresolvedIds = unique([
    ...(taskPacket?.derivation?.blockingDecisionIds ?? []),
    ...(taskPacket?.decisionDependencies ?? [])
      .filter((entry) => entry.status !== "resolved" || (entry.evidenceRefs ?? []).length === 0)
      .map((entry) => entry.decisionId)
  ]);
  if (unresolvedIds.length > 0) {
    gates.push(gate("unresolved_decision", "Task depends on unresolved product decisions", { decisionIds: unresolvedIds }));
  }

  const activeConflicts = (baseline?.knownConflicts ?? [])
    .filter((entry) => entry.status !== "resolved" && conflictAffectsTask(entry, taskPacket, changedPaths));
  if (activeConflicts.length > 0) {
    gates.push(gate("truth_source_conflict", "An active truth-source conflict affects the task", {
      conflictIds: activeConflicts.map((entry) => entry.conflictId).filter(Boolean).sort()
    }));
  }

  if (changedPaths.length > 0) {
    const scope = validateScope({
      allowedPaths: taskPacket?.scope?.allowedPaths,
      forbiddenPaths: taskPacket?.scope?.forbiddenPaths,
      controlPaths: [],
      changedPaths
    });
    const scopeErrors = scope.errors;
    if (scopeErrors.length > 0) {
      gates.push(gate("scope_expansion", "Observed changes exceed the authorized task scope", { errors: scopeErrors }));
    }
  }

  const normalizedRequested = [];
  for (const value of requestedChangePaths) {
    try { normalizedRequested.push(normalizeRepoPath(value)); } catch { normalizedRequested.push(String(value)); }
  }
  let touchesJudge = judgeModificationRequested === true;
  if (!touchesJudge) {
    try {
      touchesJudge = normalizedRequested.some((path) => judgePaths.some((pattern) => pathMatchesPattern(path, pattern)));
    } catch {
      touchesJudge = true;
    }
  }
  if (touchesJudge && !(taskPacket?.taskKind === "control_plane" && executionAuthorized)) {
    gates.push(gate("judge_modification", "The proposed repair would modify Active Truth, Active Control, or another bound judge", {
      requestedChangePaths: normalizedRequested
    }));
  }

  const taskEffects = (taskPacket?.risk?.sideEffects ?? []).filter((entry) => entry.requiresApproval === true
    && !executionAuthorized);
  const unauthorizedObserved = verificationResults.filter((entry) => entry?.sideEffect?.occurred === true
    && (entry.sideEffect.authorized !== true
      || typeof entry.sideEffect.authorizationRef !== "string"
      || entry.sideEffect.authorizationRef.length === 0));
  if (taskEffects.length > 0 || unauthorizedObserved.length > 0) {
    gates.push(gate("external_side_effect", "An external, physical, or production side effect requires explicit human authorization evidence", {
      requestedKinds: unique(taskEffects.map((entry) => entry.kind)),
      observedVerifierIds: unique(unauthorizedObserved.map((entry) => entry.verifierId))
    }));
  }

  return { blocked: gates.length > 0, gates };
}
