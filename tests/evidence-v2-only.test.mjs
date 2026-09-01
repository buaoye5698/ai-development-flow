import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_LEVELS,
  buildAuthorityReceiptBinding,
  computeAuthorityReceiptDigest,
  computeEvidenceBundleDigest,
  computeVerificationResultDigest,
  digestJson,
  evaluateEvidenceFreshness,
  validateAuthorityReceipts,
  validateVerificationResultEvidence
} from "../src/core/index.mjs";
import {
  WorkflowError,
  evaluateSealedEvidenceFreshness,
  sealEvidenceBundle
} from "../src/workflow/index.mjs";

const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const BASE_REVISION = "a".repeat(40);

function sealInputs() {
  const taskPacket = {
    schemaVersion: 2,
    taskId: "TASK-V2",
    baselineId: "BASELINE-V2",
    specDigest: DIGEST("a"),
    controlDigest: DIGEST("b"),
    baseRevision: BASE_REVISION,
    verification: {
      verifierIds: [],
      tier: "quick",
      requiredEvidenceLevel: "specification",
      requiredAuthorityKinds: []
    }
  };
  const taskPacketDigest = digestJson(taskPacket);
  const subjectContent = {
    baseRevision: BASE_REVISION,
    entries: [],
    subjectContentDigest: digestJson({ baseRevision: BASE_REVISION, entries: [] })
  };
  const runRecord = {
    schemaVersion: 2,
    frameworkVersion: "0.2.0",
    runId: "RUN-V2",
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    state: "reviewing",
    expectedTaskDigest: taskPacketDigest,
    taskPacketDigest,
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest: subjectContent.subjectContentDigest,
    subjectRevision: "subject-v2",
    worktreeDigest: DIGEST("c"),
    implementerContextId: "implementer-v2",
    reviewerContextIds: ["reviewer-v2"],
    verificationResultRefs: [],
    verificationResultDigests: []
  };
  const manifest = {
    schemaVersion: 2,
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    taskPacketDigest,
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest: subjectContent.subjectContentDigest,
    subjectRevision: runRecord.subjectRevision
  };
  return {
    frameworkVersion: "0.2.0",
    bundleId: "BUNDLE-V2",
    createdAt: "2026-08-30T00:00:00Z",
    runRecord,
    taskPacket,
    baseline: {
      baselineId: taskPacket.baselineId,
      canonicalSpecSourceId: "SPEC-V2",
      truthSources: [{ sourceId: "SPEC-V2", path: "docs/framework-spec.md" }]
    },
    projectConfig: { automationPolicy: {} },
    contextManifest: { ...manifest, manifestDigest: digestJson(manifest) },
    verificationResults: [],
    reviewReports: [],
    authorityReceipts: [],
    verifierDefinitionDigests: {},
    verifierInputDigests: {},
    subjectContent,
    actualImpact: {
      changedPaths: [],
      matchedImpactRuleIds: [],
      requirementIds: [],
      acceptanceIds: [],
      verifierIds: []
    }
  };
}

function assertWorkflowCode(callback, code) {
  assert.throws(callback, (error) => error instanceof WorkflowError && error.code === code);
}

function withSubjectEntries(inputs, entries, changedPaths = entries.map((entry) => entry.path)) {
  const subjectContentDigest = digestJson({ baseRevision: BASE_REVISION, entries });
  const contextBody = {
    ...inputs.contextManifest,
    subjectContentDigest
  };
  delete contextBody.manifestDigest;
  return {
    ...inputs,
    runRecord: { ...inputs.runRecord, subjectContentDigest },
    contextManifest: { ...contextBody, manifestDigest: digestJson(contextBody) },
    subjectContent: { baseRevision: BASE_REVISION, entries, subjectContentDigest },
    actualImpact: { ...inputs.actualImpact, changedPaths }
  };
}

function freshnessInputs() {
  const baseline = { schemaVersion: 1, baselineId: "BASELINE-FRESH" };
  const taskPacket = {
    schemaVersion: 2,
    baselineId: baseline.baselineId,
    specDigest: DIGEST("4"),
    controlDigest: DIGEST("5"),
    taskId: "TASK-FRESH"
  };
  const taskPacketDigest = digestJson(taskPacket);
  const contextBody = {
    schemaVersion: 2,
    taskId: taskPacket.taskId,
    taskPacketDigest,
    controlDigest: taskPacket.controlDigest
  };
  const contextManifestDigest = digestJson(contextBody);
  const contextManifest = { ...contextBody, manifestDigest: contextManifestDigest };
  const subjectContentDigest = DIGEST("6");
  const bundle = {
    schemaVersion: 2,
    frameworkVersion: "0.2.0",
    baselineId: baseline.baselineId,
    baselineDigest: digestJson(baseline),
    specDigest: taskPacket.specDigest,
    expectedTaskDigest: taskPacketDigest,
    taskPacketDigest,
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest,
    contextManifestDigest,
    verifierEvidence: [],
    verificationResultDigests: [],
    reviewEvidence: [],
    authorityReceiptRefs: [],
    authorityReceipts: [],
    levels: EVIDENCE_LEVELS.map((level) => ({
      level,
      status: level === "specification" ? "pass" : "not_claimed"
    })),
    declaredMaximumLevel: "specification"
  };
  bundle.bundleDigest = computeEvidenceBundleDigest(bundle);
  return {
    bundle,
    coreCurrent: {
      baselineId: baseline.baselineId,
      specDigest: taskPacket.specDigest,
      expectedTaskDigest: taskPacketDigest,
      taskPacketDigest,
      controlDigest: taskPacket.controlDigest,
      subjectContentDigest,
      contextManifestDigest,
      verifierDefinitionDigests: {},
      verifierInputDigests: {}
    },
    sealedCurrent: {
      frameworkVersion: bundle.frameworkVersion,
      baseline,
      taskPacket,
      subjectContentDigest,
      contextManifest,
      verificationResults: [],
      reviewReports: [],
      authorityReceipts: [],
      verifierDefinitionDigests: {},
      verifierInputDigests: {}
    }
  };
}

test("verification evidence rejects every non-v2 result", () => {
  const result = {
    schemaVersion: 1,
    verifierId: "VERIFY-V2",
    evidenceLevel: "contract",
    requiredTier: "quick",
    executedTier: "quick",
    status: "pass",
    complete: true
  };
  result.resultDigest = computeVerificationResultDigest(result);
  const inspection = validateVerificationResultEvidence(result);
  assert.equal(inspection.valid, false);
  assert.ok(inspection.errors.some((entry) => entry.code === "VERIFICATION_SCHEMA_VERSION_UNSUPPORTED"));

  const v2 = { ...result, schemaVersion: 2 };
  v2.resultDigest = computeVerificationResultDigest(v2);
  assert.equal(validateVerificationResultEvidence(v2).valid, true);
});

test("authority bindings have no expectedTaskDigest fallback and receipts always require full v2 bindings", () => {
  const expectedTaskDigest = DIGEST("d");
  const binding = buildAuthorityReceiptBinding({ expectedTaskDigest });
  assert.equal(Object.hasOwn(binding, "taskPacketDigest"), false);

  const expected = {
    taskId: "TASK-V2",
    taskPacketDigest: expectedTaskDigest,
    expectedTaskDigest,
    specDigest: DIGEST("e"),
    controlDigest: DIGEST("f"),
    subjectContentDigest: DIGEST("1"),
    baselineDigest: DIGEST("2"),
    subjectRevision: "subject-v2",
    worktreeDigest: DIGEST("3"),
    verificationResultDigests: [],
    reviewReportDigests: [],
    verificationCompletedAt: [],
    reviewCreatedAt: [],
    participantContextIds: [],
    lowerEvidenceComplete: true
  };
  const receipt = {
    schemaVersion: 1,
    receiptId: "OWNER-V1",
    kind: "owner_acceptance",
    actorType: "human",
    actorRef: "owner-v1",
    taskId: expected.taskId,
    taskPacketDigest: expected.taskPacketDigest,
    expectedTaskDigest: expected.expectedTaskDigest,
    specDigest: expected.specDigest,
    baselineDigest: expected.baselineDigest,
    subjectRevision: expected.subjectRevision,
    worktreeDigest: expected.worktreeDigest,
    verificationResultDigests: [],
    reviewReportDigests: [],
    issuedAt: "2026-08-30T00:00:00Z",
    reference: "authority://owner-v1"
  };
  receipt.receiptDigest = computeAuthorityReceiptDigest(receipt);
  const validation = validateAuthorityReceipts([receipt], expected);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.code === "AUTHORITY_RECEIPT_SCHEMA_VERSION_UNSUPPORTED"));
  assert.ok(validation.errors.some((entry) => entry.code === "AUTHORITY_RECEIPT_FIELD_MISSING" && entry.field === "controlDigest"));
  assert.ok(validation.errors.some((entry) => entry.code === "AUTHORITY_RECEIPT_FIELD_MISSING" && entry.field === "subjectContentDigest"));
});

test("evidence sealing requires explicit subject content and actual impact", () => {
  const inputs = sealInputs();
  assertWorkflowCode(() => sealEvidenceBundle({ ...inputs, subjectContent: undefined }), "evidence_input_invalid");
  assertWorkflowCode(() => sealEvidenceBundle({ ...inputs, actualImpact: undefined }), "evidence_input_invalid");
});

test("evidence sealing recomputes the canonical subject content digest", () => {
  const inputs = sealInputs();
  const forgedDigest = DIGEST("9");
  assertWorkflowCode(() => sealEvidenceBundle({
    ...inputs,
    runRecord: { ...inputs.runRecord, subjectContentDigest: forgedDigest },
    contextManifest: { ...inputs.contextManifest, subjectContentDigest: forgedDigest },
    subjectContent: { ...inputs.subjectContent, subjectContentDigest: forgedDigest }
  }), "evidence_subject_content_digest_invalid");
});

test("evidence sealing rejects non-v2 run, task, context, result, report, and receipt artifacts", () => {
  const inputs = sealInputs();
  for (const field of ["runRecord", "taskPacket", "contextManifest"]) {
    assertWorkflowCode(() => sealEvidenceBundle({
      ...inputs,
      [field]: { ...inputs[field], schemaVersion: 1 }
    }), "evidence_schema_version_invalid");
  }

  const result = { schemaVersion: 1, resultId: "RESULT-V1" };
  result.resultDigest = computeVerificationResultDigest(result);
  assertWorkflowCode(() => sealEvidenceBundle({
    ...inputs,
    verificationResults: [{ reference: "results/v1.json", result }]
  }), "evidence_schema_version_invalid");
  assertWorkflowCode(() => sealEvidenceBundle({
    ...inputs,
    reviewReports: [{ reference: "reviews/v1.json", report: { schemaVersion: 1, reportId: "REPORT-V1" } }]
  }), "evidence_schema_version_invalid");
  assertWorkflowCode(() => sealEvidenceBundle({
    ...inputs,
    authorityReceipts: [{
      reference: "authority/v1.json",
      receipt: { schemaVersion: 1, receiptId: "RECEIPT-V1" }
    }]
  }), "evidence_schema_version_invalid");
});

test("evidence sealing requires unique path-sorted subject entries and the exact changed path set", () => {
  const inputs = sealInputs();
  const first = { path: "src/a.mjs", type: "file", mode: "100644", contentDigest: DIGEST("a") };
  const second = { path: "src/b.mjs", type: "file", mode: "100644", contentDigest: DIGEST("b") };
  assertWorkflowCode(
    () => sealEvidenceBundle(withSubjectEntries(inputs, [second, first])),
    "evidence_subject_entries_unsorted"
  );
  assertWorkflowCode(
    () => sealEvidenceBundle(withSubjectEntries(inputs, [first, { ...second, path: first.path }], [first.path])),
    "evidence_subject_entries_duplicate"
  );
  assertWorkflowCode(
    () => sealEvidenceBundle(withSubjectEntries(inputs, [first], [])),
    "evidence_actual_impact_paths_mismatch"
  );
  assertWorkflowCode(
    () => sealEvidenceBundle(withSubjectEntries(inputs, [first], [first.path, first.path])),
    "evidence_actual_impact_paths_mismatch"
  );
});

test("evidence sealing prevents actual impact IDs from exceeding TaskPacket declarations", () => {
  const inputs = sealInputs();
  for (const [field, value] of [
    ["requirementIds", "REQ-EXTRA"],
    ["acceptanceIds", "ACC-EXTRA"],
    ["verifierIds", "VERIFY-EXTRA"]
  ]) {
    assert.throws(
      () => sealEvidenceBundle({
        ...inputs,
        actualImpact: { ...inputs.actualImpact, [field]: [value] }
      }),
      (error) => error instanceof WorkflowError
        && error.code === "evidence_actual_impact_expanded"
        && error.details.field === field
    );
  }
});

test("core freshness requires every v2 binding and verifies bundle integrity without revision fallbacks", () => {
  const { bundle, coreCurrent } = freshnessInputs();
  assert.equal(evaluateEvidenceFreshness(bundle, coreCurrent).fresh, true);

  for (const field of [
    "baselineId",
    "specDigest",
    "expectedTaskDigest",
    "taskPacketDigest",
    "controlDigest",
    "subjectContentDigest",
    "contextManifestDigest",
    "verifierDefinitionDigests",
    "verifierInputDigests"
  ]) {
    const incomplete = { ...coreCurrent };
    delete incomplete[field];
    const result = evaluateEvidenceFreshness(bundle, incomplete);
    assert.equal(result.fresh, false, field);
    assert.ok(result.reasons.some((entry) => entry.code === "EVIDENCE_CURRENT_BINDING_MISSING" && entry.field === field), field);
  }

  const legacy = { ...bundle, schemaVersion: 1 };
  legacy.bundleDigest = computeEvidenceBundleDigest(legacy);
  assert.ok(evaluateEvidenceFreshness(legacy, coreCurrent).reasons.some(
    (entry) => entry.code === "EVIDENCE_BUNDLE_SCHEMA_VERSION_UNSUPPORTED"
  ));

  const tampered = { ...bundle, specDigest: DIGEST("7") };
  assert.ok(evaluateEvidenceFreshness(tampered, coreCurrent).reasons.some(
    (entry) => entry.code === "EVIDENCE_BUNDLE_DIGEST_INVALID"
  ));

  const withVerifier = structuredClone(bundle);
  withVerifier.verifierEvidence = [{
    verifierId: "VERIFY-FRESH",
    resultId: "RESULT-FRESH",
    resultDigest: DIGEST("8"),
    definitionDigest: DIGEST("9"),
    inputDigest: DIGEST("0"),
    level: "contract",
    status: "fail",
    complete: true
  }];
  withVerifier.verificationResultDigests = [{ resultId: "RESULT-FRESH", resultDigest: DIGEST("8") }];
  withVerifier.bundleDigest = computeEvidenceBundleDigest(withVerifier);
  const missingVerifierDigests = evaluateEvidenceFreshness(withVerifier, coreCurrent);
  assert.ok(missingVerifierDigests.reasons.some((entry) => entry.code === "EVIDENCE_VERIFIER_DEFINITION_CURRENT_MISSING"));
  assert.ok(missingVerifierDigests.reasons.some((entry) => entry.code === "EVIDENCE_VERIFIER_INPUT_CURRENT_MISSING"));

  assert.equal(evaluateEvidenceFreshness(bundle, {
    ...coreCurrent,
    subjectRevision: "different-revision",
    worktreeDigest: DIGEST("8")
  }).fresh, true);
});

test("sealed freshness fails closed when any current artifact or digest set is omitted", () => {
  const { bundle, sealedCurrent } = freshnessInputs();
  assert.equal(evaluateSealedEvidenceFreshness(bundle, sealedCurrent).fresh, true);
  for (const field of [
    "frameworkVersion",
    "baseline",
    "taskPacket",
    "subjectContentDigest",
    "contextManifest",
    "verificationResults",
    "reviewReports",
    "authorityReceipts",
    "verifierDefinitionDigests",
    "verifierInputDigests"
  ]) {
    const incomplete = { ...sealedCurrent };
    delete incomplete[field];
    const result = evaluateSealedEvidenceFreshness(bundle, incomplete);
    assert.equal(result.fresh, false, field);
    assert.ok(result.reasons.some((entry) => entry.code === "EVIDENCE_CURRENT_INPUT_MISSING" && entry.field === field), field);
  }
});
