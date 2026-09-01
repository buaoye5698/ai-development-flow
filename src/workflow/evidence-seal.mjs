import {
  EVIDENCE_LEVELS,
  buildAuthorityReceiptBinding,
  compareEvidenceLevel,
  computeEvidenceBundleDigest,
  deriveEvidenceLevels,
  digestJson,
  evaluateEvidenceFreshness,
  highestClaimableEvidenceLevel,
  normalizeAuthorityReceiptEntries
} from "../core/index.mjs";
import { adjudicateWorkflowCycle } from "./adjudicator.mjs";
import { workflowError } from "./errors.mjs";
import {
  compareVerificationBindingSet,
  normalizeReferencedVerificationResults,
  verificationResultDigests,
  verificationResultRefs
} from "./verification-bindings.mjs";
import { requiredAuthorityKindsForEvidenceLevel } from "../task/index.mjs";

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) workflowError("evidence_input_invalid", `${name} must be a non-empty string`);
  return value.trim();
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    workflowError("evidence_input_invalid", `${name} must be an object`);
  }
  return value;
}

function requireSchemaVersion2(value, name, details = {}) {
  if (value?.schemaVersion !== 2) {
    workflowError("evidence_schema_version_invalid", `${name} must use schemaVersion 2`, {
      expected: 2,
      actual: value?.schemaVersion ?? null,
      ...details
    });
  }
}

function withoutDigest(value, field) {
  const clone = structuredClone(value);
  delete clone[field];
  return clone;
}

function referencedValues(entries, valueKey, label) {
  const refs = new Set();
  return (entries ?? []).map((entry, index) => {
    const reference = requiredString(entry?.reference, `${label}[${index}].reference`);
    if (refs.has(reference)) workflowError("evidence_reference_duplicate", `Duplicate ${label} reference: ${reference}`);
    refs.add(reference);
    const value = entry?.[valueKey];
    if (!value || typeof value !== "object") workflowError("evidence_input_invalid", `${label}[${index}].${valueKey} is required`);
    return { reference, value };
  });
}

function ensureBound(value, expected, code, details = {}) {
  if (value !== expected) workflowError(code, "Evidence input is not bound to the active run", { expected, actual: value, ...details });
}

function exactString(value, name) {
  const normalized = requiredString(value, name);
  if (normalized !== value) workflowError("evidence_input_invalid", `${name} must not contain surrounding whitespace`);
  return value;
}

function validateSubjectImpactBinding(subjectContent, actualImpact, taskPacket) {
  const subjectPaths = subjectContent.entries.map((entry, index) => (
    exactString(entry?.path, `subjectContent.entries[${index}].path`)
  ));
  const uniqueSubjectPaths = new Set(subjectPaths);
  if (uniqueSubjectPaths.size !== subjectPaths.length) {
    workflowError("evidence_subject_entries_duplicate", "subjectContent.entries paths must be unique");
  }
  const sortedSubjectPaths = [...subjectPaths].sort((left, right) => left.localeCompare(right, "en"));
  if (subjectPaths.some((entry, index) => entry !== sortedSubjectPaths[index])) {
    workflowError("evidence_subject_entries_unsorted", "subjectContent.entries must be sorted by path", {
      expected: sortedSubjectPaths,
      actual: subjectPaths
    });
  }

  const changedPaths = actualImpact.changedPaths.map((entry, index) => (
    exactString(entry, `actualImpact.changedPaths[${index}]`)
  ));
  const actualPathSet = new Set(changedPaths);
  const missingPaths = subjectPaths.filter((entry) => !actualPathSet.has(entry));
  const extraPaths = changedPaths.filter((entry) => !uniqueSubjectPaths.has(entry));
  if (actualPathSet.size !== changedPaths.length
    || actualPathSet.size !== uniqueSubjectPaths.size
    || missingPaths.length > 0
    || extraPaths.length > 0) {
    workflowError("evidence_actual_impact_paths_mismatch", "actualImpact.changedPaths must exactly match subjectContent.entries paths", {
      missingPaths: [...new Set(missingPaths)].sort((left, right) => left.localeCompare(right, "en")),
      extraPaths: [...new Set(extraPaths)].sort((left, right) => left.localeCompare(right, "en"))
    });
  }

  for (const [field, declaredValues] of [
    ["requirementIds", taskPacket.requirementIds ?? []],
    ["acceptanceIds", taskPacket.acceptanceIds ?? []],
    ["verifierIds", taskPacket.verification?.verifierIds ?? []]
  ]) {
    const actualValues = actualImpact[field].map((entry, index) => (
      exactString(entry, `actualImpact.${field}[${index}]`)
    ));
    const declared = new Set(Array.isArray(declaredValues) ? declaredValues : []);
    const expanded = [...new Set(actualValues)].filter((entry) => !declared.has(entry));
    if (expanded.length > 0) {
      workflowError("evidence_actual_impact_expanded", `actualImpact.${field} exceeds the TaskPacket declaration`, {
        field,
        expanded: expanded.sort((left, right) => left.localeCompare(right, "en"))
      });
    }
  }
}

function collectLevels({ baseline, verificationEntries, authorityReceipts }) {
  const evidence = new Map(EVIDENCE_LEVELS.map((level) => [level, []]));
  const canonical = (baseline.truthSources ?? []).find((entry) => entry.sourceId === baseline.canonicalSpecSourceId);
  evidence.get("specification").push(canonical?.path ?? "canonical specification");
  for (const entry of verificationEntries) {
    if (entry.result.status === "pass" && entry.result.complete === true) {
      evidence.get(entry.result.evidenceLevel).push(entry.reference);
    }
  }
  for (const receipt of authorityReceipts) {
    evidence.get(receipt.kind === "owner_acceptance" ? "owner" : "production").push(receipt.reference);
  }
  return EVIDENCE_LEVELS.map((level) => ({
    level,
    status: evidence.get(level).length > 0 ? "pass" : "not_claimed",
    references: [...new Set(evidence.get(level))].sort()
  }));
}

function compareCurrentDigests(verificationEntries, verifierDefinitionDigests, verifierInputDigests) {
  for (const { result } of verificationEntries) {
    const definitionDigest = verifierDefinitionDigests?.[result.verifierId];
    const inputDigest = verifierInputDigests?.[result.verifierId];
    if (typeof definitionDigest !== "string" || result.definitionDigest !== definitionDigest) {
      workflowError("evidence_verifier_definition_stale", `Verifier definition is missing or stale: ${result.verifierId}`, {
        verifierId: result.verifierId,
        expected: definitionDigest ?? null,
        actual: result.definitionDigest
      });
    }
    if (typeof inputDigest !== "string" || result.inputDigest !== inputDigest) {
      workflowError("evidence_verifier_input_stale", `Verifier input is missing or stale: ${result.verifierId}`, {
        verifierId: result.verifierId,
        expected: inputDigest ?? null,
        actual: result.inputDigest
      });
    }
  }
}

function ensureExactBindings(label, expectedRefs, expectedDigests, actualEntries, context = {}) {
  const comparison = compareVerificationBindingSet({
    expectedRefs,
    expectedDigests,
    actualEntries,
    ...context
  });
  if (!comparison.ok) workflowError("evidence_verification_binding_mismatch", `${label} does not bind the exact verification result set`, {
    reasons: comparison.errors
  });
}

export function sealEvidenceBundle({
  frameworkVersion,
  bundleId,
  createdAt,
  runRecord,
  taskPacket,
  baseline,
  projectConfig,
  contextManifest,
  verificationResults = [],
  reviewReports = [],
  authorityReceipts = [],
  verifierDefinitionDigests,
  verifierInputDigests,
  subjectContent,
  actualImpact,
  limitations = [],
  exclusions = []
}) {
  requireSchemaVersion2(runRecord, "runRecord");
  requireSchemaVersion2(taskPacket, "taskPacket");
  requireSchemaVersion2(contextManifest, "contextManifest");
  const boundSubjectContent = requiredObject(subjectContent, "subjectContent");
  const boundActualImpact = requiredObject(actualImpact, "actualImpact");
  if (!Array.isArray(boundSubjectContent.entries)) {
    workflowError("evidence_input_invalid", "subjectContent.entries must be an array");
  }
  for (const field of ["changedPaths", "matchedImpactRuleIds", "requirementIds", "acceptanceIds", "verifierIds"]) {
    if (!Array.isArray(boundActualImpact[field])) {
      workflowError("evidence_input_invalid", `actualImpact.${field} must be an array`);
    }
  }
  validateSubjectImpactBinding(boundSubjectContent, boundActualImpact, taskPacket);
  let normalizedAuthority;
  try {
    normalizedAuthority = normalizeAuthorityReceiptEntries(authorityReceipts, { requireReferences: true });
  } catch (error) {
    workflowError("evidence_authority_entry_invalid", error.message, {
      authorityCode: error.code ?? null,
      ...(error.details ?? {})
    });
  }
  const authorityReceiptRefs = normalizedAuthority.references;
  const receiptValues = normalizedAuthority.receipts;
  for (const receipt of receiptValues) {
    requireSchemaVersion2(receipt, "authority receipt", { receiptId: receipt?.receiptId ?? null });
  }
  if (runRecord?.state !== "reviewing") workflowError("evidence_run_state_invalid", "Evidence can only be sealed from the reviewing state");
  const version = requiredString(frameworkVersion, "frameworkVersion");
  const expectedTaskDigest = digestJson(taskPacket);
  const baselineDigest = digestJson(baseline);
  ensureBound(boundSubjectContent.baseRevision, taskPacket.baseRevision, "evidence_subject_base_stale");
  const computedSubjectContentDigest = digestJson({
    baseRevision: boundSubjectContent.baseRevision,
    entries: boundSubjectContent.entries
  });
  ensureBound(boundSubjectContent.subjectContentDigest, computedSubjectContentDigest, "evidence_subject_content_digest_invalid");
  ensureBound(boundSubjectContent.subjectContentDigest, runRecord.subjectContentDigest, "evidence_subject_content_stale");
  ensureBound(runRecord.frameworkVersion, version, "evidence_framework_mismatch");
  ensureBound(taskPacket.taskId, runRecord.taskId, "evidence_task_mismatch");
  ensureBound(taskPacket.baselineId, runRecord.baselineId, "evidence_baseline_mismatch");
  ensureBound(taskPacket.specDigest, runRecord.specDigest, "evidence_spec_mismatch");
  ensureBound(runRecord.expectedTaskDigest, expectedTaskDigest, "evidence_task_digest_mismatch");
  ensureBound(runRecord.taskPacketDigest, expectedTaskDigest, "evidence_task_packet_digest_mismatch");
  ensureBound(taskPacket.controlDigest, runRecord.controlDigest, "evidence_control_digest_mismatch");
  ensureBound(contextManifest.taskId, runRecord.taskId, "evidence_context_task_mismatch");
  ensureBound(contextManifest.baselineId, runRecord.baselineId, "evidence_context_baseline_mismatch");
  ensureBound(contextManifest.specDigest, runRecord.specDigest, "evidence_context_spec_mismatch");
  ensureBound(contextManifest.subjectRevision, runRecord.subjectRevision, "evidence_context_revision_stale");
  ensureBound(contextManifest.taskPacketDigest, expectedTaskDigest, "evidence_context_task_packet_stale");
  ensureBound(contextManifest.controlDigest, runRecord.controlDigest, "evidence_context_control_stale");
  ensureBound(contextManifest.subjectContentDigest, runRecord.subjectContentDigest, "evidence_context_content_stale");

  const actualContextDigest = digestJson(withoutDigest(contextManifest, "manifestDigest"));
  ensureBound(contextManifest.manifestDigest, actualContextDigest, "evidence_context_digest_invalid");
  const verificationEntries = normalizeReferencedVerificationResults(verificationResults);
  const reviewEntries = referencedValues(reviewReports, "report", "reviewReports");
  const results = verificationEntries.map((entry) => entry.result);
  const reports = reviewEntries.map((entry) => entry.value);
  for (const result of results) {
    requireSchemaVersion2(result, "verification result", { resultId: result?.resultId ?? null });
  }
  for (const report of reports) {
    requireSchemaVersion2(report, "review report", { reportId: report?.reportId ?? null });
  }
  ensureExactBindings(
    "Run record",
    runRecord.verificationResultRefs,
    runRecord.verificationResultDigests,
    verificationEntries
  );
  const activeReviewContextId = runRecord.reviewerContextIds?.at(-1);
  for (const report of reports) {
    ensureBound(report.taskId, runRecord.taskId, "evidence_review_task_mismatch", { reportId: report.reportId });
    ensureBound(report.baselineId, runRecord.baselineId, "evidence_review_baseline_mismatch", { reportId: report.reportId });
    ensureBound(report.specDigest, runRecord.specDigest, "evidence_review_spec_mismatch", { reportId: report.reportId });
    ensureBound(report.subjectRevision, runRecord.subjectRevision, "evidence_review_revision_stale", { reportId: report.reportId });
    ensureBound(report.taskPacketDigest, expectedTaskDigest, "evidence_review_task_packet_stale", { reportId: report.reportId });
    ensureBound(report.controlDigest, runRecord.controlDigest, "evidence_review_control_stale", { reportId: report.reportId });
    ensureBound(report.subjectContentDigest, runRecord.subjectContentDigest, "evidence_review_content_stale", { reportId: report.reportId });
    ensureBound(report.implementerContextId, runRecord.implementerContextId, "evidence_review_implementer_mismatch", { reportId: report.reportId });
    if (activeReviewContextId) {
      ensureBound(report.reviewContextId, activeReviewContextId, "evidence_review_context_stale", { reportId: report.reportId });
    }
    if (!Number.isFinite(Date.parse(report.createdAt))) {
      workflowError("evidence_review_time_invalid", `Review report timestamp is invalid: ${report.reportId}`);
    }
    ensureExactBindings(
      `Review report ${report.reportId}`,
      report.verificationResultRefs,
      report.verificationResultDigests,
      verificationEntries,
      {
        contextDigest: report.contextDigest,
        reviewContextId: report.reviewContextId,
        subjectRevision: report.subjectRevision,
        subjectContentDigest: report.subjectContentDigest,
        taskPacketDigest: report.taskPacketDigest,
        controlDigest: report.controlDigest
      }
    );
  }

  const requiredIds = taskPacket.verification?.verifierIds ?? [];
  const byVerifier = new Map();
  for (const entry of verificationEntries) {
    if (byVerifier.has(entry.result.verifierId)) workflowError("evidence_verifier_duplicate", `Duplicate verifier result: ${entry.result.verifierId}`);
    byVerifier.set(entry.result.verifierId, entry);
  }
  if (byVerifier.size !== requiredIds.length) workflowError("evidence_verifier_set_mismatch", "Verifier result set contains missing or extra entries");
  for (const verifierId of requiredIds) {
    const entry = byVerifier.get(verifierId);
    if (!entry) workflowError("evidence_verifier_missing", `Required verifier result is missing: ${verifierId}`);
    const result = entry.result;
    ensureBound(result.taskId, runRecord.taskId, "evidence_result_task_mismatch", { verifierId });
    ensureBound(result.baselineId, runRecord.baselineId, "evidence_result_baseline_mismatch", { verifierId });
    ensureBound(result.specDigest, runRecord.specDigest, "evidence_result_spec_mismatch", { verifierId });
    ensureBound(result.expectedTaskDigest, runRecord.expectedTaskDigest, "evidence_result_task_digest_mismatch", { verifierId });
    ensureBound(result.taskPacketDigest, expectedTaskDigest, "evidence_result_task_packet_mismatch", { verifierId });
    ensureBound(result.controlDigest, runRecord.controlDigest, "evidence_result_control_stale", { verifierId });
    ensureBound(result.subjectContentDigest, runRecord.subjectContentDigest, "evidence_result_content_stale", { verifierId });
    ensureBound(result.subjectRevision, runRecord.subjectRevision, "evidence_result_revision_stale", { verifierId });
    ensureBound(result.worktreeDigest, runRecord.worktreeDigest, "evidence_result_worktree_stale", { verifierId });
    if (result.status !== "pass" || result.complete !== true) {
      workflowError("evidence_verifier_not_passing", `Required verifier is not a complete pass: ${verifierId}`);
    }
    if (result.sideEffect?.occurred === true
      && (result.sideEffect.authorized !== true || !result.sideEffect.authorizationRef)) {
      workflowError("evidence_side_effect_unauthorized", `Verifier reports an unauthorized side effect: ${verifierId}`);
    }
  }
  compareCurrentDigests(verificationEntries, verifierDefinitionDigests, verifierInputDigests);

  const expectedAuthorityKinds = requiredAuthorityKindsForEvidenceLevel(
    taskPacket.verification.requiredEvidenceLevel,
  );
  const declaredAuthorityKinds = [...(taskPacket.verification.requiredAuthorityKinds ?? [])].sort();
  if (
    expectedAuthorityKinds.length !== declaredAuthorityKinds.length
    || expectedAuthorityKinds.some((entry, index) => entry !== declaredAuthorityKinds[index])
  ) {
    workflowError(
      "evidence_authority_requirements_invalid",
      "Task authority receipt requirements do not match its required evidence level",
      { expected: expectedAuthorityKinds, actual: declaredAuthorityKinds },
    );
  }
  const receivedAuthorityKinds = new Set(receiptValues.map((entry) => entry.kind));
  const missingAuthorityKinds = expectedAuthorityKinds.filter(
    (entry) => !receivedAuthorityKinds.has(entry),
  );
  if (missingAuthorityKinds.length > 0) {
    workflowError(
      "evidence_authority_required",
      "Required authority receipts are missing",
      { missingAuthorityKinds },
    );
  }

  const participantContextIds = [
    runRecord.implementerContextId,
    ...(runRecord.reviewerContextIds ?? []),
    ...reports.flatMap((report) => [report.implementerContextId, report.reviewContextId])
  ].filter(Boolean);
  const authorityBinding = buildAuthorityReceiptBinding({
    taskId: runRecord.taskId,
    baselineId: runRecord.baselineId,
    taskPacketDigest: expectedTaskDigest,
    expectedTaskDigest: runRecord.expectedTaskDigest,
    specDigest: runRecord.specDigest,
    controlDigest: runRecord.controlDigest,
    subjectContentDigest: runRecord.subjectContentDigest,
    baselineDigest,
    subjectRevision: runRecord.subjectRevision,
    worktreeDigest: runRecord.worktreeDigest,
    requiredTier: taskPacket.verification.tier
  }, {
    verificationResults: results,
    reviewReports: reports,
    participantContextIds
  });

  const adjudication = adjudicateWorkflowCycle({
    runRecord,
    taskPacket,
    baseline,
    projectConfig,
    verificationResults,
    reviewReports: reports,
    authorityReceipts: receiptValues
  });
  if (adjudication.decision !== "accept") {
    workflowError("evidence_not_acceptable", "Workflow adjudication does not permit evidence sealing", { adjudication });
  }
  const latestReview = [...reports]
    .filter((report) => report.subjectRevision === runRecord.subjectRevision)
    .sort((left, right) => left.reviewRound - right.reviewRound)
    .at(-1);
  if (!latestReview || latestReview.verdict !== "pass" || (latestReview.findings ?? []).length > 0) {
    workflowError("evidence_review_not_passing", "Latest current-revision review must pass without findings");
  }

  const derived = deriveEvidenceLevels({
    verificationResults: results,
    authorityReceipts: receiptValues,
    expected: authorityBinding,
    participantContextIds,
    specificationReference: runRecord.specDigest
  });
  if (derived.errors.length > 0) workflowError("evidence_authority_invalid", "Evidence sources are invalid", { reasons: derived.errors });

  const levels = collectLevels({ baseline, verificationEntries, authorityReceipts: receiptValues });
  const maximum = highestClaimableEvidenceLevel(levels);
  const requiredLevel = taskPacket.verification.requiredEvidenceLevel;
  if (!maximum || compareEvidenceLevel(maximum, requiredLevel) < 0) {
    workflowError("evidence_level_insufficient", "Evidence does not reach the task's required level", {
      required: requiredLevel,
      highestClaimable: maximum
    });
  }

  const taskPacketDigest = digestJson(taskPacket);
  const reviewEvidence = reviewEntries.map(({ reference, value }) => ({
    reportRef: reference,
    reportId: value.reportId,
    reportDigest: digestJson(value),
    createdAt: value.createdAt,
    reviewContextId: value.reviewContextId,
    implementerContextId: value.implementerContextId,
    contextDigest: value.contextDigest,
    verdict: value.verdict
  }));
  const resultDigests = verificationResultDigests(verificationEntries);
  const bundle = {
    schemaVersion: 2,
    frameworkVersion: version,
    bundleId: requiredString(bundleId, "bundleId"),
    runId: runRecord.runId,
    taskId: runRecord.taskId,
    baselineId: runRecord.baselineId,
    baselineDigest,
    baseRevision: taskPacket.baseRevision,
    taskKind: taskPacket.taskKind,
    specDigest: runRecord.specDigest,
    taskPacketDigest,
    controlDigest: runRecord.controlDigest,
    subjectContentDigest: runRecord.subjectContentDigest,
    subjectEntries: structuredClone(boundSubjectContent.entries),
    actualImpact: structuredClone(boundActualImpact),
    activation: {
      status: "candidate",
      externalTargetRequired: true,
      baseRevision: taskPacket.baseRevision,
      subjectContentDigest: runRecord.subjectContentDigest,
    },
    expectedTaskDigest: runRecord.expectedTaskDigest,
    subjectRevision: runRecord.subjectRevision,
    worktreeDigest: runRecord.worktreeDigest,
    contextManifestDigest: actualContextDigest,
    createdAt: requiredString(createdAt, "createdAt"),
    decision: exclusions.length > 0 ? "accepted_with_exclusions" : "pass",
    declaredMaximumLevel: maximum,
    levels,
    verificationResultDigests: resultDigests,
    verifierEvidence: verificationEntries.map(({ reference, result }) => ({
      resultRef: reference,
      resultId: result.resultId,
      resultDigest: result.resultDigest,
      verifierId: result.verifierId,
      status: result.status,
      complete: result.complete,
      requiredTier: result.requiredTier,
      executedTier: result.executedTier,
      level: result.evidenceLevel,
      definitionDigest: result.definitionDigest,
      inputDigest: result.inputDigest,
      outputDigest: result.outputDigest,
      completedAt: result.completedAt
    })),
    reviewReportRefs: reviewEntries.map((entry) => entry.reference),
    reviewEvidence,
    authorityReceiptRefs: [...authorityReceiptRefs],
    authorityReceipts: structuredClone(receiptValues),
    decisionEvidence: {
      blockingDecisionIds: [],
      truthSourceConflictIds: [],
      sideEffects: results.map((result) => ({
        kind: result.verifierId,
        occurred: result.sideEffect?.occurred === true,
        authorized: result.sideEffect?.authorized === true,
        ...(result.sideEffect?.authorizationRef ? { authorizationRef: result.sideEffect.authorizationRef } : {})
      }))
    },
    limitations: [...new Set(limitations)],
    exclusions: [...new Set(exclusions)]
  };
  bundle.bundleDigest = computeEvidenceBundleDigest(bundle);
  const freshness = evaluateSealedEvidenceFreshness(bundle, {
    frameworkVersion: version,
    baseline,
    taskPacket,
    subjectRevision: runRecord.subjectRevision,
    worktreeDigest: runRecord.worktreeDigest,
    subjectContentDigest: runRecord.subjectContentDigest,
    contextManifest,
    verificationResults,
    verifierDefinitionDigests,
    verifierInputDigests,
    reviewReports,
    authorityReceipts
  });
  if (!freshness.fresh) workflowError("evidence_seal_not_fresh", "Newly sealed evidence failed its own freshness check", { reasons: freshness.reasons });
  return bundle;
}

export function evaluateSealedEvidenceFreshness(bundle, current) {
  const reasons = [];
  const currentValue = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const requiredCurrent = [
    ["frameworkVersion", (value) => typeof value === "string" && value.length > 0],
    ["baseline", (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)],
    ["taskPacket", (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)],
    ["subjectContentDigest", (value) => typeof value === "string" && value.length > 0],
    ["contextManifest", (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)],
    ["verificationResults", Array.isArray],
    ["reviewReports", Array.isArray],
    ["authorityReceipts", Array.isArray],
    ["verifierDefinitionDigests", (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)],
    ["verifierInputDigests", (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)]
  ];
  for (const [field, valid] of requiredCurrent) {
    if (!Object.hasOwn(currentValue, field) || !valid(currentValue[field])) {
      reasons.push({ code: "EVIDENCE_CURRENT_INPUT_MISSING", message: `Current ${field} input is required`, field });
    }
  }

  const baseline = currentValue.baseline && typeof currentValue.baseline === "object" && !Array.isArray(currentValue.baseline)
    ? currentValue.baseline
    : null;
  const taskPacket = currentValue.taskPacket && typeof currentValue.taskPacket === "object" && !Array.isArray(currentValue.taskPacket)
    ? currentValue.taskPacket
    : null;
  const contextManifest = currentValue.contextManifest
    && typeof currentValue.contextManifest === "object"
    && !Array.isArray(currentValue.contextManifest)
    ? currentValue.contextManifest
    : null;
  if (taskPacket && taskPacket.schemaVersion !== 2) {
    reasons.push({ code: "EVIDENCE_CURRENT_SCHEMA_VERSION_INVALID", message: "Current taskPacket must use schemaVersion 2", field: "taskPacket", expected: 2, actual: taskPacket.schemaVersion ?? null });
  }
  if (contextManifest && contextManifest.schemaVersion !== 2) {
    reasons.push({ code: "EVIDENCE_CURRENT_SCHEMA_VERSION_INVALID", message: "Current contextManifest must use schemaVersion 2", field: "contextManifest", expected: 2, actual: contextManifest.schemaVersion ?? null });
  }

  const currentTaskDigest = taskPacket ? digestJson(taskPacket) : undefined;
  const currentManifestDigest = contextManifest
    ? digestJson(withoutDigest(contextManifest, "manifestDigest"))
    : undefined;
  const base = evaluateEvidenceFreshness(bundle, {
    baselineId: baseline ? baseline.baselineId : undefined,
    specDigest: taskPacket ? taskPacket.specDigest : undefined,
    expectedTaskDigest: currentTaskDigest,
    taskPacketDigest: currentTaskDigest,
    controlDigest: taskPacket ? taskPacket.controlDigest : undefined,
    subjectContentDigest: currentValue.subjectContentDigest,
    contextManifestDigest: currentManifestDigest,
    verifierDefinitionDigests: currentValue.verifierDefinitionDigests,
    verifierInputDigests: currentValue.verifierInputDigests
  });
  reasons.push(...base.reasons);
  if (typeof currentValue.frameworkVersion === "string" && bundle.frameworkVersion !== currentValue.frameworkVersion) {
    reasons.push({ code: "EVIDENCE_FRAMEWORK_STALE", message: "Framework version changed", expected: currentValue.frameworkVersion, actual: bundle.frameworkVersion });
  }
  if (baseline && bundle.baselineDigest !== digestJson(baseline)) {
    reasons.push({ code: "EVIDENCE_BASELINE_CONTENT_STALE", message: "Baseline content changed" });
  }
  if (taskPacket && bundle.taskPacketDigest !== currentTaskDigest) {
    reasons.push({ code: "EVIDENCE_TASK_PACKET_STALE", message: "Task packet changed" });
  }
  if (contextManifest) {
    if (contextManifest.manifestDigest !== currentManifestDigest) {
      reasons.push({ code: "EVIDENCE_CONTEXT_MANIFEST_INVALID", message: "Current context manifest digest is invalid" });
    }
  }
  if (Array.isArray(currentValue.verificationResults)) {
    try {
      const entries = normalizeReferencedVerificationResults(currentValue.verificationResults);
      for (const entry of entries) {
        if (entry.result.schemaVersion !== 2) {
          reasons.push({
            code: "EVIDENCE_CURRENT_SCHEMA_VERSION_INVALID",
            message: "Current verification result must use schemaVersion 2",
            field: "verificationResults",
            resultId: entry.result.resultId ?? null,
            expected: 2,
            actual: entry.result.schemaVersion ?? null
          });
        }
      }
      const comparison = compareVerificationBindingSet({
        expectedRefs: (bundle.verifierEvidence ?? []).map((entry) => entry.resultRef),
        expectedDigests: bundle.verificationResultDigests,
        actualEntries: entries
      });
      reasons.push(...comparison.errors.map((entry) => ({ ...entry, code: `EVIDENCE_${entry.code}` })));
    } catch (error) {
      reasons.push({ code: "EVIDENCE_VERIFICATION_RESULT_INVALID", message: error.message });
    }
  }
  if (Array.isArray(currentValue.reviewReports)) {
    try {
      const reviewEntries = referencedValues(currentValue.reviewReports, "report", "reviewReports");
      for (const entry of reviewEntries) {
        if (entry.value.schemaVersion !== 2) {
          reasons.push({
            code: "EVIDENCE_CURRENT_SCHEMA_VERSION_INVALID",
            message: "Current review report must use schemaVersion 2",
            field: "reviewReports",
            reportId: entry.value.reportId ?? null,
            expected: 2,
            actual: entry.value.schemaVersion ?? null
          });
        }
      }
      const currentReviews = new Map(reviewEntries.map((entry) => [entry.reference, digestJson(entry.value)]));
      if (currentReviews.size !== (bundle.reviewEvidence ?? []).length) {
        reasons.push({ code: "EVIDENCE_REVIEW_SET_STALE", message: "Review report set changed" });
      }
      for (const evidence of bundle.reviewEvidence ?? []) {
        if (currentReviews.get(evidence.reportRef) !== evidence.reportDigest) {
          reasons.push({ code: "EVIDENCE_REVIEW_STALE", message: "Review report changed or is missing", reportRef: evidence.reportRef });
        }
      }
    } catch (error) {
      reasons.push({ code: "EVIDENCE_REVIEW_REPORT_INVALID", message: error.message });
    }
  }
  if (Array.isArray(currentValue.authorityReceipts)) {
    try {
      const normalized = normalizeAuthorityReceiptEntries(currentValue.authorityReceipts, { requireReferences: true });
      for (const receipt of normalized.receipts) {
        if (receipt.schemaVersion !== 2) {
          reasons.push({
            code: "EVIDENCE_CURRENT_SCHEMA_VERSION_INVALID",
            message: "Current authority receipt must use schemaVersion 2",
            field: "authorityReceipts",
            receiptId: receipt.receiptId ?? null,
            expected: 2,
            actual: receipt.schemaVersion ?? null
          });
        }
      }
      const expectedReceipts = (bundle.authorityReceipts ?? []).map(digestJson);
      const actualReceipts = normalized.receipts.map(digestJson);
      const expectedRefs = bundle.authorityReceiptRefs ?? [];
      if (expectedRefs.length !== normalized.references.length
        || expectedRefs.some((reference, index) => reference !== normalized.references[index])
        || expectedReceipts.length !== actualReceipts.length
        || expectedReceipts.some((digest, index) => digest !== actualReceipts[index])) {
        reasons.push({ code: "EVIDENCE_AUTHORITY_RECEIPTS_STALE", message: "Authority receipt references, set, or order changed" });
      }
    } catch (error) {
      reasons.push({
        code: "EVIDENCE_AUTHORITY_RECEIPTS_INVALID",
        message: error.message,
        authorityCode: error.code ?? null
      });
    }
  }
  return { fresh: reasons.length === 0, reasons, highestClaimableLevel: base.highestClaimableLevel };
}
