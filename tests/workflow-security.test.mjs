import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildAuthorityReceiptBinding,
  computeAuthorityReceiptDigest,
  computeEvidenceBundleDigest,
  computeVerificationResultDigest,
  digestJson,
  normalizeRepoPath,
  pathMatchesPattern,
  validateAuthorityReceipts,
  validateSchema,
  validateScope
} from "../src/core/index.mjs";
import {
  adjudicateWorkflowCycle,
  computeReviewContextDigest,
  createRunRecord,
  evaluateSealedEvidenceFreshness,
  sealEvidenceBundle,
  transitionRun
} from "../src/workflow/index.mjs";

const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const SPEC_DIGEST = DIGEST("a");
const WORKTREE_DIGEST = DIGEST("f");
const SPEC_INDEX_DIGEST = DIGEST("7");
const BASE_REVISION = "a".repeat(40);
const SUBJECT_CONTENT_DIGEST = digestJson({ baseRevision: BASE_REVISION, entries: [] });
const BASELINE = {
  schemaVersion: 1,
  baselineId: "BASELINE-SEC",
  status: "active",
  createdAt: "2026-08-27T00:00:00Z",
  canonicalSpecSourceId: "SPEC-SEC",
  truthSources: [{
    sourceId: "SPEC-SEC",
    path: "docs/product-spec.md",
    role: "product_content_truth",
    authority: "canonical",
    digest: SPEC_DIGEST
  }],
  knownConflicts: [],
  decisionRegister: "ai-dev/decisions/register.json"
};
const PROJECT_CONFIG = {
  automationPolicy: {
    maxRepairRounds: 2,
    freshReviewContextRequired: true,
    implementerCannotReviewOwnTask: true,
    stopConditions: ["unresolved_decision", "truth_source_conflict", "side_effect_requires_approval", "repair_round_limit"]
  }
};

function taskPacket({ requiredEvidenceLevel = "contract", tier = "quick", verifiers } = {}) {
  const verifierIds = verifiers?.map((entry) => entry.id) ?? ["V-CONTRACT"];
  const truthBinding = {
    components: [{ componentId: "baseline", path: "ai-dev/baseline.json", digest: digestJson(BASELINE) }],
  };
  const controlBinding = {
    components: [{ componentId: "project_config", path: "ai-flow.config.json", digest: digestJson(PROJECT_CONFIG) }],
    assetPolicyDigest: DIGEST("6"),
    instructionChainDigest: digestJson([]),
  };
  return {
    schemaVersion: 2,
    baselineId: BASELINE.baselineId,
    specDigest: SPEC_DIGEST,
    specIndexDigest: SPEC_INDEX_DIGEST,
    truthDigest: digestJson(truthBinding.components),
    controlDigest: digestJson(controlBinding),
    truthBinding,
    controlBinding,
    baseRevision: BASE_REVISION,
    taskId: "TASK-SEC",
    stageId: "STAGE-SEC",
    taskKind: "implementation",
    goal: "Exercise evidence authority boundaries",
    requirementIds: ["REQ-SEC"],
    acceptanceIds: ["ACC-SEC"],
    derivation: {
      directRequirementIds: ["REQ-SEC"],
      impactedRequirementIds: [],
      globalInvariantIds: [],
      blockingDecisionIds: [],
      evidenceTargetDecisionIds: [],
      stageGate: {
        stageId: "STAGE-SEC",
        title: "Security evidence stage",
        status: "authorized",
        blockingDecisionIds: [],
        authorizationBoundary: "local test only",
        evidenceRequired: [requiredEvidenceLevel],
        stageGateDigest: DIGEST("5"),
      }
    },
    routing: { capability: "high_reasoning" },
    decisionDependencies: [],
    constraints: [],
    scope: {
      allowedPaths: ["src/app/**"],
      subjectPaths: ["src/app/**"],
      forbiddenPaths: ["AGENTS.md", "ai-dev/**", "schemas/**"]
    },
    assets: {
      allowedWriteClasses: ["managed_implementation"],
      classifiedWrites: [{ path: "src/app/service.mjs", assetClass: "managed_implementation" }],
      declaredScope: [{ pattern: "src/app/**", assetClasses: ["managed_implementation"] }],
    },
    review: {
      profileId: "default",
      mandatoryLensIds: ["evidence", "scope", "spec_conformance"],
      requestedLensIds: ["evidence", "scope", "spec_conformance"],
    },
    capabilities: [{ capabilityId: "repository_read" }, { capabilityId: "repository_write" }],
    verification: {
      verifierIds,
      tier,
      requiredEvidenceLevel,
      requiredAuthorityKinds: requiredEvidenceLevel === "production"
        ? ["owner_acceptance", "production_release"]
        : requiredEvidenceLevel === "owner"
          ? ["owner_acceptance"]
          : []
    },
    risk: { level: "low", domains: ["general"], sideEffects: [] },
    repairPolicy: {
      maxRounds: 2,
      allowedPathsOnly: true,
      allowedWriteClasses: ["managed_implementation"]
    }
  };
}

function resultFor(task, { id, verifierId, level, status = "pass", complete = true, requiredTier, executedTier } = {}) {
  const value = {
    schemaVersion: 2,
    resultId: id,
    verifierId,
    taskId: task.taskId,
    baselineId: task.baselineId,
    specDigest: task.specDigest,
    expectedTaskDigest: digestJson(task),
    taskPacketDigest: digestJson(task),
    controlDigest: task.controlDigest,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    subjectRevision: "revision-full-001",
    worktreeDigest: WORKTREE_DIGEST,
    definitionDigest: digestJson({ verifierId, level }),
    inputDigest: digestJson({ verifierId, revision: "revision-full-001" }),
    startedAt: "2026-08-27T00:03:00Z",
    completedAt: "2026-08-27T00:03:01Z",
    durationMs: 1000,
    status,
    complete,
    requiredTier: requiredTier ?? task.verification.tier,
    executedTier: executedTier ?? task.verification.tier,
    exitCode: status === "pass" ? 0 : 1,
    cacheHit: false,
    evidenceLevel: level,
    outputDigest: digestJson({ verifierId, status }),
    summary: status,
    artifactRefs: [],
    sideEffect: { occurred: false, authorized: false }
  };
  value.resultDigest = computeVerificationResultDigest(value);
  return value;
}

function entriesFor(results) {
  return results.map((result) => ({
    reference: `ai-dev/results/${result.resultId}.json`,
    result
  }));
}

function runFor(task, results) {
  const entries = entriesFor(results);
  let run = createRunRecord({
    frameworkVersion: "0.2.0",
    runId: "RUN-SEC",
    taskPacket: task,
    taskPacketRef: `ai-dev/tasks/${task.taskId}.json`,
    subjectRevision: "revision-full-001",
    worktreeDigest: WORKTREE_DIGEST,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    controlDigest: task.controlDigest,
    startedAt: "2026-08-27T00:00:00Z",
    contextManifestRef: "ai-dev/contexts/CTX-SEC.json",
    workspace: { kind: "worktree", identifier: "/virtual/worktrees/RUN-SEC" },
    worktreeIdentityDigest: DIGEST("8"),
    briefRefs: {
      agent: ".ai-flow/generated/briefs/RUN-SEC-agent.md",
      human: ".ai-flow/generated/briefs/RUN-SEC-human.md",
    },
  });
  run = transitionRun(run, { to: "ready", at: "2026-08-27T00:01:00Z", reason: "ready", actorRole: "controller" });
  run = transitionRun(run, {
    to: "implementing",
    at: "2026-08-27T00:02:00Z",
    reason: "implement",
    actorRole: "implementer",
    contextId: "implementer-sec"
  });
  run = transitionRun(run, { to: "verifying", at: "2026-08-27T00:03:00Z", reason: "verify", actorRole: "implementer" });
  return transitionRun(run, {
    to: "reviewing",
    at: "2026-08-27T00:04:00Z",
    reason: "review",
    actorRole: "controller",
    contextId: "reviewer-sec",
    verificationResultRefs: entries.map((entry) => entry.reference),
    verificationResultDigests: results.map((result) => ({ resultId: result.resultId, resultDigest: result.resultDigest }))
  });
}

function reviewFor(task, results, overrides = {}) {
  const entries = entriesFor(results);
  const reviewContextId = overrides.reviewContextId ?? "reviewer-sec";
  const subjectRevision = "revision-full-001";
  return {
    schemaVersion: 2,
    reportId: "RR-SEC",
    taskId: task.taskId,
    baselineId: task.baselineId,
    specDigest: task.specDigest,
    taskPacketDigest: digestJson(task),
    controlDigest: task.controlDigest,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    subjectRevision,
    reviewRound: 0,
    implementerContextId: "implementer-sec",
    reviewContextId,
    contextDigest: computeReviewContextDigest({
      reviewContextId,
      subjectRevision,
      subjectContentDigest: SUBJECT_CONTENT_DIGEST,
      taskPacketDigest: digestJson(task),
      controlDigest: task.controlDigest,
      verificationResults: entries,
    }),
    createdAt: "2026-08-27T00:04:30Z",
    verdict: "pass",
    verificationResultRefs: entries.map((entry) => entry.reference),
    verificationResultDigests: results.map((result) => ({ resultId: result.resultId, resultDigest: result.resultDigest })),
    evidence: [
      { level: "specification", status: "pass", reference: "review-only:specification" },
      { level: "contract", status: "pass", reference: "review-only:contract" },
      { level: "runtime_stub", status: "pass", reference: "review-only:runtime_stub" },
      { level: "target_integration", status: "pass", reference: "review-only:target_integration" },
      { level: "owner", status: "pass", reference: "review-only:owner" },
      { level: "production", status: "pass", reference: "review-only:production" }
    ],
    findings: [],
    blockingDecisionIds: [],
    profileId: "default",
    lensCoverage: [
      { lensId: "evidence", status: "covered" },
      { lensId: "scope", status: "covered" },
      { lensId: "spec_conformance", status: "covered" },
    ],
    summary: "Review citations are not authority",
    ...overrides
  };
}

function contextFor(task) {
  const body = {
    schemaVersion: 2,
    manifestId: "CTX-SEC",
    taskId: task.taskId,
    baselineId: task.baselineId,
    specDigest: task.specDigest,
    specIndexDigest: task.specIndexDigest,
    taskPacketDigest: digestJson(task),
    controlDigest: task.controlDigest,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    subjectRevision: "revision-full-001",
    stageId: task.stageId,
    taskKind: task.taskKind,
    stageGate: task.derivation.stageGate,
    createdAt: "2026-08-27T00:03:30Z",
    items: [{
      kind: "spec_excerpt",
      path: "docs/product-spec.md",
      digest: SPEC_DIGEST,
      reason: "security requirement",
      required: true
    }],
    exclusions: []
  };
  return { ...body, manifestDigest: digestJson(body) };
}

function sealInputs(task, results, receipts = [], review = reviewFor(task, results)) {
  const entries = entriesFor(results);
  return {
    frameworkVersion: "0.2.0",
    bundleId: "EV-SEC",
    createdAt: "2026-08-27T00:07:00Z",
    runRecord: runFor(task, results),
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    contextManifest: contextFor(task),
    verificationResults: entries,
    reviewReports: [{ reference: "ai-dev/reviews/RR-SEC.json", report: review }],
    authorityReceipts: receipts,
    verifierDefinitionDigests: Object.fromEntries(results.map((result) => [result.verifierId, result.definitionDigest])),
    verifierInputDigests: Object.fromEntries(results.map((result) => [result.verifierId, result.inputDigest])),
    subjectContent: {
      baseRevision: task.baseRevision,
      entries: [],
      subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    },
    actualImpact: {
      changedPaths: [],
      matchedImpactRuleIds: [],
      requirementIds: task.requirementIds,
      acceptanceIds: task.acceptanceIds,
      verifierIds: task.verification.verifierIds,
    },
  };
}


function signedReceipt(value) {
  const receipt = structuredClone(value);
  delete receipt.receiptDigest;
  receipt.receiptDigest = computeAuthorityReceiptDigest(receipt);
  return receipt;
}

function authorityFixture(task, results, review = reviewFor(task, results), overrides = {}) {
  const taskDigest = digestJson(task);
  const binding = buildAuthorityReceiptBinding({
    taskId: task.taskId,
    baselineId: task.baselineId,
    taskPacketDigest: taskDigest,
    expectedTaskDigest: taskDigest,
    specDigest: task.specDigest,
    controlDigest: task.controlDigest,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    baselineDigest: digestJson(BASELINE),
    subjectRevision: "revision-full-001",
    worktreeDigest: WORKTREE_DIGEST,
    requiredTier: task.verification.tier
  }, {
    verificationResults: results,
    reviewReports: [review],
    participantContextIds: ["implementer-sec", "reviewer-sec"]
  });
  const common = {
    schemaVersion: 2,
    taskId: binding.taskId,
    taskPacketDigest: binding.taskPacketDigest,
    expectedTaskDigest: binding.expectedTaskDigest,
    specDigest: binding.specDigest,
    controlDigest: binding.controlDigest,
    subjectContentDigest: binding.subjectContentDigest,
    baselineDigest: binding.baselineDigest,
    subjectRevision: binding.subjectRevision,
    worktreeDigest: binding.worktreeDigest,
    verificationResultDigests: structuredClone(binding.verificationResultDigests),
    reviewReportDigests: structuredClone(binding.reviewReportDigests)
  };
  const owner = signedReceipt({
    receiptId: "AUTH-OWNER",
    kind: "owner_acceptance",
    actorType: "human",
    actorRef: overrides.ownerActorRef ?? "owner-sec",
    ...common,
    issuedAt: overrides.ownerIssuedAt ?? "2026-08-27T00:05:00Z",
    reference: "authority/owner-acceptance"
  });
  const production = signedReceipt({
    receiptId: "AUTH-PROD",
    kind: "production_release",
    actorType: "external_system",
    actorRef: overrides.productionActorRef ?? "release-system",
    ...common,
    priorOwnerReceiptDigest: owner.receiptDigest,
    issuedAt: overrides.productionIssuedAt ?? "2026-08-27T00:06:00Z",
    reference: "authority/production-release"
  });
  return {
    binding,
    owner,
    production,
    entries: [
      { reference: "ai-dev/authority/AUTH-OWNER.json", receipt: owner },
      { reference: "ai-dev/authority/AUTH-PROD.json", receipt: production }
    ]
  };
}

test("ordinary verifier contracts and results cannot claim Owner or production", () => {
  const registrySchema = JSON.parse(fs.readFileSync(new URL("../schemas/verifier-registry.schema.json", import.meta.url), "utf8"));
  const resultSchema = JSON.parse(fs.readFileSync(new URL("../schemas/verification-result.schema.json", import.meta.url), "utf8"));
  const forbiddenDefinition = {
    schemaVersion: 1,
    registryId: "REG-SEC",
    verifiers: [{
      verifierId: "V-PROD",
      tier: "quick",
      command: "node",
      args: [],
      workingDirectory: "src",
      timeoutMs: 1000,
      evidenceLevel: "production",
      deterministic: true,
      inputPatterns: ["src/**"],
      triggers: { requirementIds: [], acceptanceIds: [], pathPatterns: [], riskDomains: [], alwaysRun: true },
      sideEffect: { kind: "none", requiresApproval: false }
    }],
    globalInvariantVerifierIds: []
  };
  assert.ok(validateSchema(forbiddenDefinition, registrySchema).some((entry) => entry.path.endsWith(".evidenceLevel")));

  const task = taskPacket();
  const forged = resultFor(task, { id: "VR-PROD", verifierId: "V-CONTRACT", level: "production" });
  assert.ok(validateSchema(forged, resultSchema).some((entry) => entry.path === "$.evidenceLevel"));
  const decision = adjudicateWorkflowCycle({
    runRecord: runFor(task, [forged]),
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: entriesFor([forged]),
    reviewReports: [reviewFor(task, [forged])]
  });
  assert.equal(decision.decision, "escalate");
  assert.ok(decision.reasons.some((entry) => entry.code === "VERIFICATION_EVIDENCE_LEVEL_FORBIDDEN"));
});

test("review citations never promote machine evidence and incomplete deep runs cannot pass", () => {
  const task = taskPacket();
  const contract = resultFor(task, { id: "VR-CONTRACT", verifierId: "V-CONTRACT", level: "contract" });
  const decision = adjudicateWorkflowCycle({
    runRecord: runFor(task, [contract]),
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: entriesFor([contract]),
    reviewReports: [reviewFor(task, [contract])]
  });
  assert.equal(decision.decision, "accept");
  assert.equal(decision.evidenceLevel, "contract");

  const deepTask = taskPacket({ tier: "deep" });
  const partial = resultFor(deepTask, {
    id: "VR-PARTIAL",
    verifierId: "V-CONTRACT",
    level: "contract",
    status: "partial",
    complete: false,
    requiredTier: "deep",
    executedTier: "quick"
  });
  const incomplete = adjudicateWorkflowCycle({
    runRecord: runFor(deepTask, [partial]),
    taskPacket: deepTask,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: entriesFor([partial]),
    reviewReports: [reviewFor(deepTask, [partial])]
  });
  assert.equal(incomplete.decision, "verify");
});

test("only exact time-ordered Owner and production receipts reach production", () => {
  const verifierDefinitions = [
    { id: "V-CONTRACT", level: "contract" },
    { id: "V-STUB", level: "runtime_stub" },
    { id: "V-TARGET", level: "target_integration" }
  ];
  const task = taskPacket({ requiredEvidenceLevel: "production", verifiers: verifierDefinitions });
  const results = verifierDefinitions.map((entry, index) => resultFor(task, {
    id: `VR-${index + 1}`,
    verifierId: entry.id,
    level: entry.level
  }));
  const review = reviewFor(task, results);
  const authority = authorityFixture(task, results, review);
  const validationContext = { ...authority.binding, lowerEvidenceComplete: true };
  const authoritySchema = JSON.parse(fs.readFileSync(new URL("../schemas/authority-receipt.schema.json", import.meta.url), "utf8"));

  assert.deepEqual(validateSchema(authority.owner, authoritySchema), []);
  assert.deepEqual(validateSchema(authority.production, authoritySchema), []);
  assert.equal(validateAuthorityReceipts([authority.owner, authority.production], validationContext).valid, true);

  const productionOnly = validateAuthorityReceipts([authority.production], validationContext);
  assert.equal(productionOnly.valid, false);
  assert.ok(productionOnly.errors.some((entry) => entry.code === "PRODUCTION_OWNER_RECEIPT_MISSING"));

  const crossTask = validateAuthorityReceipts([authority.owner, authority.production], {
    ...validationContext,
    taskId: "TASK-OTHER"
  });
  assert.equal(crossTask.valid, false);
  assert.ok(crossTask.errors.some((entry) => entry.code === "AUTHORITY_RECEIPT_BINDING_MISMATCH" && entry.field === "taskId"));

  const premature = authorityFixture(task, results, review, { ownerIssuedAt: review.createdAt });
  const prematureValidation = validateAuthorityReceipts(
    [premature.owner, premature.production],
    { ...premature.binding, lowerEvidenceComplete: true }
  );
  assert.equal(prematureValidation.valid, false);
  assert.ok(prematureValidation.errors.some((entry) => entry.code === "OWNER_RECEIPT_PREMATURE"));

  const reverseOrder = authorityFixture(task, results, review, {
    ownerIssuedAt: "2026-08-27T00:06:00Z",
    productionIssuedAt: "2026-08-27T00:05:30Z"
  });
  const reverseValidation = validateAuthorityReceipts(
    [reverseOrder.owner, reverseOrder.production],
    { ...reverseOrder.binding, lowerEvidenceComplete: true }
  );
  assert.equal(reverseValidation.valid, false);
  assert.ok(reverseValidation.errors.some((entry) => entry.code === "PRODUCTION_RECEIPT_PREMATURE"));

  const missingResultOwner = signedReceipt({
    ...authority.owner,
    verificationResultDigests: authority.owner.verificationResultDigests.slice(1)
  });
  const extraReviewOwner = signedReceipt({
    ...authority.owner,
    reviewReportDigests: [
      ...authority.owner.reviewReportDigests,
      {
        reportId: "RR-EXTRA",
        reportDigest: DIGEST("9"),
        implementerContextId: "implementer-other",
        reviewContextId: "reviewer-other",
        contextDigest: DIGEST("8")
      }
    ]
  });
  for (const receipt of [missingResultOwner, extraReviewOwner]) {
    const inspection = validateAuthorityReceipts([receipt], validationContext);
    assert.equal(inspection.valid, false);
    assert.ok(inspection.errors.some((entry) => entry.code === "AUTHORITY_RECEIPT_BINDING_SET_MISMATCH"));
  }

  const oldWorktreeOwner = signedReceipt({ ...authority.owner, worktreeDigest: DIGEST("7") });
  assert.ok(validateAuthorityReceipts([oldWorktreeOwner], validationContext).errors.some(
    (entry) => entry.code === "AUTHORITY_RECEIPT_BINDING_MISMATCH" && entry.field === "worktreeDigest"
  ));
  const tamperedDigest = { ...authority.owner, actorRef: "different-owner" };
  assert.ok(validateAuthorityReceipts([tamperedDigest], validationContext).errors.some(
    (entry) => entry.code === "AUTHORITY_RECEIPT_DIGEST_INVALID"
  ));

  const conflictedOwner = signedReceipt({ ...authority.owner, actorRef: "reviewer-sec" });
  const conflictedProduction = signedReceipt({
    ...authority.production,
    priorOwnerReceiptDigest: conflictedOwner.receiptDigest
  });
  assert.throws(
    () => sealEvidenceBundle(sealInputs(task, results, [
      { ...authority.entries[0], receipt: conflictedOwner },
      { ...authority.entries[1], receipt: conflictedProduction }
    ], review)),
    (error) => error.code === "evidence_not_acceptable"
  );

  assert.throws(
    () => sealEvidenceBundle(sealInputs(task, results, [authority.entries[1]], review)),
    (error) => ["evidence_authority_required", "evidence_not_acceptable"].includes(error.code)
  );

  const inputs = sealInputs(task, results, authority.entries, review);
  const bundle = sealEvidenceBundle(inputs);
  assert.equal(bundle.declaredMaximumLevel, "production");
  assert.equal(bundle.authorityReceipts.length, 2);
  assert.deepEqual(bundle.authorityReceiptRefs, authority.entries.map((entry) => entry.reference));
  assert.equal(evaluateSealedEvidenceFreshness(bundle, {
    frameworkVersion: "0.2.0",
    baseline: BASELINE,
    taskPacket: task,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    contextManifest: inputs.contextManifest,
    verificationResults: inputs.verificationResults,
    verifierDefinitionDigests: inputs.verifierDefinitionDigests,
    verifierInputDigests: inputs.verifierInputDigests,
    reviewReports: inputs.reviewReports,
    authorityReceipts: authority.entries
  }).fresh, true);

  const forged = structuredClone(bundle);
  forged.authorityReceipts[0] = signedReceipt({ ...forged.authorityReceipts[0], taskId: "TASK-OTHER" });
  forged.authorityReceipts[1] = signedReceipt({
    ...forged.authorityReceipts[1],
    taskId: "TASK-OTHER",
    priorOwnerReceiptDigest: forged.authorityReceipts[0].receiptDigest
  });
  forged.bundleDigest = computeEvidenceBundleDigest(forged);
  const forgedFreshness = evaluateSealedEvidenceFreshness(forged, {
    frameworkVersion: "0.2.0",
    baseline: BASELINE,
    taskPacket: task,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    contextManifest: inputs.contextManifest,
    verificationResults: inputs.verificationResults,
    verifierDefinitionDigests: inputs.verifierDefinitionDigests,
    verifierInputDigests: inputs.verifierInputDigests,
    reviewReports: inputs.reviewReports,
    authorityReceipts: authority.entries,
  });
  assert.equal(forgedFreshness.fresh, false);
  assert.ok(forgedFreshness.reasons.some(
    (entry) => entry.code === "AUTHORITY_RECEIPT_BINDING_MISMATCH" && entry.field === "taskId"
  ));
});

test("stale or renamed review bindings are ignored while extra verifier results remain invalid", () => {
  const task = taskPacket();
  const current = resultFor(task, { id: "VR-CURRENT", verifierId: "V-CONTRACT", level: "contract" });
  const run = runFor(task, [current]);
  const renamed = reviewFor(task, [current], { verificationResultRefs: ["ai-dev/results/VR-X.json"] });
  const renamedDecision = adjudicateWorkflowCycle({
    runRecord: run,
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: entriesFor([current]),
    reviewReports: [renamed]
  });
  assert.equal(renamedDecision.decision, "review");
  assert.equal(renamedDecision.ignoredReviewReports.length, 1);

  const old = { ...current, outputDigest: DIGEST("z") };
  old.resultDigest = computeVerificationResultDigest(old);
  const staleReview = reviewFor(task, [old]);
  const staleDecision = adjudicateWorkflowCycle({
    runRecord: run,
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: entriesFor([current]),
    reviewReports: [staleReview]
  });
  assert.equal(staleDecision.decision, "review");
  assert.equal(staleDecision.ignoredReviewReports.length, 1);

  const extra = resultFor(task, { id: "VR-EXTRA", verifierId: "V-EXTRA", level: "contract" });
  assert.equal(adjudicateWorkflowCycle({
    runRecord: runFor(task, [current, extra]),
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: entriesFor([current, extra]),
    reviewReports: [reviewFor(task, [current, extra])]
  }).decision, "escalate");
});

test("stale high-round pass reports cannot override the current blocked review", () => {
  const task = taskPacket();
  const current = resultFor(task, { id: "VR-CURRENT-BLOCKED", verifierId: "V-CONTRACT", level: "contract" });
  const run = runFor(task, [current]);
  const currentBlocked = reviewFor(task, [current], {
    reportId: "RR-CURRENT-BLOCKED",
    reviewRound: 1,
    verdict: "blocked",
    evidence: []
  });

  const oldResult = { ...current, outputDigest: DIGEST("y") };
  oldResult.resultDigest = computeVerificationResultDigest(oldResult);
  const oldWorktreeResult = { ...current, worktreeDigest: DIGEST("x") };
  oldWorktreeResult.resultDigest = computeVerificationResultDigest(oldWorktreeResult);
  const stalePasses = [
    reviewFor(task, [current], {
      reportId: "RR-OLD-REVISION",
      reviewRound: 2,
      subjectRevision: "old-revision"
    }),
    reviewFor(task, [current], {
      reportId: "RR-OLD-CONTEXT",
      reviewRound: 3,
      reviewContextId: "reviewer-old-context"
    }),
    reviewFor(task, [oldResult], {
      reportId: "RR-OLD-RESULT",
      reviewRound: 4
    }),
    reviewFor(task, [oldWorktreeResult], {
      reportId: "RR-OLD-WORKTREE",
      reviewRound: 5
    })
  ];

  for (const stalePass of stalePasses) {
    const decision = adjudicateWorkflowCycle({
      runRecord: run,
      taskPacket: task,
      baseline: BASELINE,
      projectConfig: PROJECT_CONFIG,
      verificationResults: entriesFor([current]),
      reviewReports: [currentBlocked, stalePass]
    });
    assert.equal(decision.decision, "blocked", stalePass.reportId);
    assert.notEqual(decision.decision, "accept", stalePass.reportId);
    assert.deepEqual(decision.ignoredReviewReports.map((entry) => entry.reportId), [stalePass.reportId]);
    assert.ok(decision.reasons.some((entry) => entry.code === "REVIEW_BLOCKED"));
  }
});

test("portable path policy blocks Windows aliases for control paths", () => {
  assert.equal(pathMatchesPattern("agents.md", "AGENTS.md"), true);
  assert.equal(pathMatchesPattern("DOCS/CAFE\u0301.MD", "docs/Café.md"), true);
  assert.equal(pathMatchesPattern("docs/STRASSE.md", "docs/Straße.md"), true);
  for (const value of ["AGENTS.md.", "AGENTS.md ", "CON", "CON .txt", "COM¹.log", "src/file:stream", "src/control\u0001.txt"]) {
    assert.throws(() => normalizeRepoPath(value), (error) => error.code === "INVALID_REPO_PATH");
  }
  const scope = validateScope({
    allowedPaths: ["src/**"],
    forbiddenPaths: ["AGENTS.md"],
    controlPaths: ["AGENTS.md"],
    changedPaths: ["agents.md"]
  });
  assert.equal(scope.ok, false);
  assert.ok(scope.errors.some((entry) => entry.code === "SCOPE_CHANGE_FORBIDDEN"));
});
