import { computeFindingFingerprint } from "./finding.mjs";
import { compareEvidenceLevel, deriveEvidenceLevels } from "./evidence.mjs";

function result(decision, reasons, details = {}) {
  return { decision, reasons, ...details };
}

function reason(code, message, details = {}) {
  return { code, message, ...details };
}

function fingerprintSet(report) {
  return [...new Set((Array.isArray(report?.findings) ? report.findings : [])
    .map((finding) => finding.fingerprint)
    .filter((value) => typeof value === "string"))].sort();
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function enabled(policy, name) {
  return !Array.isArray(policy?.stopConditions) || policy.stopConditions.includes(name);
}

export function evaluateCycle({
  policy = {},
  taskPacket,
  reviewReports = [],
  verificationResults = [],
  authorityReceipts = [],
  evidenceBinding = {},
  participantContextIds = [],
  truthSourceConflicts = [],
  sideEffects = []
}) {
  const ordered = [...reviewReports].sort((left, right) => (left?.reviewRound ?? -1) - (right?.reviewRound ?? -1));
  const blockingReasons = [];

  const activeConflicts = truthSourceConflicts.filter((entry) => !["resolved", "closed"].includes(entry?.status));
  if (enabled(policy, "truth_source_conflict") && activeConflicts.length > 0) {
    blockingReasons.push(reason("TRUTH_SOURCE_CONFLICT", "An active truth-source conflict blocks the cycle", {
      conflictIds: activeConflicts.map((entry) => entry.conflictId ?? entry.id).filter(Boolean)
    }));
  }

  const unauthorizedEffects = sideEffects.filter((entry) => entry?.occurred === true
    && (entry?.authorized !== true || typeof entry?.authorizationRef !== "string" || entry.authorizationRef.length === 0));
  if (enabled(policy, "side_effect_requires_approval") && unauthorizedEffects.length > 0) {
    blockingReasons.push(reason("SIDE_EFFECT_UNAUTHORIZED", "A side effect occurred without explicit authorization evidence", {
      kinds: unauthorizedEffects.map((entry) => entry.kind ?? "unknown")
    }));
  }

  if (ordered.length === 0) {
    blockingReasons.push(reason("REVIEW_MISSING", "At least one independent review report is required"));
  }

  const rounds = new Set();
  const contexts = new Set();
  for (const report of ordered) {
    if (rounds.has(report?.reviewRound)) {
      blockingReasons.push(reason("REVIEW_ROUND_DUPLICATE", "Review round is duplicated", { reviewRound: report?.reviewRound }));
    }
    rounds.add(report?.reviewRound);
    if (taskPacket?.taskId && report?.taskId !== taskPacket.taskId) {
      blockingReasons.push(reason("REVIEW_TASK_MISMATCH", "Review report belongs to a different task", { reportId: report?.reportId }));
    }
    if (taskPacket?.baselineId && report?.baselineId !== taskPacket.baselineId) {
      blockingReasons.push(reason("REVIEW_BASELINE_MISMATCH", "Review report belongs to a different baseline", { reportId: report?.reportId }));
    }
    if (taskPacket?.specDigest && report?.specDigest !== taskPacket.specDigest) {
      blockingReasons.push(reason("REVIEW_SPEC_MISMATCH", "Review report uses a different specification digest", { reportId: report?.reportId }));
    }
    if (policy.freshReviewContextRequired === true) {
      if (contexts.has(report?.reviewContextId)) {
        blockingReasons.push(reason("REVIEW_CONTEXT_REUSED", "Review context was reused", { reviewContextId: report?.reviewContextId }));
      }
      contexts.add(report?.reviewContextId);
    }
    if (policy.implementerCannotReviewOwnTask === true && report?.reviewContextId === report?.implementerContextId) {
      blockingReasons.push(reason("REVIEW_SELF_REVIEW", "Implementer context cannot review its own task", { reportId: report?.reportId }));
    }
    for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
      const expected = computeFindingFingerprint(finding);
      if (finding.fingerprint !== expected) {
        blockingReasons.push(reason("FINDING_FINGERPRINT_INVALID", "Finding fingerprint does not match normalized finding content", {
          findingId: finding.findingId,
          expected,
          actual: finding.fingerprint
        }));
      }
    }
  }

  if (blockingReasons.length > 0) return result("blocked", blockingReasons);
  const latest = ordered.at(-1);

  if ((latest.blockingDecisionIds ?? []).length > 0 && enabled(policy, "unresolved_decision")) {
    return result("blocked", [reason("UNRESOLVED_DECISION", "Review has blocking unresolved decisions", {
      decisionIds: latest.blockingDecisionIds
    })]);
  }
  if (latest.verdict === "blocked") {
    return result("blocked", [reason("REVIEW_BLOCKED", "Independent review is blocked")]);
  }

  if (latest.verdict === "pass") {
    if ((latest.findings ?? []).length > 0) {
      return result("blocked", [reason("PASS_WITH_FINDINGS", "A passing review cannot contain active findings")]);
    }
    const derived = deriveEvidenceLevels({
      verificationResults,
      authorityReceipts,
      expected: evidenceBinding,
      participantContextIds,
      specificationReference: taskPacket?.specDigest ?? 'task/spec binding'
    });
    if (derived.errors.length > 0) {
      return result('blocked', derived.errors);
    }
    const highest = derived.highestLevel;
    const required = taskPacket?.verification?.requiredEvidenceLevel;
    if (!highest || !required || compareEvidenceLevel(highest, required) < 0) {
      return result("blocked", [reason("EVIDENCE_INSUFFICIENT", "Passing review does not reach the task's required evidence level", {
        required: required ?? null,
        highestClaimable: highest
      })]);
    }
    return result("pass", [], {
      latestReviewRound: latest.reviewRound,
      highestClaimableEvidenceLevel: highest,
      repairedFindingFingerprints: [...new Set(ordered.slice(0, -1).flatMap(fingerprintSet))].sort()
    });
  }

  const activeFingerprints = fingerprintSet(latest);
  if ((latest.findings ?? []).some((finding) => finding.repairable !== true)) {
    return result("blocked", [reason("FINDING_NOT_REPAIRABLE", "Review contains a finding that is not eligible for automatic repair")], {
      activeFindingFingerprints: activeFingerprints
    });
  }

  const maxRounds = Math.min(
    Number.isInteger(policy.maxRepairRounds) ? policy.maxRepairRounds : 3,
    Number.isInteger(taskPacket?.repairPolicy?.maxRounds) ? taskPacket.repairPolicy.maxRounds : 3
  );
  if (enabled(policy, "repair_round_limit") && latest.reviewRound >= maxRounds) {
    return result("blocked", [reason("REPAIR_ROUND_LIMIT", "Automatic repair round limit has been reached", { maxRounds })], {
      activeFindingFingerprints: activeFingerprints
    });
  }

  const threshold = Number.isInteger(policy.stopAfterSameFindingFingerprint)
    ? policy.stopAfterSameFindingFingerprint
    : 2;
  if (enabled(policy, "same_finding_repeated")) {
    for (const fingerprint of activeFingerprints) {
      let consecutive = 0;
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        if (!fingerprintSet(ordered[index]).includes(fingerprint)) break;
        consecutive += 1;
      }
      if (consecutive >= threshold) {
        return result("blocked", [reason("SAME_FINDING_REPEATED", "The same active finding reached the repetition threshold", {
          fingerprint,
          consecutive,
          threshold
        })], { activeFindingFingerprints: activeFingerprints });
      }
    }
  }

  if (enabled(policy, "repair_oscillation") && ordered.length >= 3) {
    const current = fingerprintSet(ordered.at(-1));
    const previous = fingerprintSet(ordered.at(-2));
    const beforePrevious = fingerprintSet(ordered.at(-3));
    if (sameSet(current, beforePrevious) && !sameSet(current, previous)) {
      return result("blocked", [reason("REPAIR_OSCILLATION", "Finding sets oscillated in an A-B-A pattern")], {
        activeFindingFingerprints: activeFingerprints
      });
    }
  }

  return result("repair", [], {
    nextReviewRound: latest.reviewRound + 1,
    activeFindingFingerprints: activeFingerprints
  });
}
