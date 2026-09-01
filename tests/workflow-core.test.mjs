import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { computeFindingFingerprint, computeVerificationResultDigest, digestJson, normalizeRepoPath, pathMatchesPattern, validateSchema, validateScope } from "../src/core/index.mjs";
import { aggregateRunMetrics, attachDerivedMetrics, deriveRunMetrics } from "../src/metrics/index.mjs";
import {
  WorkflowError,
  adjudicateWorkflowCycle,
  computeReviewContextDigest,
  createRunRecord,
  evaluateHumanGates,
  evaluateSealedEvidenceFreshness,
  recordHumanIntervention,
  sealEvidenceBundle,
  transitionRun
} from "../src/workflow/index.mjs";

const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const SPEC_DIGEST = DIGEST("a");
const DEFINITION_DIGEST = DIGEST("b");
const INPUT_DIGEST = DIGEST("c");
const OUTPUT_DIGEST = DIGEST("d");
const WORKTREE_DIGEST = DIGEST("e");
const SPEC_INDEX_DIGEST = DIGEST("7");
const BASE_REVISION = "a".repeat(40);
const SUBJECT_CONTENT_DIGEST = digestJson({ baseRevision: BASE_REVISION, entries: [] });

const PROJECT_CONFIG = {
  schemaVersion: 2,
  frameworkVersion: "0.2.0",
  projectId: "workflow-tests",
  baselinePath: "ai-dev/baseline.json",
  specAdapter: {
    module: "src/spec/structured-markdown.mjs",
    exportName: "compileStructuredMarkdown",
  },
  paths: {
    decisions: "ai-dev/decisions",
    tasks: "ai-dev/tasks",
    reviews: "ai-dev/reviews",
    runs: "ai-dev/runs",
    evidence: "ai-dev/evidence",
    authorizations: "ai-dev/authorizations",
    generated: ".ai-flow/generated",
    cache: ".ai-flow/cache",
    controller: ".ai-flow/controller"
  },
  automationPolicy: {
    maxRepairRounds: 3,
    stopAfterSameFindingFingerprint: 2,
    freshReviewContextRequired: true,
    implementerCannotReviewOwnTask: true,
    repairWithinTaskAllowedPathsOnly: true,
    maxParallelVerifiers: 3,
    controlPaths: ["AGENTS.md", "ai-dev/**", "schemas/**"],
    sensitivePaths: [".env", "secrets/**"],
    reviewProfile: {
      profileId: "default",
      mandatoryLensIds: ["spec_conformance", "scope", "evidence"],
    },
    stopConditions: [
      "unresolved_decision",
      "truth_source_conflict",
      "same_finding_repeated",
      "repair_oscillation",
      "scope_expansion",
      "side_effect_requires_approval",
      "repair_round_limit"
    ]
  },
  evidencePolicy: {
    levels: ["specification", "contract", "runtime_stub", "target_integration", "owner", "production"],
    preventElevation: true
  }
};

const BASELINE = {
  schemaVersion: 1,
  baselineId: "BASELINE-001",
  status: "active",
  createdAt: "2026-08-27T00:00:00Z",
  canonicalSpecSourceId: "SPEC-001",
  truthSources: [{
    sourceId: "SPEC-001",
    path: "docs/product-spec.md",
    role: "product_content_truth",
    authority: "canonical",
    digest: SPEC_DIGEST
  }],
  knownConflicts: [],
  decisionRegister: "ai-dev/decisions/register.json"
};

function taskPacket(overrides = {}) {
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
    baselineId: "BASELINE-001",
    specDigest: SPEC_DIGEST,
    specIndexDigest: SPEC_INDEX_DIGEST,
    truthDigest: digestJson(truthBinding.components),
    controlDigest: digestJson(controlBinding),
    truthBinding,
    controlBinding,
    baseRevision: BASE_REVISION,
    taskId: "TASK-001",
    stageId: "STAGE-001",
    taskKind: "implementation",
    goal: "Implement one bounded behavior",
    requirementIds: ["REQ-001"],
    acceptanceIds: ["ACC-001"],
    derivation: {
      directRequirementIds: ["REQ-001"],
      impactedRequirementIds: [],
      globalInvariantIds: [],
      blockingDecisionIds: [],
      evidenceTargetDecisionIds: [],
      stageGate: {
        stageId: "STAGE-001",
        title: "Authorized implementation",
        status: "authorized",
        blockingDecisionIds: [],
        authorizationBoundary: "local implementation only",
        evidenceRequired: ["contract"],
        stageGateDigest: DIGEST("5"),
      }
    },
    routing: { capability: "standard" },
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
      verifierIds: ["VERIFY-CONTRACT"],
      tier: "quick",
      requiredEvidenceLevel: "contract",
      requiredAuthorityKinds: []
    },
    risk: { level: "low", domains: ["general"], sideEffects: [] },
    repairPolicy: {
      maxRounds: 3,
      allowedPathsOnly: true,
      allowedWriteClasses: ["managed_implementation"]
    },
    ...overrides
  };
}

function verificationResult(overrides = {}, task = taskPacket()) {
  const value = {
    schemaVersion: 2,
    resultId: "VR-001",
    verifierId: "VERIFY-CONTRACT",
    taskId: task.taskId,
    baselineId: task.baselineId,
    specDigest: task.specDigest,
    expectedTaskDigest: digestJson(task),
    taskPacketDigest: digestJson(task),
    controlDigest: task.controlDigest,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    subjectRevision: "rev-1",
    worktreeDigest: WORKTREE_DIGEST,
    definitionDigest: DEFINITION_DIGEST,
    inputDigest: INPUT_DIGEST,
    startedAt: "2026-08-27T00:03:00Z",
    completedAt: "2026-08-27T00:03:02Z",
    durationMs: 2000,
    status: "pass",
    complete: true,
    requiredTier: task.verification.tier,
    executedTier: task.verification.tier,
    exitCode: 0,
    cacheHit: false,
    evidenceLevel: "contract",
    outputDigest: OUTPUT_DIGEST,
    summary: "passed",
    artifactRefs: [],
    sideEffect: { occurred: false, authorized: false },
    ...overrides
  };
  value.resultDigest = overrides.resultDigest ?? computeVerificationResultDigest(value);
  return value;
}

function resultReference(result) {
  return `ai-dev/results/${result.resultId}.json`;
}

function referencedResults(results) {
  return results.map((result) => ({ reference: resultReference(result), result }));
}

function reviewReport(overrides = {}, results = [verificationResult()]) {
  const entries = referencedResults(results);
  const reviewContextId = overrides.reviewContextId ?? "reviewer-1";
  const subjectRevision = overrides.subjectRevision ?? results[0]?.subjectRevision ?? "rev-1";
  return {
    schemaVersion: 2,
    reportId: "RR-001",
    taskId: "TASK-001",
    baselineId: "BASELINE-001",
    specDigest: SPEC_DIGEST,
    taskPacketDigest: results[0].taskPacketDigest,
    controlDigest: results[0].controlDigest,
    subjectContentDigest: results[0].subjectContentDigest,
    subjectRevision,
    reviewRound: 0,
    implementerContextId: "implementer-1",
    reviewContextId,
    contextDigest: computeReviewContextDigest({
      reviewContextId,
      subjectRevision,
      subjectContentDigest: results[0].subjectContentDigest,
      taskPacketDigest: results[0].taskPacketDigest,
      controlDigest: results[0].controlDigest,
      verificationResults: entries,
    }),
    createdAt: "2026-08-27T00:04:30Z",
    verdict: "pass",
    verificationResultRefs: entries.map((entry) => entry.reference),
    verificationResultDigests: results.map((result) => ({ resultId: result.resultId, resultDigest: result.resultDigest })),
    evidence: [
      { level: "specification", status: "pass", reference: "docs/product-spec.md" },
      ...entries.map((entry) => ({ level: entry.result.evidenceLevel, status: "pass", reference: entry.reference }))
    ],
    findings: [],
    blockingDecisionIds: [],
    profileId: "default",
    lensCoverage: [
      { lensId: "evidence", status: "covered" },
      { lensId: "scope", status: "covered" },
      { lensId: "spec_conformance", status: "covered" },
    ],
    summary: "approved",
    ...overrides
  };
}

function reviewingRun(results = [verificationResult()], task = taskPacket()) {
  const entries = referencedResults(results);
  let run = createRunRecord({
    frameworkVersion: "0.2.0",
    runId: "RUN-001",
    taskPacket: task,
    taskPacketRef: `ai-dev/tasks/${task.taskId}.json`,
    subjectRevision: "rev-1",
    worktreeDigest: WORKTREE_DIGEST,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    controlDigest: task.controlDigest,
    startedAt: "2026-08-27T00:00:00Z",
    contextManifestRef: "ai-dev/contexts/CTX-001.json",
    workspace: { kind: "worktree", identifier: "/virtual/worktrees/RUN-001" },
    worktreeIdentityDigest: DIGEST("8"),
    briefRefs: {
      agent: ".ai-flow/generated/briefs/RUN-001-agent.md",
      human: ".ai-flow/generated/briefs/RUN-001-human.md",
    },
  });
  run = transitionRun(run, { to: "ready", at: "2026-08-27T00:01:00Z", reason: "ready", actorRole: "controller" });
  run = transitionRun(run, { to: "implementing", at: "2026-08-27T00:02:00Z", reason: "start", actorRole: "implementer", contextId: "implementer-1" });
  run = transitionRun(run, { to: "verifying", at: "2026-08-27T00:03:00Z", reason: "implemented", actorRole: "implementer" });
  run = transitionRun(run, {
    to: "reviewing",
    at: "2026-08-27T00:04:00Z",
    reason: "verification passed",
    actorRole: "controller",
    contextId: "reviewer-1",
    verificationResultRefs: entries.map((entry) => entry.reference),
    verificationResultDigests: results.map((result) => ({ resultId: result.resultId, resultDigest: result.resultDigest }))
  });
  return run;
}

function contextManifest() {
  const task = taskPacket();
  const manifest = {
    schemaVersion: 2,
    manifestId: "CTX-001",
    taskId: "TASK-001",
    baselineId: "BASELINE-001",
    specDigest: SPEC_DIGEST,
    specIndexDigest: task.specIndexDigest,
    taskPacketDigest: digestJson(task),
    controlDigest: task.controlDigest,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    subjectRevision: "rev-1",
    stageId: "STAGE-001",
    taskKind: "implementation",
    stageGate: { status: "authorized", authorizationBoundary: "local implementation only", evidenceRequired: ["contract"] },
    createdAt: "2026-08-27T00:03:30Z",
    items: [{
      kind: "spec_excerpt",
      path: "docs/product-spec.md",
      digest: SPEC_DIGEST,
      reason: "selected requirement REQ-001",
      required: true
    }],
    exclusions: []
  };
  return { ...manifest, manifestDigest: digestJson(manifest) };
}

test("run records fail closed without controller worktree and complete v2 bindings", () => {
  const task = taskPacket();
  const valid = reviewingRun([verificationResult()], task);
  const runSchema = JSON.parse(fs.readFileSync(new URL("../schemas/run-record.schema.json", import.meta.url), "utf8"));

  assert.deepEqual(validateSchema(valid, runSchema), []);
  for (const mutate of [
    (run) => { run.workspace.kind = "in_place"; },
    (run) => { run.contextManifestRef = null; },
    (run) => { run.checkpoints = []; },
    (run) => { delete run.taskPacketRef; },
    (run) => { delete run.worktreeIdentityDigest; },
    (run) => { delete run.briefRefs; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.notDeepEqual(validateSchema(invalid, runSchema), []);
  }

  const required = {
    frameworkVersion: "0.2.0",
    runId: "RUN-STRICT",
    taskPacket: task,
    taskPacketRef: `ai-dev/tasks/${task.taskId}.json`,
    subjectRevision: "rev-strict",
    worktreeDigest: WORKTREE_DIGEST,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    controlDigest: task.controlDigest,
    startedAt: "2026-08-27T00:00:00Z",
    contextManifestRef: "ai-dev/contexts/CTX-STRICT.json",
    workspace: { kind: "worktree", identifier: "/virtual/worktrees/RUN-STRICT" },
    worktreeIdentityDigest: DIGEST("8"),
    briefRefs: {
      agent: ".ai-flow/generated/briefs/RUN-STRICT-agent.md",
      human: ".ai-flow/generated/briefs/RUN-STRICT-human.md",
    },
  };
  assert.throws(
    () => createRunRecord({ ...required, subjectContentDigest: undefined }),
    (error) => error instanceof WorkflowError && error.code === "workflow_input_invalid",
  );
  assert.throws(
    () => createRunRecord({ ...required, controlDigest: DIGEST("9") }),
    (error) => error instanceof WorkflowError && error.code === "workflow_control_digest_mismatch",
  );
  assert.throws(
    () => createRunRecord({ ...required, workspace: { kind: "in_place", identifier: "/virtual/project" } }),
    (error) => error instanceof WorkflowError && error.code === "workflow_workspace_invalid",
  );
});

test("fixed workflow accepts only legal role-bound transitions and fresh review contexts", () => {
  const run = reviewingRun();
  const accepted = transitionRun(run, {
    to: "accepted",
    at: "2026-08-27T00:05:00Z",
    reason: "evidence sealed",
    actorRole: "controller",
    reviewReportRef: "ai-dev/reviews/RR-001.json",
    evidenceBundleRef: "ai-dev/evidence/EV-001.json",
    evidenceLevel: "contract"
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.result.acceptedEvidenceLevel, "contract");
  assert.throws(
    () => transitionRun(accepted, { to: "repairing", at: "2026-08-27T00:06:00Z", reason: "late", actorRole: "controller" }),
    (error) => error instanceof WorkflowError && error.code === "workflow_transition_invalid"
  );

  const verifying = { ...run, state: "verifying" };
  assert.throws(
    () => transitionRun(verifying, {
      to: "reviewing",
      at: "2026-08-27T00:05:00Z",
      reason: "self review",
      actorRole: "controller",
      contextId: "implementer-1",
      verificationResultRefs: ["ai-dev/results/VR-001.json"]
    }),
    (error) => error.code === "workflow_review_context_not_fresh"
  );
});

test("repair loop requires findings, a changed revision, and a rebuilt context", () => {
  const run = reviewingRun();
  const finding = {
    category: "behavior",
    summary: "wrong state",
    expected: "ready",
    observed: "busy",
    requirementIds: ["REQ-001"],
    acceptanceIds: ["ACC-001"],
    location: { path: "src/app/service.mjs" }
  };
  const repairing = transitionRun(run, {
    to: "repairing",
    at: "2026-08-27T00:05:00Z",
    reason: "repair finding",
    actorRole: "controller",
    findingFingerprints: [computeFindingFingerprint(finding)],
    reviewReportRef: "ai-dev/reviews/RR-001.json"
  });
  assert.throws(
    () => transitionRun(repairing, {
      to: "verifying",
      at: "2026-08-27T00:06:00Z",
      reason: "no revision change",
      actorRole: "repairer",
      subjectRevision: "rev-1",
      contextManifestRef: "ai-dev/contexts/CTX-002.json"
    }),
    (error) => error.code === "workflow_repair_revision_unchanged"
  );
  const repaired = transitionRun(repairing, {
    to: "verifying",
    at: "2026-08-27T00:06:00Z",
    reason: "repair complete",
    actorRole: "repairer",
    subjectRevision: "rev-2",
    worktreeDigest: DIGEST("f"),
    contextManifestRef: "ai-dev/contexts/CTX-002.json"
  });
  assert.equal(repaired.subjectRevision, "rev-2");
  assert.equal(repaired.repairHistory[0].status, "completed");
});

test("all five mandatory human gates are explicit and machine-readable", () => {
  const task = taskPacket({
    derivation: {
      directRequirementIds: ["REQ-001"],
      impactedRequirementIds: [],
      globalInvariantIds: [],
      blockingDecisionIds: ["DEC-001"],
      evidenceTargetDecisionIds: []
    },
    decisionDependencies: [{ decisionId: "DEC-001", status: "unresolved", evidenceRefs: [] }],
    risk: {
      level: "high",
      domains: ["external"],
      sideEffects: [{ kind: "external_service", requiresApproval: true }]
    }
  });
  const result = evaluateHumanGates({
    taskPacket: task,
    baseline: {
      ...BASELINE,
      knownConflicts: [{ conflictId: "CONFLICT-001", status: "open", summary: "drift", blockingScopes: ["src/app/**"] }]
    },
    projectConfig: PROJECT_CONFIG,
    changedPaths: ["outside/file.mjs"],
    requestedChangePaths: ["schemas/task-packet.schema.json"],
    verificationResults: [{
      ...verificationResult(),
      sideEffect: { occurred: true, authorized: false }
    }]
  });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.gates.map((entry) => entry.type).sort(), [
    "external_side_effect",
    "judge_modification",
    "scope_expansion",
    "truth_source_conflict",
    "unresolved_decision"
  ]);
});

test("workflow adjudication routes verify, repair, review, accept, and escalation deterministically", () => {
  const run = reviewingRun();
  const task = taskPacket();
  assert.equal(adjudicateWorkflowCycle({ runRecord: run, taskPacket: task, baseline: BASELINE, projectConfig: PROJECT_CONFIG }).decision, "verify");

  const failed = verificationResult({ status: "fail", exitCode: 1 });
  const repair = adjudicateWorkflowCycle({
    runRecord: reviewingRun([failed]),
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: referencedResults([failed])
  });
  assert.equal(repair.decision, "repair");
  assert.equal(repair.findingFingerprints.length, 1);

  const passed = verificationResult();
  assert.equal(adjudicateWorkflowCycle({
    runRecord: run,
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: referencedResults([passed])
  }).decision, "review");
  assert.equal(adjudicateWorkflowCycle({
    runRecord: run,
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: referencedResults([passed]),
    reviewReports: [reviewReport()]
  }).decision, "accept");

  const selfReview = reviewReport({ reviewContextId: "implementer-1" });
  assert.equal(adjudicateWorkflowCycle({
    runRecord: run,
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    verificationResults: referencedResults([passed]),
    reviewReports: [selfReview]
  }).decision, "escalate");
});

test("evidence seal binds every mutable input, prevents elevation, and becomes stale on drift", () => {
  const run = reviewingRun();
  const task = taskPacket();
  const context = contextManifest();
  const result = verificationResult();
  const review = reviewReport();
  const inputs = {
    frameworkVersion: "0.2.0",
    bundleId: "EV-001",
    createdAt: "2026-08-27T00:05:00Z",
    runRecord: run,
    taskPacket: task,
    baseline: BASELINE,
    projectConfig: PROJECT_CONFIG,
    contextManifest: context,
    verificationResults: [{ reference: "ai-dev/results/VR-001.json", result }],
    reviewReports: [{ reference: "ai-dev/reviews/RR-001.json", report: review }],
    verifierDefinitionDigests: { "VERIFY-CONTRACT": DEFINITION_DIGEST },
    verifierInputDigests: { "VERIFY-CONTRACT": INPUT_DIGEST },
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
  const bundle = sealEvidenceBundle(inputs);
  assert.equal(bundle.declaredMaximumLevel, "contract");
  assert.equal(bundle.frameworkVersion, "0.2.0");
  assert.equal(bundle.baselineDigest, digestJson(BASELINE));
  assert.equal(bundle.taskPacketDigest, digestJson(task));

  const evidenceSchema = JSON.parse(fs.readFileSync(new URL("../schemas/evidence-bundle.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSchema(bundle, evidenceSchema), []);
  assert.equal(evaluateSealedEvidenceFreshness(bundle, {
    frameworkVersion: "0.2.0",
    baseline: BASELINE,
    taskPacket: task,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    contextManifest: context,
    verificationResults: inputs.verificationResults,
    verifierDefinitionDigests: { "VERIFY-CONTRACT": DEFINITION_DIGEST },
    verifierInputDigests: { "VERIFY-CONTRACT": INPUT_DIGEST },
    reviewReports: inputs.reviewReports,
    authorityReceipts: [],
  }).fresh, true);
  assert.equal(evaluateSealedEvidenceFreshness(bundle, {
    frameworkVersion: "0.3.0",
    baseline: BASELINE,
    taskPacket: task,
    subjectContentDigest: SUBJECT_CONTENT_DIGEST,
    contextManifest: context,
    verificationResults: inputs.verificationResults,
    verifierDefinitionDigests: { "VERIFY-CONTRACT": DEFINITION_DIGEST },
    verifierInputDigests: { "VERIFY-CONTRACT": INPUT_DIGEST },
    reviewReports: inputs.reviewReports,
    authorityReceipts: [],
  }).fresh, false);
  assert.throws(
    () => sealEvidenceBundle({ ...inputs, taskPacket: taskPacket({ verification: { ...task.verification, requiredEvidenceLevel: "runtime_stub" } }) }),
    (error) => ["evidence_task_digest_mismatch", "evidence_not_acceptable", "evidence_level_insufficient"].includes(error.code)
  );
});

test("run metrics derive duration, repair, cache, and human intervention without a database", () => {
  let run = reviewingRun();
  run = recordHumanIntervention(run, {
    interventionId: "HUMAN-001",
    gate: "other",
    status: "resolved",
    at: "2026-08-27T00:04:30Z",
    summary: "Owner clarified a non-blocking note",
    actorRef: "owner"
  });
  run = transitionRun(run, {
    to: "accepted",
    at: "2026-08-27T00:05:00Z",
    reason: "evidence sealed",
    actorRole: "controller",
    reviewReportRef: "ai-dev/reviews/RR-001.json",
    evidenceBundleRef: "ai-dev/evidence/EV-001.json",
    evidenceLevel: "contract"
  });
  const derived = deriveRunMetrics(run, {
    verificationResults: [verificationResult({ cacheHit: true, durationMs: 25 })]
  });
  assert.equal(derived.durationMs, 300000);
  assert.equal(derived.cacheHitRate, 1);
  assert.equal(derived.humanInterventionCount, 1);
  const attached = attachDerivedMetrics(run, { verificationResults: [verificationResult({ cacheHit: true })] });
  const runSchema = JSON.parse(fs.readFileSync(new URL("../schemas/run-record.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSchema(attached, runSchema), []);
  const aggregate = aggregateRunMetrics([derived, { ...derived, runId: "RUN-002", finalState: "escalated", escalated: true }]);
  assert.equal(aggregate.acceptanceRate, 0.5);
  assert.equal(aggregate.humanInterventionRate, 1);
});
