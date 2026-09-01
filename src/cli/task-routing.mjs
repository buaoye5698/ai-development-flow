const TASK_MODES = new Set(["auto", "quick", "full"]);
const QUICK_CAPABILITIES = new Set(["repository_read", "repository_write"]);

function reason(code, message, details = {}) {
  return { code, message, ...details };
}

function stringValues(entries, field) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => typeof entry === "string" ? entry : entry?.[field])
    .filter((entry) => typeof entry === "string" && entry.length > 0);
}

export function evaluateTaskMode({ requestedMode = "auto", taskPacket }) {
  if (!TASK_MODES.has(requestedMode)) {
    throw new RangeError(`unsupported task mode: ${requestedMode}`);
  }
  if (!taskPacket || typeof taskPacket !== "object" || Array.isArray(taskPacket)) {
    throw new TypeError("taskPacket is required for task-mode routing");
  }

  const reasons = [];
  if (taskPacket.taskKind !== "implementation") {
    reasons.push(reason(
      "QUICK_TASK_KIND_UNSUPPORTED",
      "quick mode only admits ordinary implementation tasks",
      { taskKind: taskPacket.taskKind ?? null },
    ));
  }

  const allowedWriteClasses = stringValues(taskPacket.assets?.allowedWriteClasses, "assetClass");
  const classifiedWriteClasses = stringValues(taskPacket.assets?.classifiedWrites, "assetClass");
  if (
    allowedWriteClasses.length !== 1
    || allowedWriteClasses[0] !== "managed_implementation"
    || classifiedWriteClasses.some((entry) => entry !== "managed_implementation")
  ) {
    reasons.push(reason(
      "QUICK_ASSET_CLASS_UNSUPPORTED",
      "quick mode only admits managed implementation writes",
      { allowedWriteClasses, classifiedWriteClasses },
    ));
  }

  if ((taskPacket.scope?.allowedPaths?.length ?? 0) === 0) {
    reasons.push(reason("QUICK_SCOPE_EMPTY", "quick mode requires an explicit non-empty write scope"));
  }

  if (taskPacket.derivation?.stageGate?.status !== "authorized") {
    reasons.push(reason(
      "QUICK_STAGE_NOT_AUTHORIZED",
      "quick mode requires an authorized stage gate",
      { status: taskPacket.derivation?.stageGate?.status ?? null },
    ));
  }

  const unresolvedDecisionIds = (taskPacket.decisionDependencies ?? [])
    .filter((entry) => entry.status !== "resolved")
    .map((entry) => entry.decisionId)
    .filter(Boolean)
    .sort();
  const blockingDecisionIds = [...new Set([
    ...(taskPacket.derivation?.blockingDecisionIds ?? []),
    ...unresolvedDecisionIds,
  ])].sort();
  if (blockingDecisionIds.length > 0) {
    reasons.push(reason(
      "QUICK_DECISION_UNRESOLVED",
      "quick mode does not admit unresolved or blocking decisions",
      { decisionIds: blockingDecisionIds },
    ));
  }

  if (taskPacket.risk?.level !== "low") {
    reasons.push(reason(
      "QUICK_RISK_UNSUPPORTED",
      "quick mode only admits low-risk work",
      { riskLevel: taskPacket.risk?.level ?? null },
    ));
  }

  const sideEffects = taskPacket.risk?.sideEffects ?? [];
  if (sideEffects.length > 0) {
    reasons.push(reason(
      "QUICK_SIDE_EFFECT_UNSUPPORTED",
      "quick mode does not admit declared or verifier side effects",
      { sideEffects },
    ));
  }

  if (taskPacket.verification?.tier !== "quick") {
    reasons.push(reason(
      "QUICK_VERIFICATION_TIER_UNSUPPORTED",
      "quick mode requires the quick verification tier",
      { tier: taskPacket.verification?.tier ?? null },
    ));
  }
  if (taskPacket.verification?.requiredEvidenceLevel !== "contract") {
    reasons.push(reason(
      "QUICK_EVIDENCE_LEVEL_UNSUPPORTED",
      "quick mode requires contract evidence",
      { requiredEvidenceLevel: taskPacket.verification?.requiredEvidenceLevel ?? null },
    ));
  }
  const authorityKinds = taskPacket.verification?.requiredAuthorityKinds ?? [];
  if (authorityKinds.length > 0) {
    reasons.push(reason(
      "QUICK_AUTHORITY_UNSUPPORTED",
      "quick mode cannot require external authority receipts",
      { authorityKinds },
    ));
  }

  const capabilityIds = stringValues(taskPacket.capabilities, "capabilityId");
  const unsupportedCapabilities = capabilityIds
    .filter((entry) => !QUICK_CAPABILITIES.has(entry))
    .sort();
  if (unsupportedCapabilities.length > 0) {
    reasons.push(reason(
      "QUICK_CAPABILITY_UNSUPPORTED",
      "quick mode only admits local repository capabilities",
      { capabilityIds: unsupportedCapabilities },
    ));
  }

  const quickEligible = reasons.length === 0;
  const selectedMode = requestedMode === "full" ? "full" : quickEligible ? "quick" : "full";
  const routingReasons = requestedMode === "full"
    ? [reason("FULL_MODE_REQUESTED", "the caller explicitly requested the full flow")]
    : reasons;
  return {
    requestedMode,
    selectedMode,
    quickEligible,
    fallbackFromQuick: requestedMode === "quick" && !quickEligible,
    reasons: routingReasons,
  };
}
