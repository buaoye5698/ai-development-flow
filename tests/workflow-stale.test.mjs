import assert from "node:assert/strict";
import test from "node:test";

import {
  computeEvidenceBundleDigest,
  computeVerificationResultDigest,
  digestJson,
} from "../src/core/index.mjs";
import { evaluateSealedEvidenceFreshness } from "../src/workflow/index.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const LEGACY_FRAMEWORK_VERSION = "0.1.0";
const CURRENT_FRAMEWORK_VERSION = "0.2.0";
const BASE_REVISION = "a".repeat(40);
const CONTROL_DIGEST = digest("c");
const SUBJECT_CONTENT_DIGEST = digestJson({ baseRevision: BASE_REVISION, entries: [] });
const WORKTREE_DIGEST = digest("w");
const baseline = {
  schemaVersion: 1,
  baselineId: "BASELINE-001",
  status: "active",
  createdAt: "2026-08-27T00:00:00Z",
  canonicalSpecSourceId: "SPEC-001",
  truthSources: [],
  knownConflicts: [],
  decisionRegister: "ai-dev/decisions/register.json",
};
const taskPacket = {
  schemaVersion: 2,
  taskId: "TASK-001",
  baselineId: baseline.baselineId,
  specDigest: digest("a"),
  controlDigest: CONTROL_DIGEST,
  baseRevision: BASE_REVISION,
};
const taskPacketDigest = digestJson(taskPacket);
const contextBody = {
  schemaVersion: 2,
  manifestId: "CTX-001",
  taskId: taskPacket.taskId,
  baselineId: taskPacket.baselineId,
  specDigest: taskPacket.specDigest,
  taskPacketDigest,
  controlDigest: CONTROL_DIGEST,
  subjectContentDigest: SUBJECT_CONTENT_DIGEST,
  subjectRevision: BASE_REVISION,
  items: [],
  exclusions: [],
};
const contextManifest = { ...contextBody, manifestDigest: digestJson(contextBody) };
const verificationResultBody = {
  schemaVersion: 2,
  resultId: "VR-001",
  verifierId: "VERIFY-001",
  taskId: taskPacket.taskId,
  baselineId: taskPacket.baselineId,
  specDigest: taskPacket.specDigest,
  expectedTaskDigest: taskPacketDigest,
  taskPacketDigest,
  controlDigest: CONTROL_DIGEST,
  subjectContentDigest: SUBJECT_CONTENT_DIGEST,
  subjectRevision: BASE_REVISION,
  worktreeDigest: WORKTREE_DIGEST,
  definitionDigest: digest("b"),
  inputDigest: digest("c"),
  startedAt: "2026-08-27T00:02:00Z",
  completedAt: "2026-08-27T00:03:00Z",
  durationMs: 60_000,
  requiredTier: "quick",
  executedTier: "quick",
  evidenceLevel: "contract",
  status: "pass",
  complete: true,
  exitCode: 0,
  stdoutDigest: digest("s"),
  stderrDigest: digest("t"),
  outputDigest: digest("o"),
  cacheHit: false,
  summary: "contract verifier passed",
  artifactRefs: [],
  sideEffect: { occurred: false, authorized: false },
};
const verificationResult = {
  ...verificationResultBody,
  resultDigest: computeVerificationResultDigest(verificationResultBody),
};
const verificationResults = [{
  reference: "ai-dev/evidence/results/VR-001.json",
  result: verificationResult,
}];
const verificationResultDigests = [{
  resultId: verificationResult.resultId,
  resultDigest: verificationResult.resultDigest,
}];
const report = {
  schemaVersion: 2,
  reportId: "RR-001",
  taskId: taskPacket.taskId,
  baselineId: taskPacket.baselineId,
  specDigest: taskPacket.specDigest,
  taskPacketDigest,
  controlDigest: CONTROL_DIGEST,
  subjectContentDigest: SUBJECT_CONTENT_DIGEST,
  subjectRevision: BASE_REVISION,
  reviewRound: 0,
  implementerContextId: "implementer-1",
  reviewContextId: "review-1",
  contextDigest: digest("h"),
  createdAt: "2026-08-27T00:04:00Z",
  verdict: "pass",
  verificationResultRefs: verificationResults.map((entry) => entry.reference),
  verificationResultDigests,
  evidence: [{ level: "contract", status: "pass", reference: verificationResult.resultId }],
  findings: [],
  blockingDecisionIds: [],
  profileId: "default",
  lensCoverage: [{ lensId: "spec_conformance", status: "covered" }],
  summary: "review passed",
};
const reviewReports = [{ reference: "ai-dev/reviews/RR-001.json", report }];

function evidenceBundle(overrides = {}) {
  const bundle = {
    schemaVersion: 2,
    frameworkVersion: LEGACY_FRAMEWORK_VERSION,
    bundleId: "EVIDENCE-LEGACY-001",
    runId: "RUN-001",
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    baselineDigest: digestJson(baseline),
    baseRevision: BASE_REVISION,
    taskKind: "implementation",
    specDigest: taskPacket.specDigest,
    taskPacketDigest,
    controlDigest: CONTROL_DIGEST,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    subjectEntries: [],
    actualImpact: {
      changedPaths: [],
      matchedImpactRuleIds: [],
      requirementIds: [],
      acceptanceIds: [],
      verifierIds: [verificationResult.verifierId],
    },
    activation: {
      status: "candidate",
      externalTargetRequired: true,
      baseRevision: BASE_REVISION,
      subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    },
    expectedTaskDigest: taskPacketDigest,
    subjectRevision: BASE_REVISION,
    worktreeDigest: WORKTREE_DIGEST,
    contextManifestDigest: contextManifest.manifestDigest,
    createdAt: "2026-08-27T00:05:00Z",
    decision: "pass",
    declaredMaximumLevel: "contract",
    levels: [
      { level: "specification", status: "pass", references: [taskPacket.specDigest] },
      { level: "contract", status: "pass", references: [verificationResult.resultId] },
      { level: "runtime_stub", status: "not_claimed", references: [] },
      { level: "target_integration", status: "not_claimed", references: [] },
      { level: "owner", status: "not_claimed", references: [] },
      { level: "production", status: "not_claimed", references: [] },
    ],
    verificationResultDigests,
    verifierEvidence: [{
      resultRef: verificationResults[0].reference,
      resultId: verificationResult.resultId,
      resultDigest: verificationResult.resultDigest,
      verifierId: verificationResult.verifierId,
      status: "pass",
      complete: true,
      requiredTier: "quick",
      executedTier: "quick",
      level: "contract",
      definitionDigest: verificationResult.definitionDigest,
      inputDigest: verificationResult.inputDigest,
      outputDigest: verificationResult.outputDigest,
      completedAt: verificationResult.completedAt,
    }],
    reviewReportRefs: reviewReports.map((entry) => entry.reference),
    reviewEvidence: [{
      reportRef: reviewReports[0].reference,
      reportId: report.reportId,
      reportDigest: digestJson(report),
      createdAt: report.createdAt,
      reviewContextId: report.reviewContextId,
      implementerContextId: report.implementerContextId,
      contextDigest: report.contextDigest,
      verdict: report.verdict,
    }],
    authorityReceiptRefs: [],
    authorityReceipts: [],
    decisionEvidence: {
      blockingDecisionIds: [],
      truthSourceConflictIds: [],
      sideEffects: [],
    },
    limitations: [],
    exclusions: [],
    ...overrides,
  };
  bundle.bundleDigest = computeEvidenceBundleDigest(bundle);
  return bundle;
}

function current(overrides = {}) {
  return {
    frameworkVersion: LEGACY_FRAMEWORK_VERSION,
    baseline,
    taskPacket,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    contextManifest,
    verificationResults,
    verifierDefinitionDigests: { [verificationResult.verifierId]: verificationResult.definitionDigest },
    verifierInputDigests: { [verificationResult.verifierId]: verificationResult.inputDigest },
    reviewReports,
    authorityReceipts: [],
    ...overrides,
  };
}

test("sealed evidence becomes stale for every bound mutable input", () => {
  const bundle = evidenceBundle();
  assert.equal(evaluateSealedEvidenceFreshness(bundle, current()).fresh, true);
  const cases = [
    [current({ frameworkVersion: CURRENT_FRAMEWORK_VERSION }), "EVIDENCE_FRAMEWORK_STALE"],
    [current({ baseline: { ...baseline, status: "retired" } }), "EVIDENCE_BASELINE_CONTENT_STALE"],
    [current({ taskPacket: { ...taskPacket, goal: "changed" } }), "EVIDENCE_TASK_PACKET_STALE"],
    [current({ subjectContentDigest: digest("x") }), "EVIDENCE_SUBJECT_CONTENT_STALE"],
    [current({ contextManifest: { ...contextManifest, items: [{ path: "changed" }] } }), "EVIDENCE_CONTEXT_MANIFEST_INVALID"],
    [current({ verifierDefinitionDigests: { [verificationResult.verifierId]: digest("e") } }), "EVIDENCE_VERIFIER_STALE"],
    [current({ verifierInputDigests: { [verificationResult.verifierId]: digest("f") } }), "EVIDENCE_INPUT_STALE"],
    [current({ reviewReports: [{ reference: reviewReports[0].reference, report: { ...report, verdict: "fail" } }] }), "EVIDENCE_REVIEW_STALE"],
    [current({ reviewReports: [...reviewReports, { reference: "ai-dev/reviews/RR-002.json", report: { ...report, reportId: "RR-002" } }] }), "EVIDENCE_REVIEW_SET_STALE"],
  ];
  for (const [input, code] of cases) {
    const result = evaluateSealedEvidenceFreshness(bundle, input);
    assert.equal(result.fresh, false, code);
    assert.ok(result.reasons.some((entry) => entry.code === code), code);
  }
});

test("a recomputed bundle digest cannot legitimize evidence-level elevation", () => {
  const elevated = evidenceBundle({ declaredMaximumLevel: "production" });
  const result = evaluateSealedEvidenceFreshness(elevated, current());
  assert.equal(result.fresh, false);
  assert.ok(result.reasons.some((entry) => entry.code === "EVIDENCE_LEVEL_ELEVATED"));
});

test("sealed evidence rejects a recomputed digest when the required verifier tier was not completed", () => {
  const bundle = evidenceBundle();
  bundle.verifierEvidence[0].requiredTier = "deep";
  bundle.bundleDigest = computeEvidenceBundleDigest(bundle);
  const result = evaluateSealedEvidenceFreshness(bundle, current());
  assert.equal(result.fresh, false);
  assert.ok(result.reasons.some((entry) => entry.code === "EVIDENCE_VERIFIER_TIER_INCOMPLETE"));
});
