import { EVIDENCE_LEVELS, digestJson } from "../core/index.mjs";
import { workflowError } from "./errors.mjs";

export const WORKFLOW_STATES = Object.freeze([
  "draft",
  "blocked",
  "ready",
  "implementing",
  "verifying",
  "reviewing",
  "repairing",
  "accepted",
  "escalated"
]);

const TERMINAL_STATES = new Set(["accepted", "escalated"]);
const ACTOR_ROLES = new Set(["controller", "implementer", "reviewer", "repairer", "human"]);
const TRANSITIONS = Object.freeze({
  draft: new Set(["blocked", "ready"]),
  blocked: new Set(["ready", "escalated"]),
  ready: new Set(["blocked", "implementing", "escalated"]),
  implementing: new Set(["verifying", "escalated"]),
  verifying: new Set(["reviewing", "repairing", "escalated"]),
  reviewing: new Set(["accepted", "repairing", "escalated"]),
  repairing: new Set(["verifying", "escalated"]),
  accepted: new Set(),
  escalated: new Set()
});

const TRANSITION_ROLES = new Map([
  ["draft->blocked", new Set(["controller"])],
  ["draft->ready", new Set(["controller"])],
  ["blocked->ready", new Set(["controller", "human"])],
  ["blocked->escalated", new Set(["controller"])],
  ["ready->blocked", new Set(["controller"])],
  ["ready->implementing", new Set(["controller", "implementer"])],
  ["ready->escalated", new Set(["controller"])],
  ["implementing->verifying", new Set(["controller", "implementer"])],
  ["implementing->escalated", new Set(["controller"])],
  ["verifying->reviewing", new Set(["controller"])],
  ["verifying->repairing", new Set(["controller"])],
  ["verifying->escalated", new Set(["controller"])],
  ["reviewing->accepted", new Set(["controller"])],
  ["reviewing->repairing", new Set(["controller"])],
  ["reviewing->escalated", new Set(["controller"])],
  ["repairing->verifying", new Set(["controller", "repairer"])],
  ["repairing->escalated", new Set(["controller"])]
]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) workflowError("workflow_input_invalid", `${name} must be a non-empty string`);
  return value.trim();
}

function timestamp(value, name) {
  const normalized = requiredString(value, name);
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis) || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(normalized)) {
    workflowError("workflow_time_invalid", `${name} must be an ISO-8601 timestamp with an explicit timezone`);
  }
  return { value: normalized, millis };
}

function unique(values) {
  return [...new Set(values)];
}

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function allowedNextStates(state) {
  if (!WORKFLOW_STATES.includes(state)) workflowError("workflow_state_unknown", `Unknown workflow state: ${state}`);
  return [...TRANSITIONS[state]];
}

export function createRunRecord({
  frameworkVersion,
  runId,
  taskPacket,
  taskPacketRef,
  subjectRevision,
  worktreeDigest,
  subjectContentDigest,
  controlDigest,
  startedAt,
  contextManifestRef,
  workspace,
  worktreeIdentityDigest,
  briefRefs,
}) {
  if (!taskPacket || typeof taskPacket !== "object") workflowError("workflow_task_missing", "taskPacket is required");
  if (taskPacket.schemaVersion !== 2) workflowError("workflow_task_schema_invalid", "taskPacket must satisfy the current schemaVersion 2 contract");
  if (controlDigest !== taskPacket.controlDigest) {
    workflowError("workflow_control_digest_mismatch", "controlDigest must exactly match the TaskPacket Active Control binding");
  }
  if (!workspace || workspace.kind !== "worktree") {
    workflowError("workflow_workspace_invalid", "workspace must identify the controller-owned isolated worktree");
  }
  if (!briefRefs || typeof briefRefs !== "object" || Array.isArray(briefRefs)) {
    workflowError("workflow_briefs_missing", "agent and human brief references are required");
  }
  const start = timestamp(startedAt, "startedAt");
  const taskPacketDigest = digestJson(taskPacket);
  const boundControlDigest = requiredString(controlDigest, "controlDigest");
  const boundSubjectContentDigest = requiredString(subjectContentDigest, "subjectContentDigest");
  const boundWorktreeIdentityDigest = requiredString(worktreeIdentityDigest, "worktreeIdentityDigest");
  const record = {
    schemaVersion: 2,
    frameworkVersion: requiredString(frameworkVersion, "frameworkVersion"),
    runId: requiredString(runId, "runId"),
    taskId: requiredString(taskPacket.taskId, "taskPacket.taskId"),
    baselineId: requiredString(taskPacket.baselineId, "taskPacket.baselineId"),
    specDigest: requiredString(taskPacket.specDigest, "taskPacket.specDigest"),
    expectedTaskDigest: taskPacketDigest,
    taskPacketDigest,
    baseRevision: requiredString(taskPacket.baseRevision, "taskPacket.baseRevision"),
    controlDigest: boundControlDigest,
    subjectContentDigest: boundSubjectContentDigest,
    subjectRevision: requiredString(subjectRevision, "subjectRevision"),
    worktreeDigest: requiredString(worktreeDigest, "worktreeDigest"),
    state: "draft",
    startedAt: start.value,
    updatedAt: start.value,
    implementerContextId: null,
    reviewerContextIds: [],
    contextManifestRef: requiredString(contextManifestRef, "contextManifestRef"),
    verificationResultRefs: [],
    verificationResultDigests: [],
    reviewReportRefs: [],
    repairHistory: [],
    stateTransitions: [],
    humanInterventions: [],
    capabilities: {
      admitted: [...new Set((taskPacket.capabilities ?? []).map((entry) => entry.capabilityId).filter(Boolean))].sort(),
      resolved: [],
      used: [],
    },
    observations: [],
    checkpoints: [{
      checkpointId: `CP:${requiredString(runId, "runId")}:0001`,
      phase: "prepared",
      at: start.value,
      taskPacketDigest,
      controlDigest: boundControlDigest,
      subjectContentDigest: boundSubjectContentDigest,
      worktreeIdentityDigest: boundWorktreeIdentityDigest,
    }],
    authorizationConsumptions: [],
    workspace: {
      kind: "worktree",
      identifier: requiredString(workspace.identifier, "workspace.identifier"),
    },
    taskPacketRef: requiredString(taskPacketRef, "taskPacketRef"),
    worktreeIdentityDigest: boundWorktreeIdentityDigest,
    briefRefs: {
      agent: requiredString(briefRefs.agent, "briefRefs.agent"),
      human: requiredString(briefRefs.human, "briefRefs.human"),
    },
    result: { decision: "in_progress", evidenceBundleRef: null, summary: "" }
  };
  return record;
}

export function transitionRun(runRecord, transition) {
  if (!runRecord || typeof runRecord !== "object") workflowError("workflow_run_invalid", "runRecord is required");
  const from = runRecord.state;
  const to = transition?.to;
  if (!WORKFLOW_STATES.includes(from) || !WORKFLOW_STATES.includes(to)) {
    workflowError("workflow_state_unknown", "Transition contains an unknown state", { from, to });
  }
  if (!TRANSITIONS[from].has(to)) {
    workflowError("workflow_transition_invalid", `Transition ${from} -> ${to} is not allowed`, {
      from,
      to,
      allowed: [...TRANSITIONS[from]]
    });
  }
  const actorRole = transition.actorRole;
  if (!ACTOR_ROLES.has(actorRole) || !TRANSITION_ROLES.get(`${from}->${to}`)?.has(actorRole)) {
    workflowError("workflow_actor_forbidden", `Role ${actorRole} cannot perform transition ${from} -> ${to}`);
  }
  const at = timestamp(transition.at, "transition.at");
  const previous = timestamp(runRecord.updatedAt, "runRecord.updatedAt");
  if (at.millis < previous.millis) workflowError("workflow_time_reversed", "Transition time cannot move backwards");
  const reason = requiredString(transition.reason, "transition.reason");

  const next = structuredClone(runRecord);
  next.state = to;
  next.updatedAt = at.value;
  next.stateTransitions.push({ from, to, at: at.value, reason, actorRole });

  if (to === "implementing") {
    const contextId = transition.contextId ?? next.implementerContextId;
    next.implementerContextId = requiredString(contextId, "transition.contextId");
  }
  if (to === "reviewing") {
    const reviewerContextId = requiredString(transition.contextId, "transition.contextId");
    if (reviewerContextId === next.implementerContextId || next.reviewerContextIds.includes(reviewerContextId)) {
      workflowError("workflow_review_context_not_fresh", "Reviewer context must be fresh and different from the implementer context", {
        reviewerContextId
      });
    }
    const refs = unique(transition.verificationResultRefs ?? next.verificationResultRefs);
    const digests = transition.verificationResultDigests ?? next.verificationResultDigests;
    if (refs.length === 0 || digests.length === 0) workflowError("workflow_verification_evidence_missing", "Reviewing requires exact verification result references and digests");
    if (refs.length !== digests.length || new Set(digests.map((entry) => `${entry?.resultId}\u0000${entry?.resultDigest}`)).size !== digests.length) {
      workflowError("workflow_verification_binding_invalid", "Verification result references and digests must form equal unique sets");
    }
    next.verificationResultRefs = refs;
    next.verificationResultDigests = structuredClone(digests);
    next.reviewerContextIds.push(reviewerContextId);
  }
  if (to === "repairing") {
    const fingerprints = unique(transition.findingFingerprints ?? []);
    if (fingerprints.length === 0) workflowError("workflow_repair_findings_missing", "Repairing requires active finding fingerprints");
    if (transition.reviewReportRef) next.reviewReportRefs = unique([...next.reviewReportRefs, transition.reviewReportRef]);
    next.repairHistory.push({
      round: next.repairHistory.length + 1,
      findingFingerprints: fingerprints,
      subjectRevision: next.subjectRevision,
      status: "started"
    });
    next.result = { decision: "repair", evidenceBundleRef: null, summary: reason };
  }
  if (from === "repairing" && to === "verifying") {
    const newRevision = requiredString(transition.subjectRevision, "transition.subjectRevision");
    if (newRevision === next.subjectRevision) workflowError("workflow_repair_revision_unchanged", "A completed repair must produce a new subject revision");
    const latestRepair = next.repairHistory.at(-1);
    latestRepair.status = "completed";
    next.subjectRevision = newRevision;
    next.worktreeDigest = requiredString(transition.worktreeDigest, "transition.worktreeDigest");
    next.contextManifestRef = requiredString(transition.contextManifestRef, "transition.contextManifestRef");
    next.verificationResultRefs = [];
    next.verificationResultDigests = [];
    next.reviewReportRefs = [];
  }
  if (to === "accepted") {
    const evidenceLevel = transition.evidenceLevel;
    if (!EVIDENCE_LEVELS.includes(evidenceLevel)) workflowError("workflow_evidence_level_invalid", "Accepted state requires a valid evidence level");
    const evidenceBundleRef = requiredString(transition.evidenceBundleRef, "transition.evidenceBundleRef");
    if (transition.reviewReportRef) next.reviewReportRefs = unique([...next.reviewReportRefs, transition.reviewReportRef]);
    if (next.reviewReportRefs.length === 0) workflowError("workflow_review_evidence_missing", "Accepted state requires a review report reference");
    next.result = {
      decision: transition.exclusions?.length ? "accepted_with_exclusions" : "pass",
      evidenceBundleRef,
      acceptedEvidenceLevel: evidenceLevel,
      summary: reason
    };
  } else if (to === "escalated") {
    next.result = { decision: "blocked", evidenceBundleRef: null, summary: reason };
  } else if (to !== "repairing") {
    next.result = { decision: "in_progress", evidenceBundleRef: null, summary: reason };
  }
  return next;
}

export function recordHumanIntervention(runRecord, intervention) {
  const at = timestamp(intervention?.at, "intervention.at");
  const previous = timestamp(runRecord?.updatedAt, "runRecord.updatedAt");
  if (at.millis < previous.millis) workflowError("workflow_time_reversed", "Intervention time cannot move backwards");
  const gate = intervention?.gate;
  const allowedGates = new Set(["unresolved_decision", "truth_source_conflict", "scope_expansion", "judge_modification", "external_side_effect", "other"]);
  if (!allowedGates.has(gate)) workflowError("workflow_gate_unknown", `Unknown human gate: ${gate}`);
  const status = intervention?.status;
  if (!["requested", "approved", "rejected", "resolved"].includes(status)) workflowError("workflow_intervention_status_invalid", `Invalid intervention status: ${status}`);
  const next = structuredClone(runRecord);
  next.updatedAt = at.value;
  next.humanInterventions.push({
    interventionId: requiredString(intervention.interventionId, "intervention.interventionId"),
    gate,
    status,
    at: at.value,
    summary: requiredString(intervention.summary, "intervention.summary"),
    ...(intervention.actorRef ? { actorRef: requiredString(intervention.actorRef, "intervention.actorRef") } : {}),
    ...(intervention.evidenceRef ? { evidenceRef: requiredString(intervention.evidenceRef, "intervention.evidenceRef") } : {})
  });
  return next;
}
