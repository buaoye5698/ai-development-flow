import {
  analyzeImpact,
  normalizeChangedPath,
  pathMatchesPattern,
} from "./impact-analysis.mjs";
import {
  TASK_KIND_WRITE_CLASSES,
  buildAssetPolicy,
  classifyAssetPatterns,
  digestJson,
  evaluateTaskAssetWrites,
  patternsOverlap,
} from "../core/index.mjs";
import { taskError } from "./errors.mjs";

const EVIDENCE_LEVELS = Object.freeze([
  "specification",
  "contract",
  "runtime_stub",
  "target_integration",
  "owner",
  "production",
]);

const ROUTING_CAPABILITIES = Object.freeze(["tool_only", "fast", "standard", "high_reasoning", "human"]);
const TASK_KINDS = new Set(["implementation", "truth_proposal", "evidence_collection", "control_plane"]);
const STAGE_GATE_STATUSES = new Set(["pending", "blocked", "ready", "authorized", "not_authorized"]);
const EVIDENCE_COLLECTION_GATE_STATUSES = new Set(["pending", "blocked", "ready"]);
const MACHINE_EVIDENCE_LEVELS = Object.freeze(["contract", "runtime_stub", "target_integration"]);
const SIDE_EFFECT_KINDS = new Set(["filesystem", "network", "external_service", "physical", "production"]);
const FULL_GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) taskError("task_input_invalid", `${name} must be a non-empty string`);
  return value.trim();
}

function mapById(entries, key, label) {
  const result = new Map();
  for (const entry of entries ?? []) {
    const id = entry?.[key];
    if (typeof id !== "string" || !id) taskError("registry_invalid", `${label} contains an entry without ${key}`);
    if (result.has(id)) taskError("registry_duplicate_id", `${label} contains duplicate ID ${id}`, { id });
    result.set(id, entry);
  }
  return result;
}

function overlaps(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function relatedTraceability(specIndex, requirementIds) {
  const selected = new Set(requirementIds);
  return (specIndex.traceability ?? []).filter((entry) => selected.has(entry.requirementId));
}

function collectDecisionClosure(initialIds, decisionById) {
  const pending = [...initialIds];
  const result = new Set();
  while (pending.length > 0) {
    const id = pending.shift();
    if (result.has(id)) continue;
    const decision = decisionById.get(id);
    if (!decision) taskError("decision_not_registered", `decision ${id} is not present in the decision register`, { id });
    result.add(id);
    pending.push(...(decision.dependencies ?? []));
  }
  return [...result].sort();
}

function triggerMatches(verifier, selection) {
  const triggers = verifier.triggers ?? {};
  return Boolean(
    triggers.alwaysRun
    || overlaps(triggers.requirementIds ?? [], selection.requirementIds)
    || overlaps(triggers.acceptanceIds ?? [], selection.acceptanceIds)
    || overlaps(triggers.riskDomains ?? [], selection.riskDomains)
    || selection.changedPaths.some((path) =>
      (triggers.pathPatterns ?? []).some((pattern) => pathMatchesPattern(path, pattern)),
    )
  );
}

function inferRoutingCapability(requested, riskLevel, sideEffects) {
  const minimum = sideEffects.some((entry) => entry.requiresApproval)
    ? "human"
    : riskLevel === "critical"
      ? "human"
      : riskLevel === "high"
        ? "high_reasoning"
        : riskLevel === "medium"
          ? "standard"
          : "fast";
  const candidate = requested ?? minimum;
  if (!ROUTING_CAPABILITIES.includes(candidate)) {
    taskError("routing_capability_invalid", `unsupported routing capability: ${candidate}`);
  }
  return ROUTING_CAPABILITIES.indexOf(candidate) < ROUTING_CAPABILITIES.indexOf(minimum) ? minimum : candidate;
}

function assertKnownIds(ids, known, code, label) {
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) taskError(code, `${label} contains unknown IDs`, { ids: unknown });
}

function normalizeTaskKind(value) {
  const taskKind = requiredString(value, "taskKind");
  if (!TASK_KINDS.has(taskKind)) taskError("task_kind_invalid", `unsupported task kind: ${taskKind}`);
  return taskKind;
}

export function snapshotStageGate(gate) {
  const stageId = requiredString(gate?.stageId, "stageGate.stageId");
  const title = requiredString(gate?.title, "stageGate.title");
  const status = requiredString(gate?.status, "stageGate.status");
  if (!STAGE_GATE_STATUSES.has(status)) {
    taskError("stage_gate_status_invalid", `unsupported stage gate status: ${status}`);
  }
  const authorizationBoundary = requiredString(gate?.authorizationBoundary, "stageGate.authorizationBoundary");
  if (!Array.isArray(gate?.evidenceRequired)
    || gate.evidenceRequired.some((entry) => typeof entry !== "string" || !entry.trim())) {
    taskError("stage_gate_invalid", "stageGate.evidenceRequired must contain non-empty strings");
  }
  const normalized = {
    stageId,
    title,
    status,
    blockingDecisionIds: uniqueSorted(gate.blockingDecisionIds ?? []),
    authorizationBoundary,
    evidenceRequired: uniqueSorted(gate.evidenceRequired.map((entry) => entry.trim())),
  };
  return { ...normalized, stageGateDigest: digestJson(normalized) };
}

function normalizeDecision(decision) {
  const normalized = {
    decisionId: requiredString(decision?.decisionId, "decision.decisionId"),
    question: requiredString(decision?.question, "decision.question"),
    status: requiredString(decision?.status, "decision.status"),
    owner: requiredString(decision?.owner, "decision.owner"),
    options: (decision?.options ?? []).map((option) => ({
      optionId: requiredString(option?.optionId, "decision.options.optionId"),
      description: requiredString(option?.description, "decision.options.description"),
      advantages: uniqueSorted(option?.advantages ?? []),
      risks: uniqueSorted(option?.risks ?? []),
    })).sort((left, right) => left.optionId.localeCompare(right.optionId, "en")),
    dependencies: uniqueSorted(decision?.dependencies ?? []),
    blockedStageIds: uniqueSorted(decision?.blockedStageIds ?? []),
    relatedRequirementIds: uniqueSorted(decision?.relatedRequirementIds ?? []),
    relatedAcceptanceIds: uniqueSorted(decision?.relatedAcceptanceIds ?? []),
    resolutionEvidence: uniqueSorted(decision?.resolutionEvidence ?? []),
    selectedOptionId: decision?.selectedOptionId ?? null,
    decidedBy: decision?.decidedBy ?? null,
    resolvedAt: decision?.resolvedAt ?? null,
    notes: decision?.notes ?? null,
  };
  return normalized;
}

export function snapshotDecisionDependency(decision) {
  const normalized = normalizeDecision(decision);
  if (normalized.status === "resolved" && normalized.resolutionEvidence.length === 0) {
    taskError(
      "resolved_decision_evidence_missing",
      `resolved decision ${normalized.decisionId} has no resolution evidence`,
      { id: normalized.decisionId },
    );
  }
  return {
    decisionId: normalized.decisionId,
    status: normalized.status,
    selectedOptionId: normalized.selectedOptionId,
    evidenceRefs: normalized.resolutionEvidence,
    decisionDigest: digestJson(normalized),
  };
}

function decisionDependency(id, decisionById) {
  return snapshotDecisionDependency(decisionById.get(id));
}

export function requiredAuthorityKindsForEvidenceLevel(level) {
  if (level === "owner") return ["owner_acceptance"];
  if (level === "production") return ["owner_acceptance", "production_release"];
  return [];
}

export function requiredMachineEvidenceLevelsForEvidenceLevel(level) {
  const requiredIndex = EVIDENCE_LEVELS.indexOf(level);
  const targetIndex = EVIDENCE_LEVELS.indexOf("target_integration");
  const maximum = Math.min(requiredIndex, targetIndex);
  return MACHINE_EVIDENCE_LEVELS.filter(
    (entry) => EVIDENCE_LEVELS.indexOf(entry) <= maximum,
  );
}

function sameStringSet(left, right) {
  const normalizedLeft = uniqueSorted(left ?? []);
  const normalizedRight = uniqueSorted(right ?? []);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

export function validateTaskAuthorizationSnapshot(taskPacket, decisionRegister) {
  const errors = [];
  const decisionById = new Map(
    (decisionRegister?.decisions ?? []).map((entry) => [entry.decisionId, entry]),
  );
  const currentStage = (decisionRegister?.stageGates ?? []).find(
    (entry) => entry.stageId === taskPacket?.stageId,
  );
  let gateDecisionIds = [];
  if (!currentStage) {
    errors.push({
      code: "STALE_STAGE_GATE",
      message: "task stage gate no longer exists in the current decision register",
      stageId: taskPacket?.stageId ?? null,
    });
  } else {
    const currentSnapshot = snapshotStageGate(currentStage);
    const embedded = taskPacket?.derivation?.stageGate;
    if (
      embedded?.stageGateDigest !== currentSnapshot.stageGateDigest
      || embedded?.stageId !== currentSnapshot.stageId
      || embedded?.status !== currentSnapshot.status
      || embedded?.authorizationBoundary !== currentSnapshot.authorizationBoundary
      || !sameStringSet(embedded?.blockingDecisionIds, currentSnapshot.blockingDecisionIds)
      || !sameStringSet(embedded?.evidenceRequired, currentSnapshot.evidenceRequired)
    ) {
      errors.push({
        code: "STALE_STAGE_GATE",
        message: "task stage gate snapshot differs from the current decision register",
        stageId: taskPacket?.stageId ?? null,
        expectedDigest: embedded?.stageGateDigest ?? null,
        actualDigest: currentSnapshot.stageGateDigest,
      });
    }
    try {
      gateDecisionIds = collectDecisionClosure(currentSnapshot.blockingDecisionIds, decisionById);
    } catch (error) {
      errors.push({
        code: "DECISION_DEPENDENCY_STALE",
        message: "current stage gate contains a missing decision dependency",
        stageId: taskPacket?.stageId ?? null,
        detail: error.message,
      });
    }
  }

  const embeddedById = new Map(
    (taskPacket?.decisionDependencies ?? []).map((entry) => [entry.decisionId, entry]),
  );
  for (const decisionId of gateDecisionIds) {
    if (!embeddedById.has(decisionId)) {
      errors.push({
        code: "DECISION_DEPENDENCY_STALE",
        message: "task does not bind a current stage-gate decision dependency",
        decisionId,
      });
    }
  }
  for (const embedded of taskPacket?.decisionDependencies ?? []) {
    const current = decisionById.get(embedded.decisionId);
    if (!current) {
      errors.push({
        code: "DECISION_DEPENDENCY_STALE",
        message: "task decision dependency no longer exists",
        decisionId: embedded.decisionId,
      });
      continue;
    }
    const currentSnapshot = snapshotDecisionDependency(current);
    if (
      embedded.decisionDigest !== currentSnapshot.decisionDigest
      || embedded.status !== currentSnapshot.status
      || embedded.selectedOptionId !== currentSnapshot.selectedOptionId
      || !sameStringSet(embedded.evidenceRefs, currentSnapshot.evidenceRefs)
    ) {
      errors.push({
        code: "DECISION_DEPENDENCY_STALE",
        message: "task decision dependency differs from the current decision register",
        decisionId: embedded.decisionId,
        expectedDigest: embedded.decisionDigest ?? null,
        actualDigest: currentSnapshot.decisionDigest,
      });
    }
  }
  return errors;
}

export function compileTask({
  taskId,
  goal,
  baseRevision,
  stageId,
  taskKind,
  changedPaths,
  directRequirementIds,
  evidenceTargetDecisionIds = [],
  requiredEvidenceLevel = "contract",
  requestedTier = "quick",
  routingCapability,
  risk = { level: "low", domains: ["general"] },
  constraints = [],
  contextHints,
  declaredCapabilities = [],
  reviewLenses = [],
  instructionBinding = { instructionChainDigest: digestJson([]), files: [] },
  specIndex,
  specIndexDigest,
  baseline,
  impactMap,
  decisionRegister,
  verifierRegistry,
  projectConfig,
  frameworkLock,
}) {
  const normalizedTaskId = requiredString(taskId, "taskId");
  const normalizedGoal = requiredString(goal, "goal");
  const normalizedBaseRevision = requiredString(baseRevision, "baseRevision");
  if (!FULL_GIT_COMMIT.test(normalizedBaseRevision)) {
    taskError("base_revision_invalid", "baseRevision must be a complete Git commit id");
  }
  const normalizedStageId = requiredString(stageId, "stageId");
  const normalizedTaskKind = normalizeTaskKind(taskKind);
  if (specIndex?.integrity?.status !== "pass") taskError("spec_integrity_failed", "task compilation requires a passing SpecIndex");
  if (decisionRegister?.baselineId !== specIndex.baselineId) {
    taskError("decision_baseline_mismatch", "decision register must use the same baseline as SpecIndex");
  }
  if (!projectConfig?.automationPolicy
    || !Array.isArray(projectConfig.automationPolicy.controlPaths)
    || !Array.isArray(projectConfig.automationPolicy.sensitivePaths)
    || !projectConfig.automationPolicy.reviewProfile) {
    taskError("project_config_invalid", "the current projectConfig control, sensitive, and review policies are required");
  }
  if (!baseline?.decisionRegister || !Array.isArray(baseline.truthSources)) {
    taskError("baseline_invalid", "the current baseline and its truth bindings are required");
  }
  const frameworkDistribution = specIndex.provenance?.frameworkDistribution ?? null;
  const provenanceBaseRevision = specIndex.provenance?.baseRevision ?? "";
  const distributionIsRevisionBound = Boolean(
    frameworkDistribution
    && FULL_GIT_COMMIT.test(provenanceBaseRevision)
    && !/^0+$/u.test(provenanceBaseRevision),
  );
  if (distributionIsRevisionBound && provenanceBaseRevision !== normalizedBaseRevision) {
    taskError("spec_index_base_mismatch", "SpecIndex provenance differs from the task base revision");
  }
  if (distributionIsRevisionBound && !frameworkLock) {
    taskError(
      "framework_lock_invalid",
      "distribution-bound task compilation requires the current framework lock",
    );
  }
  if (frameworkLock && (!Array.isArray(frameworkLock.managedFiles)
    || frameworkLock.managedFiles.some((entry) => typeof entry?.path !== "string" || !entry.path))) {
    taskError("framework_lock_invalid", "framework lock managed file paths are invalid");
  }
  if (distributionIsRevisionBound && frameworkLock.distributionDigest !== frameworkDistribution.digest) {
    taskError(
      "framework_lock_mismatch",
      "framework lock does not match the distribution bound into SpecIndex",
    );
  }
  if (!Array.isArray(directRequirementIds) || directRequirementIds.length === 0) {
    taskError("direct_requirements_missing", "at least one direct requirement is required");
  }
  if (!EVIDENCE_LEVELS.includes(requiredEvidenceLevel)) {
    taskError("evidence_level_invalid", `unsupported evidence level: ${requiredEvidenceLevel}`);
  }
  if (["truth_proposal", "control_plane"].includes(normalizedTaskKind)
    && EVIDENCE_LEVELS.indexOf(requiredEvidenceLevel) < EVIDENCE_LEVELS.indexOf("owner")) {
    taskError("owner_evidence_required", `${normalizedTaskKind} requires Owner evidence before an external target can activate it`);
  }
  if (!new Set(["quick", "deep"]).has(requestedTier)) taskError("verification_tier_invalid", "requestedTier must be quick or deep");

  const requirementById = mapById(specIndex.requirements, "id", "SpecIndex requirements");
  const acceptanceById = mapById(specIndex.acceptanceCases, "id", "SpecIndex acceptance cases");
  const specDecisionById = mapById(specIndex.decisions, "id", "SpecIndex decisions");
  const decisionById = mapById(decisionRegister.decisions, "decisionId", "decision register");
  const verifierById = mapById(verifierRegistry.verifiers, "verifierId", "verifier registry");
  const stageGateById = mapById(decisionRegister.stageGates, "stageId", "decision register stage gates");
  const stageGate = stageGateById.get(normalizedStageId);
  if (!stageGate) taskError("stage_gate_unknown", `stage gate ${normalizedStageId} is not registered`, { stageId: normalizedStageId });
  const normalizedStageGate = snapshotStageGate(stageGate);
  const gateBlockingDecisionIds = normalizedStageGate.blockingDecisionIds;
  assertKnownIds(gateBlockingDecisionIds, decisionById, "stage_gate_decision_unknown", "stageGate.blockingDecisionIds");
  const gateDecisionIds = collectDecisionClosure(gateBlockingDecisionIds, decisionById);
  const gateDecisionDependencies = gateDecisionIds.map((id) => decisionDependency(id, decisionById));

  const directIds = uniqueSorted(directRequirementIds);
  const evidenceTargets = uniqueSorted(evidenceTargetDecisionIds);
  assertKnownIds(directIds, requirementById, "unknown_direct_requirement", "directRequirementIds");
  assertKnownIds(evidenceTargets, specDecisionById, "unknown_evidence_target_decision", "evidenceTargetDecisionIds");
  assertKnownIds(evidenceTargets, decisionById, "decision_not_registered", "evidenceTargetDecisionIds");

  if (normalizedStageGate.status === "not_authorized") {
    taskError("stage_gate_not_authorized", `stage gate ${normalizedStageId} explicitly forbids execution`, {
      stageId: normalizedStageId,
    });
  }
  if (normalizedTaskKind === "evidence_collection") {
    if (!EVIDENCE_COLLECTION_GATE_STATUSES.has(normalizedStageGate.status)) {
      taskError("stage_gate_evidence_collection_forbidden", "evidence_collection requires a pending, blocked, or ready stage gate", {
        stageId: normalizedStageId,
        status: normalizedStageGate.status,
      });
    }
    if (evidenceTargets.length === 0) {
      taskError("evidence_target_required", "evidence_collection requires at least one evidenceTargetDecisionId");
    }
    const gateBlockers = new Set(gateBlockingDecisionIds);
    const unrelatedTargets = evidenceTargets.filter((id) => !gateBlockers.has(id));
    if (unrelatedTargets.length > 0) {
      taskError("evidence_target_stage_mismatch", "evidence targets must be blocking decisions of the selected stage gate", {
        stageId: normalizedStageId,
        decisionIds: unrelatedTargets,
      });
    }
  } else {
    if (normalizedStageGate.status !== "authorized") {
      taskError("stage_gate_authorization_required", `${normalizedTaskKind} requires an authorized stage gate`, {
        stageId: normalizedStageId,
        status: normalizedStageGate.status,
      });
    }
    const unresolvedGateDecisions = gateDecisionDependencies
      .filter((entry) => entry.status !== "resolved")
      .map((entry) => entry.decisionId);
    if (unresolvedGateDecisions.length > 0) {
      taskError("stage_gate_decision_unresolved", "authorized stage gate still has unresolved blocking decisions", {
        stageId: normalizedStageId,
        decisionIds: unresolvedGateDecisions,
      });
    }
  }

  const impact = analyzeImpact({
    changedPaths,
    impactMap,
    baselineId: specIndex.baselineId,
    requireAllPathsMapped: normalizedTaskKind === "implementation" || normalizedTaskKind === "evidence_collection",
  });
  assertKnownIds(impact.impactedRequirementIds, requirementById, "impact_requirement_unknown", "impact map");
  assertKnownIds(impact.globalInvariantIds, requirementById, "global_invariant_unknown", "impact map");

  const impactedIds = impact.impactedRequirementIds.filter(
    (id) => !directIds.includes(id) && !impact.globalInvariantIds.includes(id),
  );
  const requirementIds = uniqueSorted([...directIds, ...impactedIds, ...impact.globalInvariantIds]);
  const traces = relatedTraceability(specIndex, requirementIds);
  const tracedRequirementIds = new Set(traces.map((entry) => entry.requirementId));
  const missingTrace = requirementIds.filter((id) => !tracedRequirementIds.has(id));
  if (missingTrace.length > 0) taskError("task_requirement_not_traced", "selected requirements must have traceability", { ids: missingTrace });

  const acceptanceIds = uniqueSorted([
    ...impact.acceptanceIds,
    ...traces.flatMap((entry) => entry.acceptanceIds ?? []),
  ]);
  assertKnownIds(acceptanceIds, acceptanceById, "task_acceptance_unknown", "selected acceptance IDs");

  const initialDecisionIds = uniqueSorted([
    ...traces.flatMap((entry) => entry.decisionIds ?? []),
    ...evidenceTargets,
  ]);
  assertKnownIds(initialDecisionIds, specDecisionById, "task_decision_unknown", "selected decisions");
  const decisionIds = collectDecisionClosure([
    ...initialDecisionIds,
    ...(normalizedTaskKind === "evidence_collection" ? [] : gateDecisionIds),
  ], decisionById);
  const exemptEvidenceTargets = normalizedTaskKind === "evidence_collection"
    ? new Set(evidenceTargets)
    : new Set();
  const dependencyIds = decisionIds.filter((id) => !exemptEvidenceTargets.has(id));
  const decisionDependencies = dependencyIds.map((id) => decisionDependency(id, decisionById));
  const blockingDecisionIds = decisionDependencies
    .filter((entry) => entry.status !== "resolved")
    .map((entry) => entry.decisionId);

  const riskLevel = risk?.level ?? "low";
  const riskDomains = uniqueSorted(risk?.domains ?? ["general"]);
  if (!new Set(["low", "medium", "high", "critical"]).has(riskLevel) || riskDomains.length === 0) {
    taskError("risk_invalid", "risk requires a supported level and at least one domain");
  }
  const declaredSideEffects = risk?.sideEffects ?? [];
  if (!Array.isArray(declaredSideEffects)) {
    taskError("risk_side_effect_invalid", "risk.sideEffects must be an array");
  }
  for (const entry of declaredSideEffects) {
    const keys = entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.keys(entry)
      : [];
    if (
      keys.length !== 2
      || !keys.includes("kind")
      || !keys.includes("requiresApproval")
      || !SIDE_EFFECT_KINDS.has(entry.kind)
      || typeof entry.requiresApproval !== "boolean"
    ) {
      taskError(
        "risk_side_effect_invalid",
        "each risk.sideEffects entry must contain only a supported kind and boolean requiresApproval",
      );
    }
  }

  const selectedVerifierIds = new Set([
    ...(impact.verifierIds ?? []),
    ...(verifierRegistry.globalInvariantVerifierIds ?? []),
  ]);
  const selection = { requirementIds, acceptanceIds, changedPaths: impact.changedPaths, riskDomains };
  for (const verifier of verifierRegistry.verifiers ?? []) {
    if (triggerMatches(verifier, selection)) selectedVerifierIds.add(verifier.verifierId);
  }
  const verifierIds = [...selectedVerifierIds].sort();
  if (verifierIds.length === 0) taskError("verifier_selection_empty", "task compilation selected no verifier");
  assertKnownIds(verifierIds, verifierById, "verifier_not_registered", "selected verifier IDs");
  const verifiers = verifierIds.map((id) => verifierById.get(id));
  const nonDeterministic = verifiers.filter((entry) => entry.deterministic !== true).map((entry) => entry.verifierId);
  if (nonDeterministic.length > 0) {
    taskError("non_deterministic_verifier_selected", "task verification must use deterministic verifiers", { ids: nonDeterministic });
  }
  const requiredMachineLevels = requiredMachineEvidenceLevelsForEvidenceLevel(requiredEvidenceLevel);
  const missingMachineLevels = requiredMachineLevels.filter(
    (level) => !verifiers.some((entry) => entry.evidenceLevel === level),
  );
  if (missingMachineLevels.length > 0) {
    taskError("EVIDENCE_CHAIN_UNREACHABLE", "selected verifiers cannot produce the continuous machine evidence chain", {
      requiredEvidenceLevel,
      missingEvidenceLevels: missingMachineLevels,
    });
  }
  const requiredAuthorityKinds = requiredAuthorityKindsForEvidenceLevel(requiredEvidenceLevel);

  const sideEffectByKind = new Map();
  for (const sideEffect of declaredSideEffects) {
    const existing = sideEffectByKind.get(sideEffect.kind);
    sideEffectByKind.set(sideEffect.kind, {
      kind: sideEffect.kind,
      requiresApproval: Boolean(existing?.requiresApproval || sideEffect.requiresApproval),
    });
  }
  for (const verifier of verifiers) {
    const sideEffect = verifier.sideEffect ?? { kind: "none", requiresApproval: false };
    if (sideEffect.kind === "none") continue;
    const existing = sideEffectByKind.get(sideEffect.kind);
    const requiresApproval = Boolean(existing?.requiresApproval || sideEffect.requiresApproval);
    sideEffectByKind.set(sideEffect.kind, {
      kind: sideEffect.kind,
      requiresApproval,
    });
  }
  const sideEffects = [...sideEffectByKind.values()].sort((left, right) => left.kind.localeCompare(right.kind));

  const effectiveConfig = projectConfig;
  const effectiveBaseline = baseline;
  const assetPolicy = buildAssetPolicy({ config: effectiveConfig, baseline: effectiveBaseline, impactMap });
  const sensitiveVerifierInputs = verifiers.flatMap((verifier) =>
    (verifier.inputPatterns ?? [])
      .filter((inputPattern) => assetPolicy.patterns.sensitive.some(
        (sensitivePattern) => patternsOverlap(inputPattern, sensitivePattern),
      ))
      .map((inputPattern) => ({ verifierId: verifier.verifierId, inputPattern })));
  if (sensitiveVerifierInputs.length > 0) {
    taskError(
      "sensitive_verifier_input_forbidden",
      "verifier inputs cannot overlap sensitive paths; use a non-sensitive reference or redacted fixture",
      { inputs: sensitiveVerifierInputs },
    );
  }
  const subjectPaths = impact.changedPaths.map(normalizeChangedPath);
  const plannedWritePaths = normalizedTaskKind === "evidence_collection" ? [] : subjectPaths;
  const managedPaths = (frameworkLock?.managedFiles ?? [])
    .map((entry) => normalizeChangedPath(entry.path));
  const managedWrites = plannedWritePaths.filter((plannedPath) =>
    managedPaths.some((managedPath) => patternsOverlap(plannedPath, managedPath)));
  if (managedWrites.length > 0 && normalizedTaskKind !== "control_plane") {
    taskError(
      "managed_file_requires_control_plane",
      "framework-managed files may only be changed by a control_plane task",
      { paths: managedWrites },
    );
  }
  if (
    managedWrites.length > 0
    && !plannedWritePaths.some((plannedPath) =>
      patternsOverlap(plannedPath, "ai-dev/framework-lock.json"))
  ) {
    taskError(
      "managed_lock_update_required",
      "a control_plane task that changes framework-managed files must also update ai-dev/framework-lock.json",
      { paths: managedWrites },
    );
  }
  const assetEvaluation = evaluateTaskAssetWrites({
    taskKind: normalizedTaskKind,
    paths: plannedWritePaths,
    policy: assetPolicy,
  });
  if (!assetEvaluation.ok) {
    const first = assetEvaluation.violations[0];
    taskError(first.code.toLowerCase(), first.message, { violations: assetEvaluation.violations });
  }
  const allowedWriteClasses = TASK_KIND_WRITE_CLASSES[normalizedTaskKind];
  const forbiddenPaths = uniqueSorted(Object.entries(assetPolicy.patterns)
    .filter(([assetClass]) => !allowedWriteClasses.includes(assetClass))
    .flatMap(([, patterns]) => patterns)
    .filter((pattern) => !plannedWritePaths.some((plannedPath) => pathMatchesPattern(plannedPath, pattern))));

  const truthComponents = [
    {
      componentId: "baseline",
      path: effectiveConfig.baselinePath,
      digest: digestJson(effectiveBaseline),
    },
    ...((effectiveBaseline.truthSources ?? []).map((entry) => ({
      componentId: `truth:${entry.sourceId}`,
      path: entry.path,
      digest: entry.digest,
    }))),
    {
      componentId: "decision_register",
      path: effectiveBaseline.decisionRegister,
      digest: digestJson(decisionRegister),
    },
  ].sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
  const controlComponents = [
    { componentId: "project_config", path: "ai-flow.config.json", digest: digestJson(effectiveConfig) },
    { componentId: "impact_map", path: "ai-dev/impact-map.json", digest: digestJson(impactMap) },
    { componentId: "verifier_registry", path: "ai-dev/verifiers/registry.json", digest: digestJson(verifierRegistry) },
    ...(specIndex.provenance?.adapter ? [{
      componentId: "spec_adapter",
      path: specIndex.provenance.adapter.module,
      digest: specIndex.provenance.adapter.moduleDigest,
    }] : []),
    ...(specIndex.provenance?.frameworkDistribution ? [{
      componentId: "framework_distribution",
      path: "ai-dev/framework-lock.json",
      digest: specIndex.provenance.frameworkDistribution.digest,
    }] : []),
    ...((instructionBinding.files ?? []).map((entry, index) => ({
      componentId: `instructions:${String(index).padStart(4, "0")}`,
      path: entry.path,
      digest: entry.contentDigest,
    }))),
  ].sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
  const truthDigest = digestJson(truthComponents);
  const controlDigest = digestJson({
    components: controlComponents,
    assetPolicyDigest: assetPolicy.assetPolicyDigest,
    instructionChainDigest: instructionBinding.instructionChainDigest,
  });
  const normalizedCapabilities = uniqueSorted([
    "repository_read",
    ...(plannedWritePaths.length > 0 ? ["repository_write"] : []),
    ...declaredCapabilities.map((entry) => typeof entry === "string" ? entry : entry?.capabilityId),
  ].filter(Boolean)).map((capabilityId) => ({ capabilityId }));
  const reviewProfile = effectiveConfig.automationPolicy.reviewProfile;
  const mandatoryLensIds = uniqueSorted(reviewProfile.mandatoryLensIds);
  const requestedLensIds = uniqueSorted([...mandatoryLensIds, ...reviewLenses]);

  const taskPacket = {
    schemaVersion: 2,
    baselineId: specIndex.baselineId,
    specDigest: specIndex.spec.digest,
    specIndexDigest: specIndexDigest ?? digestJson(specIndex),
    truthDigest,
    controlDigest,
    truthBinding: { components: truthComponents },
    controlBinding: {
      components: controlComponents,
      assetPolicyDigest: assetPolicy.assetPolicyDigest,
      instructionChainDigest: instructionBinding.instructionChainDigest,
    },
    baseRevision: normalizedBaseRevision,
    stageId: normalizedStageId,
    taskKind: normalizedTaskKind,
    taskId: normalizedTaskId,
    goal: normalizedGoal,
    requirementIds,
    acceptanceIds,
    decisionDependencies,
    constraints: uniqueSorted(constraints),
    derivation: {
      directRequirementIds: directIds,
      impactedRequirementIds: impactedIds,
      globalInvariantIds: impact.globalInvariantIds,
      blockingDecisionIds,
      evidenceTargetDecisionIds: evidenceTargets,
      matchedImpactRuleIds: impact.matchedRuleIds,
      stageGate: normalizedStageGate,
    },
    scope: { allowedPaths: plannedWritePaths, subjectPaths, forbiddenPaths },
    assets: {
      allowedWriteClasses,
      classifiedWrites: assetEvaluation.classified,
      declaredScope: classifyAssetPatterns(subjectPaths, assetPolicy),
    },
    review: {
      profileId: reviewProfile.profileId,
      mandatoryLensIds,
      requestedLensIds,
    },
    capabilities: normalizedCapabilities,
    verification: {
      verifierIds,
      tier: requestedTier === "deep" || verifiers.some((entry) => entry.tier === "deep") ? "deep" : "quick",
      requiredEvidenceLevel,
      requiredAuthorityKinds,
    },
    risk: { level: riskLevel, domains: riskDomains, sideEffects },
    routing: {
      capability: inferRoutingCapability(routingCapability, riskLevel, sideEffects),
    },
    repairPolicy: {
      maxRounds: projectConfig.automationPolicy.maxRepairRounds,
      allowedPathsOnly: true,
      allowedWriteClasses,
    },
    ...(contextHints ? { contextHints } : {}),
  };

  return {
    schemaVersion: 2,
    status: blockingDecisionIds.length > 0 ? "blocked" : "ready",
    blockingDecisionIds,
    evidenceTargetDecisionIds: evidenceTargets,
    impact,
    taskPacket,
  };
}
