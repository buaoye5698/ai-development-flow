import {
  buildAuthorityReceiptBinding,
  digestJson,
  evaluateCycle,
  normalizeAuthorityReceiptEntries,
  validateVerificationResultEvidence
} from "../core/index.mjs";
import { evaluateHumanGates, validateContextIsolation } from "./gates.mjs";
import {
  compareVerificationBindingSet,
  normalizeReferencedVerificationResults
} from "./verification-bindings.mjs";
import { validateReviewCoverage } from "./review-coverage.mjs";

function reason(code, message, details = {}) {
  return { code, message, ...details };
}

function schemaVersionReason(value, artifact, details = {}) {
  return value?.schemaVersion === 2
    ? null
    : reason("evidence_schema_version_invalid", `${artifact} must use schemaVersion 2`, {
      artifact,
      expected: 2,
      actual: value?.schemaVersion ?? null,
      ...details
    });
}

function maxRepairRounds(projectConfig, taskPacket) {
  const projectMax = Number.isInteger(projectConfig?.automationPolicy?.maxRepairRounds)
    ? projectConfig.automationPolicy.maxRepairRounds
    : 3;
  const taskMax = Number.isInteger(taskPacket?.repairPolicy?.maxRounds)
    ? taskPacket.repairPolicy.maxRounds
    : projectMax;
  return Math.min(projectMax, taskMax);
}

function failureFingerprints(results) {
  return results.map((entry) => digestJson({
    category: "verification",
    verifierId: entry.verifierId,
    status: entry.status,
    outputDigest: entry.outputDigest
  })).sort();
}

function escalation(reasons, details = {}) {
  return {
    decision: "escalate",
    nextState: "escalated",
    reasons,
    humanGates: [],
    ...details
  };
}

function classifyReviewReports({ reviewReports, runRecord, taskPacket, entries }) {
  const current = [];
  const ignored = [];
  const securityErrors = [];
  const activeReviewContextId = runRecord?.reviewerContextIds?.at(-1);

  for (const report of reviewReports) {
    if (report?.reviewContextId === runRecord?.implementerContextId
      || report?.reviewContextId === report?.implementerContextId) {
      securityErrors.push(reason("review_self_review", "Implementer context cannot supply a review report", {
        reportId: report?.reportId ?? null,
        reviewContextId: report?.reviewContextId ?? null
      }));
      continue;
    }

    const staleReasons = [];
    if (report?.taskId !== taskPacket?.taskId) staleReasons.push("task_mismatch");
    if (report?.baselineId !== taskPacket?.baselineId) staleReasons.push("baseline_mismatch");
    if (report?.specDigest !== taskPacket?.specDigest) staleReasons.push("spec_mismatch");
    if (report?.taskPacketDigest !== runRecord?.taskPacketDigest) staleReasons.push("task_packet_digest_mismatch");
    if (report?.controlDigest !== runRecord?.controlDigest) staleReasons.push("control_digest_mismatch");
    if (report?.subjectContentDigest !== runRecord?.subjectContentDigest) staleReasons.push("subject_content_digest_mismatch");
    if (report?.subjectRevision !== runRecord?.subjectRevision) staleReasons.push("subject_revision_mismatch");
    if (report?.implementerContextId !== runRecord?.implementerContextId) staleReasons.push("implementer_context_mismatch");
    if (activeReviewContextId && report?.reviewContextId !== activeReviewContextId) staleReasons.push("review_context_mismatch");

    const bindings = compareVerificationBindingSet({
      expectedRefs: report?.verificationResultRefs,
      expectedDigests: report?.verificationResultDigests,
      actualEntries: entries,
      contextDigest: report?.contextDigest,
      reviewContextId: report?.reviewContextId,
      subjectRevision: report?.subjectRevision,
      subjectContentDigest: report?.subjectContentDigest,
      taskPacketDigest: report?.taskPacketDigest,
      controlDigest: report?.controlDigest
    });
    staleReasons.push(...bindings.errors.map((entry) => entry.code.toLowerCase()));

    if (staleReasons.length > 0) {
      ignored.push({
        reportId: report?.reportId ?? null,
        reviewRound: report?.reviewRound ?? null,
        reasons: [...new Set(staleReasons)].sort()
      });
    } else {
      current.push(report);
    }
  }
  return { current, ignored, securityErrors };
}

export function adjudicateWorkflowCycle({
  runRecord,
  taskPacket,
  baseline,
  projectConfig,
  verificationResults = [],
  reviewReports = [],
  authorityReceipts = [],
  changedPaths = [],
  requestedChangePaths = [],
  judgePaths,
  judgeModificationRequested = false
}) {
  let entries;
  try {
    entries = normalizeReferencedVerificationResults(verificationResults);
  } catch (error) {
    return escalation([reason(error.code ?? "verification_result_invalid", error.message, error.details ?? {})]);
  }
  const results = entries.map((entry) => entry.result);
  let receiptValues;
  try {
    receiptValues = normalizeAuthorityReceiptEntries(authorityReceipts).receipts;
  } catch (error) {
    return escalation([reason(error.code ?? "authority_receipt_invalid", error.message, error.details ?? {})]);
  }
  const schemaVersionErrors = [
    schemaVersionReason(runRecord, "run record"),
    schemaVersionReason(taskPacket, "task packet"),
    ...results.map((result) => schemaVersionReason(result, "verification result", {
      resultId: result?.resultId ?? null
    })),
    ...reviewReports.map((report) => schemaVersionReason(report, "review report", {
      reportId: report?.reportId ?? null
    })),
    ...receiptValues.map((receipt) => schemaVersionReason(receipt, "authority receipt", {
      receiptId: receipt?.receiptId ?? null
    }))
  ].filter(Boolean);
  if (schemaVersionErrors.length > 0) return escalation(schemaVersionErrors);
  const gateResult = evaluateHumanGates({
    taskPacket,
    baseline,
    projectConfig,
    changedPaths,
    requestedChangePaths,
    judgePaths,
    judgeModificationRequested,
    executionAuthorized: (runRecord?.authorizationConsumptions?.length ?? 0) > 0,
    verificationResults: results
  });
  if (gateResult.blocked) {
    const beforeExecution = ["draft", "blocked", "ready"].includes(runRecord?.state);
    return {
      decision: beforeExecution ? "blocked" : "escalate",
      nextState: beforeExecution ? "blocked" : "escalated",
      reasons: gateResult.gates,
      humanGates: gateResult.gates
    };
  }

  const expectedTaskDigest = digestJson(taskPacket);
  const baselineDigest = digestJson(baseline);
  if (runRecord?.expectedTaskDigest !== expectedTaskDigest) {
    return escalation([reason("run_task_digest_mismatch", "Run record is bound to a different task packet", {
      expected: expectedTaskDigest,
      actual: runRecord?.expectedTaskDigest ?? null
    })]);
  }
  if (runRecord?.taskPacketDigest !== expectedTaskDigest) {
    return escalation([reason("run_task_packet_digest_mismatch", "Run record is bound to a different task packet", {
      expected: expectedTaskDigest,
      actual: runRecord?.taskPacketDigest ?? null
    })]);
  }
  if (runRecord?.controlDigest !== taskPacket?.controlDigest) {
    return escalation([reason("run_control_digest_mismatch", "Run record is bound to different Active Control", {
      expected: taskPacket?.controlDigest ?? null,
      actual: runRecord?.controlDigest ?? null
    })]);
  }
  const requiredVerifierIds = taskPacket?.verification?.verifierIds ?? [];
  const byVerifier = new Map(entries.map((entry) => [entry.result.verifierId, entry]));
  const extra = [...byVerifier.keys()].filter((id) => !requiredVerifierIds.includes(id));
  const missing = requiredVerifierIds.filter((id) => !byVerifier.has(id));
  if (extra.length > 0) {
    return escalation([reason("verification_result_extra", "Verification result set contains an unrequested verifier", {
      verifierIds: extra.sort()
    })]);
  }
  if (missing.length > 0) {
    return {
      decision: "verify",
      nextState: "verifying",
      reasons: [reason("verification_incomplete_or_stale", "Required deterministic verification is missing", {
        missingVerifierIds: missing.sort(),
        staleVerifierIds: []
      })],
      humanGates: []
    };
  }

  if (entries.length > 0 || (runRecord?.verificationResultRefs?.length ?? 0) > 0) {
    const runBindings = compareVerificationBindingSet({
      expectedRefs: runRecord?.verificationResultRefs,
      expectedDigests: runRecord?.verificationResultDigests,
      actualEntries: entries
    });
    if (!runBindings.ok) return escalation(runBindings.errors);
  }

  const expected = {
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    expectedTaskDigest,
    taskPacketDigest: expectedTaskDigest,
    controlDigest: runRecord.controlDigest,
    subjectContentDigest: runRecord.subjectContentDigest,
    subjectRevision: runRecord.subjectRevision,
    worktreeDigest: runRecord.worktreeDigest,
    requiredTier: taskPacket.verification?.tier,
    baselineDigest
  };
  const requiredResults = requiredVerifierIds.map((id) => byVerifier.get(id).result);
  const inspections = requiredResults.map((result) => ({
    result,
    inspection: validateVerificationResultEvidence(result, expected)
  }));
  const invalid = inspections.flatMap(({ inspection }) => inspection.errors);
  if (invalid.length > 0) return escalation(invalid);

  const incomplete = inspections
    .filter(({ result, inspection }) => result.status === "partial"
      || (result.status === "pass" && !inspection.completePass))
    .map(({ result }) => result.verifierId);
  if (incomplete.length > 0) {
    return {
      decision: "verify",
      nextState: "verifying",
      reasons: [reason("verification_incomplete", "Verification did not complete the required tier", {
        verifierIds: incomplete.sort()
      })],
      humanGates: []
    };
  }

  const failed = requiredResults.filter((entry) => entry.status !== "pass" || entry.complete !== true);
  if (failed.length > 0) {
    const maxRounds = maxRepairRounds(projectConfig, taskPacket);
    if ((runRecord?.repairHistory?.length ?? 0) >= maxRounds) {
      return escalation([reason("repair_round_limit", "Deterministic verification still fails at the repair limit", {
        maxRounds,
        verifierIds: failed.map((entry) => entry.verifierId).sort()
      })]);
    }
    return {
      decision: "repair",
      nextState: "repairing",
      reasons: [reason("verification_failed", "Deterministic verification failed", {
        verifierIds: failed.map((entry) => entry.verifierId).sort()
      })],
      findingFingerprints: failureFingerprints(failed),
      humanGates: []
    };
  }

  const classifiedReports = classifyReviewReports({ reviewReports, runRecord, taskPacket, entries });
  if (classifiedReports.securityErrors.length > 0) {
    return escalation(classifiedReports.securityErrors, { ignoredReviewReports: classifiedReports.ignored });
  }
  const currentReports = classifiedReports.current;
  if (currentReports.length === 0) {
    return {
      decision: "review",
      nextState: "reviewing",
      reasons: [reason("review_required", "Passing deterministic verification requires an independent fresh-context review")],
      humanGates: [],
      ignoredReviewReports: classifiedReports.ignored
    };
  }

  const coverageErrors = currentReports.flatMap((report) => validateReviewCoverage(report, taskPacket).errors
    .map((entry) => reason(entry.code.toLowerCase(), entry.message, { ...entry, reportId: report.reportId })));
  if (coverageErrors.length > 0) {
    return escalation(coverageErrors, { ignoredReviewReports: classifiedReports.ignored });
  }

  const isolation = validateContextIsolation({
    runRecord,
    reviewReports: currentReports,
    policy: projectConfig?.automationPolicy
  });
  if (!isolation.ok) {
    return escalation(isolation.errors.map((entry) => reason(entry.code, "Reviewer role or context isolation is invalid", entry)), {
      ignoredReviewReports: classifiedReports.ignored
    });
  }

  const participantContextIds = [
    runRecord.implementerContextId,
    ...(runRecord.reviewerContextIds ?? []),
    ...currentReports.flatMap((report) => [report.implementerContextId, report.reviewContextId])
  ].filter(Boolean);
  const authorityBinding = buildAuthorityReceiptBinding({
    ...expected
  }, {
    verificationResults: requiredResults,
    reviewReports: currentReports,
    participantContextIds
  });
  const cycle = evaluateCycle({
    policy: projectConfig?.automationPolicy,
    taskPacket,
    reviewReports: currentReports,
    verificationResults: requiredResults,
    authorityReceipts: receiptValues,
    evidenceBinding: authorityBinding,
    participantContextIds,
    truthSourceConflicts: [],
    sideEffects: requiredResults.map((entry) => ({
      kind: entry.verifierId,
      occurred: entry.sideEffect?.occurred === true,
      authorized: entry.sideEffect?.authorized === true,
      authorizationRef: entry.sideEffect?.authorizationRef
    }))
  });
  if (cycle.decision === "pass") {
    return {
      decision: "accept",
      nextState: "accepted",
      reasons: [],
      evidenceLevel: cycle.highestClaimableEvidenceLevel,
      humanGates: [],
      ignoredReviewReports: classifiedReports.ignored
    };
  }
  if (cycle.decision === "repair") {
    return {
      decision: "repair",
      nextState: "repairing",
      reasons: cycle.reasons,
      findingFingerprints: cycle.activeFindingFingerprints,
      humanGates: [],
      ignoredReviewReports: classifiedReports.ignored
    };
  }
  return {
    decision: "blocked",
    nextState: "escalated",
    reasons: cycle.reasons,
    humanGates: [],
    ignoredReviewReports: classifiedReports.ignored
  };
}
