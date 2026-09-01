export function validateReviewCoverage(report, taskPacket) {
  const errors = [];
  if (taskPacket?.review?.profileId && report?.profileId !== taskPacket.review.profileId) {
    errors.push({ code: "REVIEW_PROFILE_MISMATCH", message: "review profile differs from the TaskPacket", expected: taskPacket.review.profileId, actual: report?.profileId ?? null });
  }
  const mandatory = taskPacket?.review?.mandatoryLensIds ?? [];
  const coverage = report?.lensCoverage ?? [];
  const byLens = new Map();
  for (const entry of coverage) {
    if (byLens.has(entry?.lensId)) {
      errors.push({ code: "REVIEW_LENS_DUPLICATE", message: "review lens coverage must be unique", lensId: entry?.lensId ?? null });
    } else {
      byLens.set(entry?.lensId, entry);
    }
  }
  const decisionIds = new Set([
    ...(taskPacket?.decisionDependencies ?? []).map((entry) => entry.decisionId),
    ...(taskPacket?.derivation?.blockingDecisionIds ?? []),
  ]);
  for (const lensId of mandatory) {
    const entry = byLens.get(lensId);
    if (!entry) {
      errors.push({ code: "REVIEW_LENS_MISSING", message: "mandatory review lens is missing", lensId });
      continue;
    }
    const justifiedNotApplicable = entry.status === "not_applicable"
      && typeof entry.rationale === "string"
      && Boolean(entry.rationale.trim());
    if (entry.status === "not_applicable" && !justifiedNotApplicable) {
      errors.push({ code: "REVIEW_LENS_NA_UNJUSTIFIED", message: "not_applicable review lens requires a rationale", lensId });
    }
    if (entry.status === "blocked" && !decisionIds.has(entry.decisionId)) {
      errors.push({ code: "REVIEW_LENS_BLOCKER_UNBOUND", message: "blocked review lens must bind a TaskPacket decision", lensId, decisionId: entry.decisionId ?? null });
    }
    if (report?.verdict === "pass" && entry.status !== "covered" && !justifiedNotApplicable) {
      errors.push({ code: "REVIEW_PASS_WITHOUT_COVERAGE", message: "passing review requires every mandatory lens to be covered", lensId, status: entry.status });
    }
  }
  return { ok: errors.length === 0, errors };
}
