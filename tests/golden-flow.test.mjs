import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAuthorityReceiptBinding,
  canonicalTextDigest,
  computeAuthorityReceiptDigest,
  computeFindingFingerprint,
  computeVerificationResultDigest,
  digestJson,
  evaluateCycle,
  evaluateEvidenceFreshness,
  sha256,
  validateSchema,
} from "../src/core/index.mjs";
import { compileStructuredMarkdown } from "../src/spec/index.mjs";
import { buildContextManifest, compileTask } from "../src/task/index.mjs";
import {
  computeReviewContextDigest,
  createRunRecord,
  evaluateSealedEvidenceFreshness,
  normalizeReferencedVerificationResults,
  sealEvidenceBundle,
  transitionRun,
  verificationResultDigests,
  verificationResultRefs,
} from "../src/workflow/index.mjs";
import { normalizeLabel } from "../examples/minimal/src/normalize.mjs";

const repositoryRoot = new URL("../", import.meta.url);

async function readText(path) {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

const [
  config,
  baseline,
  decisionRegister,
  impactMap,
  verifierRegistry,
  contract,
  documentationContract,
  specificationText,
  implementationText,
  schemas,
] = await Promise.all([
  readJson("examples/minimal/ai-flow.config.json"),
  readJson("examples/minimal/ai-dev/baseline.json"),
  readJson("examples/minimal/ai-dev/decisions/register.json"),
  readJson("examples/minimal/ai-dev/impact-map.json"),
  readJson("examples/minimal/ai-dev/verifiers/registry.json"),
  readJson("examples/minimal/contracts/normalize.contract.json"),
  readJson("examples/minimal/contracts/documentation.contract.json"),
  readText("examples/minimal/docs/product-spec.md"),
  readText("examples/minimal/src/normalize.mjs"),
  Object.fromEntries(await Promise.all([
    "project-config",
    "baseline",
    "decision-register",
    "impact-map",
    "verifier-registry",
    "spec-index",
    "task-packet",
    "context-manifest",
    "verification-result",
    "review-report",
    "run-record",
    "evidence-bundle",
    "authority-receipt",
  ].map(async (name) => [name, await readJson(`schemas/${name}.schema.json`)]))),
]);

function assertValid(schemaName, value) {
  assert.deepEqual(validateSchema(value, schemas[schemaName]), [], `${schemaName} contract`);
}

function compileSpecIndex() {
  return compileStructuredMarkdown({
    text: specificationText,
    baselineId: baseline.baselineId,
    sourceId: baseline.canonicalSpecSourceId,
    path: "examples/minimal/docs/product-spec.md",
    expectedDigest: baseline.truthSources.find((source) => source.sourceId === baseline.canonicalSpecSourceId).digest,
  });
}

function compileMinimalTask({
  evidenceTargetDecisionIds = ["DEC-CASE-001"],
  changedPaths,
  map = impactMap,
  stageId = "STAGE-CASE-FOLDING",
  taskKind = "evidence_collection",
  register = decisionRegister,
} = {}) {
  const specIndex = compileSpecIndex();
  const compilation = compileTask({
    taskId: "TASK-MINIMAL-001",
    goal: "Implement deterministic string normalization and collect case-folding decision evidence.",
    baseRevision: "a".repeat(40),
    stageId,
    taskKind,
    changedPaths: changedPaths ?? ["examples/minimal/src/normalize.mjs"],
    directRequirementIds: ["REQ-NORM-001"],
    evidenceTargetDecisionIds,
    requiredEvidenceLevel: "runtime_stub",
    requestedTier: "quick",
    risk: { level: "low", domains: ["normalization"] },
    contextHints: { excludedPaths: ["examples/minimal/README.md"] },
    specIndex,
    baseline,
    impactMap: map,
    decisionRegister: register,
    verifierRegistry,
    projectConfig: config,
  });
  return { specIndex, compilation };
}

function runRealContractCases() {
  const outputs = [];
  for (const example of contract.cases) {
    const actual = normalizeLabel(example.input);
    assert.equal(actual, example.expected, example.caseId);
    outputs.push({ caseId: example.caseId, actual });
  }

  let rejectedInvalidInputs = 0;
  for (const value of contract.invalidInputs) {
    assert.throws(() => normalizeLabel(value), TypeError);
    rejectedInvalidInputs += 1;
  }
  return { outputs, rejectedInvalidInputs };
}

function makeVerificationResult({
  verifier,
  taskPacket,
  observations,
  resultId,
  worktreeDigest,
  subjectContentDigest,
  subjectRevision = taskPacket.baseRevision,
}) {
  const definitionDigest = digestJson(verifier);
  const inputDigest = digestJson({
    taskId: taskPacket.taskId,
    specDigest: taskPacket.specDigest,
    subjectRevision,
    contractDigest: digestJson(contract),
    implementationDigest: canonicalTextDigest(implementationText),
  });
  const unsigned = {
    schemaVersion: 2,
    resultId,
    verifierId: verifier.verifierId,
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    expectedTaskDigest: digestJson(taskPacket),
    taskPacketDigest: digestJson(taskPacket),
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest,
    subjectRevision,
    worktreeDigest,
    definitionDigest,
    inputDigest,
    startedAt: "2026-08-27T01:00:00Z",
    completedAt: "2026-08-27T01:00:00Z",
    durationMs: 0,
    status: "pass",
    complete: true,
    requiredTier: taskPacket.verification.tier,
    executedTier: taskPacket.verification.tier,
    exitCode: 0,
    cacheHit: false,
    evidenceLevel: verifier.evidenceLevel,
    outputDigest: digestJson(observations),
    summary: observations.outputs.length + " examples passed; "
      + observations.rejectedInvalidInputs + " invalid inputs rejected.",
    artifactRefs: [],
    sideEffect: { occurred: false, authorized: false },
  };
  return { ...unsigned, resultDigest: computeVerificationResultDigest(unsigned) };
}

function buildReadyFlow() {
  const { specIndex, compilation } = compileMinimalTask();
  assert.equal(compilation.status, "ready");
  const taskPacket = compilation.taskPacket;
  const subjectEntries = [{
    path: "examples/minimal/src/normalize.mjs",
    type: "file",
    mode: "100644",
    contentDigest: sha256(Buffer.from(implementationText, "utf8")),
  }];
  const subjectContentDigest = digestJson({
    baseRevision: taskPacket.baseRevision,
    entries: subjectEntries,
  });
  const contextManifest = buildContextManifest({
    manifestId: "CONTEXT-MINIMAL-001",
    taskPacket,
    specIndex,
    subjectRevision: taskPacket.baseRevision,
    subjectContentDigest,
    createdAt: "2026-08-27T00:30:00Z",
    decisionSource: {
      path: "examples/minimal/ai-dev/decisions/register.json",
      digest: digestJson(decisionRegister),
    },
    contracts: [
      {
        path: "examples/minimal/contracts/normalize.contract.json",
        digest: digestJson(contract),
        requirementIds: contract.requirementIds,
        acceptanceIds: contract.acceptanceIds,
        reason: "Executable examples for the selected requirements.",
      },
      {
        path: "examples/minimal/contracts/documentation.contract.json",
        digest: digestJson(documentationContract),
        requirementIds: documentationContract.requirementIds,
        acceptanceIds: documentationContract.acceptanceIds,
        reason: "Must remain outside this task context.",
      },
    ],
  });

  const observations = runRealContractCases();
  const worktreeDigest = digestJson({
    subjectRevision: taskPacket.baseRevision,
    files: [
      {
        path: "examples/minimal/contracts/normalize.contract.json",
        digest: digestJson(contract),
      },
      {
        path: "examples/minimal/src/normalize.mjs",
        digest: canonicalTextDigest(implementationText),
      },
    ],
  });
  const verificationResults = taskPacket.verification.verifierIds.map((verifierId, index) => {
    const verifier = verifierRegistry.verifiers.find((entry) => entry.verifierId === verifierId);
    assert.ok(verifier, verifierId);
    return makeVerificationResult({
      verifier,
      taskPacket,
      observations,
      resultId: "VERIFY-MINIMAL-00" + (index + 1),
      worktreeDigest,
      subjectContentDigest,
    });
  });
  const verificationWrappers = verificationResults.map((result) => ({
    reference: "generated/minimal/verification/" + result.verifierId + ".json",
    result,
  }));
  const verificationEntries = normalizeReferencedVerificationResults(verificationWrappers);
  const verificationRefs = verificationResultRefs(verificationEntries);
  const verificationDigests = verificationResultDigests(verificationEntries);
  const reviewReportRef = "generated/minimal/reviews/round-0.json";
  const reviewContextId = "agent:reviewer:001";
  const reviewReport = {
    schemaVersion: 2,
    reportId: "REVIEW-MINIMAL-001",
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    taskPacketDigest: digestJson(taskPacket),
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest: verificationResults[0].subjectContentDigest,
    subjectRevision: taskPacket.baseRevision,
    reviewRound: 0,
    implementerContextId: "agent:implementer:001",
    reviewContextId,
    contextDigest: computeReviewContextDigest({
      reviewContextId,
      subjectRevision: taskPacket.baseRevision,
      subjectContentDigest: verificationResults[0].subjectContentDigest,
      taskPacketDigest: digestJson(taskPacket),
      controlDigest: taskPacket.controlDigest,
      verificationResults: verificationEntries,
    }),
    createdAt: "2026-08-27T01:02:00Z",
    verdict: "pass",
    verificationResultRefs: verificationRefs,
    verificationResultDigests: verificationDigests,
    evidence: [
      { level: "specification", status: "pass", reference: taskPacket.specDigest },
      { level: "contract", status: "pass", reference: verificationResults[0].resultId },
      { level: "runtime_stub", status: "pass", reference: verificationResults[1].resultId },
    ],
    findings: [],
    blockingDecisionIds: [],
    profileId: taskPacket.review.profileId,
    lensCoverage: taskPacket.review.mandatoryLensIds.map((lensId) => ({ lensId, status: "covered" })),
    summary: "Fresh reviewer context confirmed the selected requirements and exact verifier result set.",
  };

  const cycleResult = evaluateCycle({
    policy: config.automationPolicy,
    taskPacket,
    reviewReports: [reviewReport],
    verificationResults,
    evidenceBinding: {
      taskId: taskPacket.taskId,
      baselineId: taskPacket.baselineId,
      specDigest: taskPacket.specDigest,
      expectedTaskDigest: digestJson(taskPacket),
      taskPacketDigest: digestJson(taskPacket),
      controlDigest: taskPacket.controlDigest,
      subjectContentDigest: verificationResults[0].subjectContentDigest,
      subjectRevision: taskPacket.baseRevision,
      worktreeDigest,
      requiredTier: taskPacket.verification.tier,
    },
    participantContextIds: ["agent:implementer:001", reviewContextId],
  });

  let reviewingRun = createRunRecord({
    frameworkVersion: config.frameworkVersion,
    runId: "RUN-MINIMAL-001",
    taskPacket,
    taskPacketRef: `ai-dev/tasks/${taskPacket.taskId}.json`,
    subjectRevision: taskPacket.baseRevision,
    worktreeDigest,
    subjectContentDigest,
    controlDigest: taskPacket.controlDigest,
    startedAt: "2026-08-27T00:30:00Z",
    contextManifestRef: "generated/minimal/context.json",
    workspace: { kind: "worktree", identifier: "/virtual/worktrees/RUN-MINIMAL-001" },
    worktreeIdentityDigest: digestJson({ runId: "RUN-MINIMAL-001", baseRevision: taskPacket.baseRevision }),
    briefRefs: {
      agent: "generated/minimal/briefs/agent.md",
      human: "generated/minimal/briefs/human.md",
    },
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "ready",
    at: "2026-08-27T00:31:00Z",
    reason: "Task compilation completed without a blocking decision.",
    actorRole: "controller",
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "implementing",
    at: "2026-08-27T00:35:00Z",
    reason: "Bounded evidence implementation started.",
    actorRole: "implementer",
    contextId: "agent:implementer:001",
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "verifying",
    at: "2026-08-27T00:45:00Z",
    reason: "Allowed-path implementation completed.",
    actorRole: "implementer",
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "reviewing",
    at: "2026-08-27T01:00:00Z",
    reason: "Complete deterministic verifier results were generated.",
    actorRole: "controller",
    contextId: reviewContextId,
    verificationResultRefs: verificationRefs,
    verificationResultDigests: verificationDigests,
  });

  const verifierDefinitionDigests = Object.fromEntries(
    verificationResults.map((result) => [result.verifierId, result.definitionDigest]),
  );
  const verifierInputDigests = Object.fromEntries(
    verificationResults.map((result) => [result.verifierId, result.inputDigest]),
  );
  const reviewWrappers = [{ reference: reviewReportRef, report: reviewReport }];
  const evidenceBundle = sealEvidenceBundle({
    frameworkVersion: config.frameworkVersion,
    bundleId: "EVIDENCE-MINIMAL-001",
    createdAt: "2026-08-27T01:05:00Z",
    runRecord: reviewingRun,
    taskPacket,
    baseline,
    projectConfig: config,
    contextManifest,
    verificationResults: verificationWrappers,
    reviewReports: reviewWrappers,
    authorityReceipts: [],
    verifierDefinitionDigests,
    verifierInputDigests,
    subjectContent: {
      baseRevision: taskPacket.baseRevision,
      entries: subjectEntries,
      subjectContentDigest,
    },
    actualImpact: {
      changedPaths: compilation.impact.changedPaths,
      matchedImpactRuleIds: compilation.impact.matchedRuleIds,
      requirementIds: taskPacket.requirementIds,
      acceptanceIds: taskPacket.acceptanceIds,
      verifierIds: taskPacket.verification.verifierIds,
    },
    limitations: [
      "Only in-process Node.js behavior was verified.",
      "No target integration, Owner, or production evidence was collected.",
    ],
    exclusions: [],
  });
  const runRecord = transitionRun(reviewingRun, {
    to: "accepted",
    at: "2026-08-27T01:05:00Z",
    reason: "Accepted at runtime_stub evidence level only.",
    actorRole: "controller",
    evidenceLevel: evidenceBundle.declaredMaximumLevel,
    evidenceBundleRef: "generated/minimal/evidence/bundle.json",
    reviewReportRef,
    exclusions: [],
  });

  const freshnessCurrent = {
    frameworkVersion: config.frameworkVersion,
    baseline,
    baselineId: taskPacket.baselineId,
    taskPacket,
    specDigest: taskPacket.specDigest,
    subjectRevision: taskPacket.baseRevision,
    subjectContentDigest,
    worktreeDigest,
    contextManifest,
    contextManifestDigest: contextManifest.manifestDigest,
    verificationResults: verificationWrappers,
    reviewReports: reviewWrappers,
    authorityReceipts: [],
    verifierDefinitionDigests,
    verifierInputDigests,
  };

  return {
    specIndex,
    taskPacket,
    contextManifest,
    verificationResults,
    verificationWrappers,
    reviewReport,
    cycleResult,
    evidenceBundle,
    freshnessCurrent,
    runRecord,
  };
}

function buildControlProposalFlow() {
  const specIndex = compileSpecIndex();
  const resolvedRegister = structuredClone(decisionRegister);
  resolvedRegister.status = "resolved";
  Object.assign(resolvedRegister.decisions[0], {
    status: "resolved",
    selectedOptionId: "OPT-PRESERVE",
    decidedBy: "Owner",
    resolvedAt: "2026-08-27T00:00:00Z",
    resolutionEvidence: ["owner://decisions/DEC-CASE-001"],
  });
  Object.assign(resolvedRegister.stageGates[0], {
    status: "authorized",
    evidenceRequired: ["Owner acceptance"],
    authorizationBoundary: "A control candidate may be evaluated but only an external target can activate it.",
  });

  const baseVerifierRegistry = structuredClone(verifierRegistry);
  baseVerifierRegistry.verifiers.push({
    verifierId: "VER-CONTROL-TARGET",
    title: "Control candidate target integration",
    tier: "quick",
    command: "node",
    args: ["--test", "tests/control-closure.test.mjs"],
    workingDirectory: ".",
    timeoutMs: 30000,
    evidenceLevel: "target_integration",
    deterministic: true,
    inputPatterns: ["src/**", "schemas/**", "tests/**"],
    triggers: {
      requirementIds: [],
      acceptanceIds: [],
      pathPatterns: ["src/**", "schemas/**"],
      riskDomains: ["control_integrity"],
      alwaysRun: true,
    },
    sideEffect: { kind: "none", requiresApproval: false },
  });
  assertValid("verifier-registry", baseVerifierRegistry);

  const compilation = compileTask({
    taskId: "TASK-CONTROL-PROPOSAL-001",
    goal: "Evaluate a control-plane candidate without allowing it to judge or activate itself.",
    baseRevision: "b".repeat(40),
    stageId: "STAGE-CASE-FOLDING",
    taskKind: "control_plane",
    changedPaths: ["src/core/evidence.mjs"],
    directRequirementIds: ["REQ-NORM-001"],
    evidenceTargetDecisionIds: [],
    requiredEvidenceLevel: "owner",
    requestedTier: "quick",
    risk: { level: "high", domains: ["control_integrity"] },
    constraints: ["Candidate control cannot judge its own run."],
    specIndex,
    baseline,
    impactMap,
    decisionRegister: resolvedRegister,
    verifierRegistry: baseVerifierRegistry,
    projectConfig: config,
  });
  assert.equal(compilation.status, "ready");
  const taskPacket = compilation.taskPacket;

  const subjectEntries = [{
    path: "src/core/evidence.mjs",
    type: "file",
    mode: "100644",
    contentDigest: sha256(Buffer.from("candidate control bytes", "utf8")),
  }];
  const subjectContentDigest = digestJson({
    baseRevision: taskPacket.baseRevision,
    entries: subjectEntries,
  });
  const subjectRevision = "candidate:control:001";
  const worktreeDigest = digestJson({
    worktreeIdentity: "golden-control-worktree",
    subjectContentDigest,
  });
  const contextManifest = buildContextManifest({
    manifestId: "CONTEXT-CONTROL-PROPOSAL-001",
    taskPacket,
    specIndex,
    subjectRevision,
    subjectContentDigest,
    createdAt: "2026-08-27T00:30:00Z",
    decisionSource: {
      path: "examples/minimal/ai-dev/decisions/register.json",
      digest: digestJson(resolvedRegister),
    },
    contracts: [{
      path: "examples/minimal/contracts/normalize.contract.json",
      digest: digestJson(contract),
      requirementIds: contract.requirementIds,
      acceptanceIds: contract.acceptanceIds,
      reason: "Executable examples for the selected control requirements.",
    }],
  });

  const observations = runRealContractCases();
  const verificationResults = taskPacket.verification.verifierIds.map((verifierId, index) => {
    const verifier = baseVerifierRegistry.verifiers.find((entry) => entry.verifierId === verifierId);
    assert.ok(verifier, verifierId);
    return makeVerificationResult({
      verifier,
      taskPacket,
      observations,
      resultId: `VERIFY-CONTROL-${String(index + 1).padStart(3, "0")}`,
      worktreeDigest,
      subjectContentDigest,
      subjectRevision,
    });
  });
  const verificationWrappers = verificationResults.map((result) => ({
    reference: `generated/control/verification/${result.verifierId}.json`,
    result,
  }));
  const verificationEntries = normalizeReferencedVerificationResults(verificationWrappers);
  const verificationRefs = verificationResultRefs(verificationEntries);
  const verificationDigests = verificationResultDigests(verificationEntries);
  const reviewContextId = "agent:control-reviewer:001";
  const reviewReport = {
    schemaVersion: 2,
    reportId: "REVIEW-CONTROL-PROPOSAL-001",
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    taskPacketDigest: digestJson(taskPacket),
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest,
    subjectRevision,
    reviewRound: 0,
    implementerContextId: "agent:control-implementer:001",
    reviewContextId,
    contextDigest: computeReviewContextDigest({
      reviewContextId,
      subjectRevision,
      subjectContentDigest,
      taskPacketDigest: digestJson(taskPacket),
      controlDigest: taskPacket.controlDigest,
      verificationResults: verificationEntries,
    }),
    createdAt: "2026-08-27T01:10:00Z",
    verdict: "pass",
    verificationResultRefs: verificationRefs,
    verificationResultDigests: verificationDigests,
    evidence: [
      { level: "specification", status: "pass", reference: taskPacket.specDigest },
      ...verificationResults.map((result) => ({
        level: result.evidenceLevel,
        status: "pass",
        reference: result.resultId,
      })),
    ],
    findings: [],
    blockingDecisionIds: [],
    profileId: taskPacket.review.profileId,
    lensCoverage: taskPacket.review.mandatoryLensIds.map((lensId) => ({ lensId, status: "covered" })),
    summary: "An independent context reviewed the candidate against the base control definitions.",
  };

  let reviewingRun = createRunRecord({
    frameworkVersion: config.frameworkVersion,
    runId: "RUN-CONTROL-PROPOSAL-001",
    taskPacket,
    taskPacketRef: `ai-dev/tasks/${taskPacket.taskId}.json`,
    subjectRevision,
    subjectContentDigest,
    worktreeDigest,
    controlDigest: taskPacket.controlDigest,
    startedAt: "2026-08-27T00:30:00Z",
    contextManifestRef: "generated/control/context.json",
    workspace: { kind: "worktree", identifier: "/virtual/worktrees/RUN-CONTROL-PROPOSAL-001" },
    worktreeIdentityDigest: digestJson({ runId: "RUN-CONTROL-PROPOSAL-001", baseRevision: taskPacket.baseRevision }),
    briefRefs: {
      agent: "generated/control/briefs/agent.md",
      human: "generated/control/briefs/human.md",
    },
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "ready", at: "2026-08-27T00:31:00Z", reason: "Control proposal compiled.", actorRole: "controller",
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "implementing",
    at: "2026-08-27T00:35:00Z",
    reason: "Authorized candidate implementation started.",
    actorRole: "implementer",
    contextId: "agent:control-implementer:001",
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "verifying", at: "2026-08-27T01:00:00Z", reason: "Candidate content stabilized.", actorRole: "implementer",
  });
  reviewingRun = transitionRun(reviewingRun, {
    to: "reviewing",
    at: "2026-08-27T01:05:00Z",
    reason: "Base-control verification completed.",
    actorRole: "controller",
    contextId: reviewContextId,
    verificationResultRefs: verificationRefs,
    verificationResultDigests: verificationDigests,
  });

  const authorityBinding = buildAuthorityReceiptBinding({
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    taskPacketDigest: digestJson(taskPacket),
    expectedTaskDigest: digestJson(taskPacket),
    specDigest: taskPacket.specDigest,
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest,
    baselineDigest: digestJson(baseline),
    subjectRevision,
    worktreeDigest,
    requiredTier: taskPacket.verification.tier,
  }, {
    verificationResults,
    reviewReports: [reviewReport],
    participantContextIds: ["agent:control-implementer:001", reviewContextId],
  });
  const ownerReceipt = {
    schemaVersion: 2,
    receiptId: "AUTH-CONTROL-OWNER-001",
    kind: "owner_acceptance",
    actorType: "human",
    actorRef: "owner:golden-control",
    taskId: authorityBinding.taskId,
    taskPacketDigest: authorityBinding.taskPacketDigest,
    expectedTaskDigest: authorityBinding.expectedTaskDigest,
    specDigest: authorityBinding.specDigest,
    controlDigest: authorityBinding.controlDigest,
    subjectContentDigest: authorityBinding.subjectContentDigest,
    baselineDigest: authorityBinding.baselineDigest,
    subjectRevision: authorityBinding.subjectRevision,
    worktreeDigest: authorityBinding.worktreeDigest,
    verificationResultDigests: structuredClone(authorityBinding.verificationResultDigests),
    reviewReportDigests: structuredClone(authorityBinding.reviewReportDigests),
    issuedAt: "2026-08-27T01:15:00Z",
    reference: "owner://acceptance/control-proposal-001",
  };
  ownerReceipt.receiptDigest = computeAuthorityReceiptDigest(ownerReceipt);
  const authorityReceipts = [{
    reference: "generated/control/authority/owner.json",
    receipt: ownerReceipt,
  }];
  const reviewReports = [{ reference: "generated/control/reviews/round-0.json", report: reviewReport }];
  const verifierDefinitionDigests = Object.fromEntries(
    verificationResults.map((result) => [result.verifierId, result.definitionDigest]),
  );
  const verifierInputDigests = Object.fromEntries(
    verificationResults.map((result) => [result.verifierId, result.inputDigest]),
  );
  const evidenceBundle = sealEvidenceBundle({
    frameworkVersion: config.frameworkVersion,
    bundleId: "EVIDENCE-CONTROL-PROPOSAL-001",
    createdAt: "2026-08-27T01:20:00Z",
    runRecord: reviewingRun,
    taskPacket,
    baseline,
    projectConfig: config,
    contextManifest,
    verificationResults: verificationWrappers,
    reviewReports,
    authorityReceipts,
    verifierDefinitionDigests,
    verifierInputDigests,
    subjectContent: {
      baseRevision: taskPacket.baseRevision,
      entries: subjectEntries,
      subjectContentDigest,
    },
    actualImpact: {
      changedPaths: compilation.impact.changedPaths,
      matchedImpactRuleIds: compilation.impact.matchedRuleIds,
      requirementIds: taskPacket.requirementIds,
      acceptanceIds: taskPacket.acceptanceIds,
      verifierIds: taskPacket.verification.verifierIds,
    },
    limitations: ["Activation is deliberately outside the current run."],
  });
  const acceptedRun = transitionRun(reviewingRun, {
    to: "accepted",
    at: "2026-08-27T01:20:00Z",
    reason: "Owner evidence accepted the candidate, not its activation.",
    actorRole: "controller",
    evidenceLevel: evidenceBundle.declaredMaximumLevel,
    evidenceBundleRef: "generated/control/evidence/bundle.json",
    reviewReportRef: reviewReports[0].reference,
    exclusions: [],
  });

  const candidateVerifierRegistry = structuredClone(baseVerifierRegistry);
  candidateVerifierRegistry.verifiers.find((entry) => entry.verifierId === "VER-CONTROL-TARGET").args = [
    "--test",
    "candidate-self-judge.test.mjs",
  ];
  return {
    specIndex,
    taskPacket,
    contextManifest,
    verificationResults,
    reviewReport,
    ownerReceipt,
    evidenceBundle,
    acceptedRun,
    baseVerifierRegistry,
    candidateVerifierRegistry,
    freshnessCurrent: {
      frameworkVersion: config.frameworkVersion,
      baseline,
      taskPacket,
      subjectRevision,
      subjectContentDigest,
      worktreeDigest,
      contextManifest,
      verificationResults: verificationWrappers,
      reviewReports,
      authorityReceipts,
      verifierDefinitionDigests,
      verifierInputDigests,
    },
  };
}

function makeFinding({ findingId, summary, observed }) {
  const finding = {
    findingId,
    severity: "medium",
    category: "behavior",
    summary,
    expected: "normalizeLabel must preserve the declared contract.",
    observed,
    requirementIds: ["REQ-NORM-001"],
    acceptanceIds: ["AT-NORM-001"],
    location: { path: "examples/minimal/src/normalize.mjs", line: 1 },
    repairable: true,
    repairHint: "Repair only the declared normalization behavior.",
  };
  return { ...finding, fingerprint: computeFindingFingerprint(finding) };
}

function makeFailingReview(taskPacket, reviewRound, finding) {
  const subjectRevision = "subject:minimal:repair-" + reviewRound;
  const reviewContextId = "agent:reviewer:" + reviewRound;
  const subjectContentDigest = digestJson({ baseRevision: taskPacket.baseRevision, entries: [] });
  return {
    schemaVersion: 2,
    reportId: `REVIEW-FAIL-${reviewRound}`,
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    taskPacketDigest: digestJson(taskPacket),
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest,
    subjectRevision,
    reviewRound,
    implementerContextId: "agent:implementer:001",
    reviewContextId,
    contextDigest: computeReviewContextDigest({
      reviewContextId,
      subjectRevision,
      subjectContentDigest,
      taskPacketDigest: digestJson(taskPacket),
      controlDigest: taskPacket.controlDigest,
      verificationResults: [],
    }),
    createdAt: "2026-08-27T01:02:00Z",
    verdict: "fail",
    verificationResultRefs: [],
    verificationResultDigests: [],
    evidence: [
      { level: "specification", status: "pass", reference: taskPacket.specDigest },
      { level: "contract", status: "fail", reference: finding.findingId },
    ],
    findings: [finding],
    blockingDecisionIds: [],
    profileId: taskPacket.review.profileId,
    lensCoverage: taskPacket.review.mandatoryLensIds.map((lensId) => ({ lensId, status: "covered" })),
    summary: "A repairable contract finding remains.",
  };
}

test("golden flow generates valid live artifacts and stops at the proven evidence level", () => {
  const flow = buildReadyFlow();

  assertValid("project-config", config);
  assertValid("baseline", baseline);
  assert.equal(
    baseline.truthSources.find((source) => source.sourceId === "SRC-CONTRACT-001").digest,
    digestJson(contract),
    "contract truth-source digest",
  );
  assertValid("decision-register", decisionRegister);
  assertValid("impact-map", impactMap);
  assertValid("verifier-registry", verifierRegistry);
  assertValid("spec-index", flow.specIndex);
  assertValid("task-packet", flow.taskPacket);
  assertValid("context-manifest", flow.contextManifest);
  flow.verificationResults.forEach((result) => assertValid("verification-result", result));
  assertValid("review-report", flow.reviewReport);
  assertValid("evidence-bundle", flow.evidenceBundle);
  assertValid("run-record", flow.runRecord);

  assert.deepEqual(flow.cycleResult, {
    decision: "pass",
    reasons: [],
    latestReviewRound: 0,
    highestClaimableEvidenceLevel: "runtime_stub",
    repairedFindingFingerprints: [],
  });
  assert.equal(evaluateSealedEvidenceFreshness(flow.evidenceBundle, flow.freshnessCurrent).fresh, true);
  assert.equal(flow.evidenceBundle.declaredMaximumLevel, "runtime_stub");
  assert.deepEqual(flow.evidenceBundle.activation, {
    status: "candidate",
    externalTargetRequired: true,
    baseRevision: flow.taskPacket.baseRevision,
    subjectContentDigest: flow.evidenceBundle.subjectContentDigest,
  });
  assert.equal(flow.evidenceBundle.levels.find((entry) => entry.level === "production").status, "not_claimed");
});

test("golden control proposal is judged by base control and remains a candidate after Owner acceptance", () => {
  const flow = buildControlProposalFlow();

  assertValid("spec-index", flow.specIndex);
  assertValid("task-packet", flow.taskPacket);
  assertValid("context-manifest", flow.contextManifest);
  flow.verificationResults.forEach((result) => assertValid("verification-result", result));
  assertValid("review-report", flow.reviewReport);
  assertValid("authority-receipt", flow.ownerReceipt);
  assertValid("evidence-bundle", flow.evidenceBundle);
  assertValid("run-record", flow.acceptedRun);

  assert.equal(flow.taskPacket.taskKind, "control_plane");
  assert.deepEqual(flow.taskPacket.verification.requiredAuthorityKinds, ["owner_acceptance"]);
  assert.deepEqual(flow.taskPacket.assets.classifiedWrites, [{
    path: "src/core/evidence.mjs",
    assetClass: "active_control",
  }]);

  const registryBinding = flow.taskPacket.controlBinding.components.find(
    (entry) => entry.componentId === "verifier_registry",
  );
  const baseTargetVerifier = flow.baseVerifierRegistry.verifiers.find(
    (entry) => entry.verifierId === "VER-CONTROL-TARGET",
  );
  const candidateTargetVerifier = flow.candidateVerifierRegistry.verifiers.find(
    (entry) => entry.verifierId === "VER-CONTROL-TARGET",
  );
  const targetResult = flow.verificationResults.find(
    (entry) => entry.verifierId === "VER-CONTROL-TARGET",
  );
  assert.equal(registryBinding.digest, digestJson(flow.baseVerifierRegistry));
  assert.notEqual(registryBinding.digest, digestJson(flow.candidateVerifierRegistry));
  assert.equal(targetResult.definitionDigest, digestJson(baseTargetVerifier));
  assert.notEqual(targetResult.definitionDigest, digestJson(candidateTargetVerifier));

  assert.equal(flow.evidenceBundle.declaredMaximumLevel, "owner");
  assert.equal(flow.evidenceBundle.authorityReceipts.length, 1);
  assert.deepEqual(flow.evidenceBundle.activation, {
    status: "candidate",
    externalTargetRequired: true,
    baseRevision: flow.taskPacket.baseRevision,
    subjectContentDigest: flow.evidenceBundle.subjectContentDigest,
  });
  assert.equal(flow.acceptedRun.state, "accepted");
  assert.equal(flow.evidenceBundle.activation.status, "candidate");
  assert.equal(Object.hasOwn(flow.evidenceBundle.activation, "targetRevision"), false);
  assert.equal(evaluateSealedEvidenceFreshness(flow.evidenceBundle, flow.freshnessCurrent).fresh, true);
});

test("an unresolved decision remains blocked even after an unrelated stage is authorized", () => {
  const register = structuredClone(decisionRegister);
  register.stageGates.push({
    stageId: "STAGE-IMPLEMENTATION-AUTH",
    title: "Authorized implementation boundary",
    status: "authorized",
    blockingDecisionIds: [],
    evidenceRequired: [],
    authorizationBoundary: "Implementation is authorized but unrelated product decisions still apply.",
  });
  const { compilation } = compileMinimalTask({
    evidenceTargetDecisionIds: [],
    stageId: "STAGE-IMPLEMENTATION-AUTH",
    taskKind: "implementation",
    register,
  });
  assert.equal(compilation.status, "blocked");
  assert.deepEqual(compilation.blockingDecisionIds, ["DEC-CASE-001"]);

  const blockedReview = {
    schemaVersion: 2,
    reportId: "REVIEW-BLOCKED-DECISION",
    taskId: compilation.taskPacket.taskId,
    baselineId: compilation.taskPacket.baselineId,
    specDigest: compilation.taskPacket.specDigest,
    taskPacketDigest: digestJson(compilation.taskPacket),
    controlDigest: compilation.taskPacket.controlDigest,
    subjectContentDigest: digestJson({ baseRevision: compilation.taskPacket.baseRevision, entries: [] }),
    subjectRevision: compilation.taskPacket.baseRevision,
    reviewRound: 0,
    implementerContextId: "agent:implementer:blocked",
    reviewContextId: "agent:reviewer:blocked",
    contextDigest: computeReviewContextDigest({
      reviewContextId: "agent:reviewer:blocked",
      subjectRevision: compilation.taskPacket.baseRevision,
      subjectContentDigest: digestJson({ baseRevision: compilation.taskPacket.baseRevision, entries: [] }),
      taskPacketDigest: digestJson(compilation.taskPacket),
      controlDigest: compilation.taskPacket.controlDigest,
      verificationResults: [],
    }),
    createdAt: "2026-08-27T00:30:00Z",
    verdict: "blocked",
    verificationResultRefs: [],
    verificationResultDigests: [],
    evidence: [],
    findings: [],
    blockingDecisionIds: compilation.blockingDecisionIds,
    profileId: compilation.taskPacket.review.profileId,
    lensCoverage: compilation.taskPacket.review.mandatoryLensIds.map((lensId) => ({
      lensId,
      status: "blocked",
      decisionId: compilation.blockingDecisionIds[0],
    })),
    summary: "Implementation cannot proceed before the product decision is resolved.",
  };
  assertValid("review-report", blockedReview);
  const cycle = evaluateCycle({
    policy: config.automationPolicy,
    taskPacket: compilation.taskPacket,
    reviewReports: [blockedReview],
  });
  assert.equal(cycle.decision, "blocked");
  assert.equal(cycle.reasons[0].code, "UNRESOLVED_DECISION");
});

test("task compilation rejects writes outside the task kind asset class", () => {
  const truthImpactMap = {
    ...impactMap,
    rules: [
      ...impactMap.rules,
      {
        ruleId: "RULE-PROTECTED-BASELINE",
        pathPatterns: ["examples/minimal/ai-dev/**"],
        requirementIds: ["REQ-NORM-001"],
        acceptanceIds: ["AT-NORM-001"],
        verifierIds: ["VER-NORMALIZE-RUNTIME"],
      },
    ],
  };
  const register = structuredClone(decisionRegister);
  register.status = "resolved";
  register.stageGates[0].status = "authorized";
  Object.assign(register.decisions[0], {
    status: "resolved",
    selectedOptionId: "OPT-PRESERVE",
    decidedBy: "Owner",
    resolvedAt: "2026-08-27T00:00:00Z",
    resolutionEvidence: ["owner://decisions/DEC-CASE-001"],
  });
  assert.throws(
    () => compileMinimalTask({
      changedPaths: ["examples/minimal/ai-dev/baseline.json"],
      map: truthImpactMap,
      evidenceTargetDecisionIds: [],
      taskKind: "implementation",
      register,
    }),
    (error) => error?.code === "asset_write_forbidden"
      && error.details.violations[0].assetClass === "active_truth",
  );
});

test("the same finding fingerprint stops repeated automatic repair", () => {
  const { compilation } = compileMinimalTask();
  const first = makeFinding({
    findingId: "FINDING-A-001",
    summary: "Whitespace is not collapsed.",
    observed: "Two spaces remain.",
  });
  const repeated = { ...first, findingId: "FINDING-A-002" };
  const reports = [
    makeFailingReview(compilation.taskPacket, 0, first),
    makeFailingReview(compilation.taskPacket, 1, repeated),
  ];
  reports.forEach((report) => assertValid("review-report", report));

  const cycle = evaluateCycle({
    policy: config.automationPolicy,
    taskPacket: compilation.taskPacket,
    reviewReports: reports,
  });
  assert.equal(cycle.decision, "blocked");
  assert.equal(cycle.reasons[0].code, "SAME_FINDING_REPEATED");
});

test("an A-B-A finding pattern stops oscillating automatic repair", () => {
  const { compilation } = compileMinimalTask();
  const findingA = makeFinding({
    findingId: "FINDING-OSC-A",
    summary: "Whitespace is not collapsed.",
    observed: "Two spaces remain.",
  });
  const findingB = makeFinding({
    findingId: "FINDING-OSC-B",
    summary: "Letter case changed.",
    observed: "Uppercase input became lowercase.",
  });
  const findingAAgain = { ...findingA, findingId: "FINDING-OSC-A2" };
  const reports = [findingA, findingB, findingAAgain].map((finding, round) =>
    makeFailingReview(compilation.taskPacket, round, finding));

  const cycle = evaluateCycle({
    policy: config.automationPolicy,
    taskPacket: compilation.taskPacket,
    reviewReports: reports,
  });
  assert.equal(cycle.decision, "blocked");
  assert.equal(cycle.reasons[0].code, "REPAIR_OSCILLATION");
});

test("evidence becomes stale when its subject, context, or verifier definition changes", () => {
  const flow = buildReadyFlow();
  const firstVerifierId = flow.verificationResults[0].verifierId;
  const freshness = evaluateEvidenceFreshness(flow.evidenceBundle, {
    ...flow.freshnessCurrent,
    specDigest: sha256("changed specification"),
    subjectContentDigest: sha256("changed subject content"),
    contextManifestDigest: sha256("changed context"),
    verifierDefinitionDigests: {
      ...flow.freshnessCurrent.verifierDefinitionDigests,
      [firstVerifierId]: sha256("changed verifier definition"),
    },
  });
  const codes = new Set(freshness.reasons.map((reason) => reason.code));
  assert.equal(freshness.fresh, false);
  assert.equal(codes.has("EVIDENCE_SPEC_STALE"), true);
  assert.equal(codes.has("EVIDENCE_SUBJECT_CONTENT_STALE"), true);
  assert.equal(codes.has("EVIDENCE_CONTEXT_STALE"), true);
  assert.equal(codes.has("EVIDENCE_VERIFIER_STALE"), true);
});

test("minimal context selects line excerpts and excludes unrelated specification and contracts", () => {
  const flow = buildReadyFlow();
  assert.equal(flow.contextManifest.stageId, "STAGE-CASE-FOLDING");
  assert.equal(flow.contextManifest.taskKind, "evidence_collection");
  assert.equal(flow.contextManifest.stageGate.status, "blocked");
  const specItems = flow.contextManifest.items.filter((item) => item.kind === "spec_excerpt");
  const selectedLines = new Set(specItems.map((item) => item.startLine));
  const unrelatedRequirementLine = flow.specIndex.requirements.find((entry) => entry.id === "REQ-DOC-001").line;
  const unrelatedAcceptanceLine = flow.specIndex.acceptanceCases.find((entry) => entry.id === "AT-DOC-001").line;

  assert.equal(specItems.every((item) => item.startLine === item.endLine), true);
  assert.equal(selectedLines.has(unrelatedRequirementLine), false);
  assert.equal(selectedLines.has(unrelatedAcceptanceLine), false);
  assert.equal(flow.contextManifest.items.some((item) => item.path.endsWith("documentation.contract.json")), false);
  assert.equal(flow.contextManifest.items.some((item) => item.path.endsWith("normalize.contract.json")), true);
  assert.deepEqual(flow.contextManifest.exclusions, [{
    path: "examples/minimal/README.md",
    reason: "excluded by task context hint",
  }]);
  assert.equal(JSON.stringify(flow.contextManifest).includes("The example should identify its public operation"), false);
});
