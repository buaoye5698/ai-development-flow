import path from "node:path";

import { digestJson } from "../core/index.mjs";
import { aggregateRunMetrics, deriveRunMetrics } from "../metrics/index.mjs";
import { analyzeImpact } from "../task/impact-analysis.mjs";
import { advanceRun, inspectRun, validateBaseControlBinding, withBoundRunOperation } from "../controller/index.mjs";
import { digestDeclaredInputs } from "../verify/cache.mjs";
import {
  adjudicateWorkflowCycle,
  compareVerificationBindingSet,
  evaluateSealedEvidenceFreshness,
  normalizeReferencedVerificationResults,
  sealEvidenceBundle,
} from "../workflow/index.mjs";
import {
  computeSubjectContentSnapshot,
  computeWorktreeSnapshot,
  frameworkProcessArtifactPrefixes,
  inspectGitRepository,
} from "../verify/git-scope.mjs";
import {
  assertObjectKeys,
  assertProjectSchema,
  ensureWithinDirectory,
  guardedOperation,
  listJsonArtifacts,
  loadHealthyProject,
  operationError,
  readProjectJson,
  writeJsonArtifact,
} from "./project-artifacts.mjs";
import {
  loadContext,
  loadReview,
  loadRun,
  loadTask,
  loadVerificationResult,
  readRequest,
  reviewSemanticErrors,
} from "./project-runtime.mjs";
import { normalizeRepoPath, validateRelativePath } from "./path-safety.mjs";

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    operationError("REQUEST_INVALID", `${label} must be an array of non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    operationError("REQUEST_INVALID", `${label} must not contain duplicates`);
  }
  return values;
}

async function verificationEntries(ctx, references) {
  const result = [];
  for (const reference of uniqueStrings(references ?? [], "verificationResults")) {
    result.push({ reference, result: (await loadVerificationResult(ctx, reference)).value });
  }
  return normalizeReferencedVerificationResults(result).map((entry) => ({
    reference: entry.reference,
    result: entry.result,
  }));
}

async function reviewEntries(ctx, references) {
  const result = [];
  for (const reference of uniqueStrings(references ?? [], "reviewReports")) {
    result.push({ reference, report: (await loadReview(ctx, reference)).value });
  }
  return result;
}

async function authorityReceipts(ctx, references) {
  const authorityDirectory = normalizeRepoPath(path.posix.join(ctx.config.paths.evidence, "authority"));
  const receipts = [];
  for (const reference of uniqueStrings(references ?? [], "authorityReceiptRefs")) {
    const relativePath = ensureWithinDirectory(
      validateRelativePath(reference),
      authorityDirectory,
      "authority receipt",
    );
    const receipt = await readProjectJson(ctx.projectRoot, relativePath);
    await assertProjectSchema(ctx.projectRoot, "authority-receipt", "authority receipt", receipt);
    receipts.push({ reference: relativePath, receipt });
  }
  return receipts;
}

export function validateReviewCommand({ project, review }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const loaded = await loadReview(ctx, review);
    const { value: taskPacket } = await loadTask(ctx, loaded.value.taskId);
    const errors = reviewSemanticErrors(ctx, loaded.value, taskPacket);
    const entries = await verificationEntries(ctx, loaded.value.verificationResultRefs);
    const bindings = compareVerificationBindingSet({
      expectedRefs: loaded.value.verificationResultRefs,
      expectedDigests: loaded.value.verificationResultDigests,
      actualEntries: normalizeReferencedVerificationResults(entries),
      contextDigest: loaded.value.contextDigest,
      reviewContextId: loaded.value.reviewContextId,
      subjectRevision: loaded.value.subjectRevision,
      subjectContentDigest: loaded.value.subjectContentDigest,
      taskPacketDigest: loaded.value.taskPacketDigest,
      controlDigest: loaded.value.controlDigest,
    });
    errors.push(...bindings.errors);
    return {
      status: errors.length === 0 ? "pass" : "blocked",
      code: errors.length === 0 ? undefined : "REVIEW_NOT_VALID",
      target: ctx.projectRoot,
      reviewPath: loaded.path,
      reportId: loaded.value.reportId,
      verificationResultCount: entries.length,
      errors,
      warnings: ctx.warnings,
    };
  });
}

export function evaluateCycleCommand({ project, input }) {
  return guardedOperation(async () => {
    const requestContext = await loadHealthyProject(project);
    const request = assertObjectKeys(await readRequest(requestContext, input), [
      "run",
      "expectedRunDigest",
      "at",
      "reviewReports",
      "authorityReceiptRefs",
    ], ["run", "expectedRunDigest", "at"]);
    return withBoundRunOperation({
      project,
      runId: request.run,
      expectedRunDigest: request.expectedRunDigest,
      at: request.at,
    }, async ({ ctx, inspection, runRecord, taskPacket }) => {
      const [results, reviews, receipts] = await Promise.all([
        verificationEntries(ctx, runRecord.verificationResultRefs),
        reviewEntries(ctx, request.reviewReports ?? runRecord.reviewReportRefs),
        authorityReceipts(ctx, request.authorityReceiptRefs ?? []),
      ]);
      const adjudication = adjudicateWorkflowCycle({
        runRecord,
        taskPacket,
        baseline: inspection.baseControl.active.baseline,
        projectConfig: inspection.baseControl.active.config,
        verificationResults: results,
        reviewReports: reviews.map((entry) => entry.report),
        authorityReceipts: receipts,
        changedPaths: inspection.scope.changedPaths,
        requestedChangePaths: inspection.scope.changedPaths,
        judgePaths: inspection.baseControl.active.config.automationPolicy.controlPaths,
      });
      return {
        status: ["accept", "repair", "review", "verify"].includes(adjudication.decision)
          ? "pass"
          : "blocked",
        target: ctx.projectRoot,
        runId: runRecord.runId,
        runDigest: digestJson(runRecord),
        adjudication,
        errors: adjudication.decision === "escalate" || adjudication.decision === "blocked"
          ? adjudication.reasons
          : [],
        warnings: ctx.warnings,
      };
    });
  });
}

function assertEvidenceSealRequest(request) {
  return assertObjectKeys(request, [
      "bundleId",
      "createdAt",
      "run",
      "expectedRunDigest",
      "reviewReports",
      "authorityReceiptRefs",
      "limitations",
      "exclusions",
    ], ["bundleId", "createdAt", "run", "expectedRunDigest", "reviewReports"]);
}

async function sealEvidenceRequest({ project, request, output = null, dryRun = false }) {
  return withBoundRunOperation({
      project,
      runId: request.run,
      expectedRunDigest: request.expectedRunDigest,
      at: request.createdAt,
    }, async ({ ctx, inspection, runRecord, taskPacket }) => {
    const contextManifest = (await loadContext(ctx, runRecord.contextManifestRef, taskPacket.taskId)).value;
    const [results, reviews, receipts] = await Promise.all([
      verificationEntries(ctx, runRecord.verificationResultRefs),
      reviewEntries(ctx, request.reviewReports),
      authorityReceipts(ctx, request.authorityReceiptRefs ?? []),
    ]);
    const baseControl = inspection.baseControl;
    const subjectRoot = inspection.identity.path;
    const subjectContent = inspection.subject;
    const actualImpact = subjectContent.changedPaths.length > 0
      ? analyzeImpact({
        changedPaths: subjectContent.changedPaths,
        impactMap: baseControl.active.impactMap,
        baselineId: taskPacket.baselineId,
        requireAllPathsMapped: taskPacket.taskKind === "implementation" || taskPacket.taskKind === "evidence_collection",
      })
      : {
        changedPaths: [],
        matchedRuleIds: [],
        impactedRequirementIds: taskPacket.requirementIds,
        globalInvariantIds: [],
        acceptanceIds: taskPacket.acceptanceIds,
        verifierIds: taskPacket.verification.verifierIds,
      };
    for (const [field, actualValues, declaredValues] of [
      ["requirements", [...actualImpact.impactedRequirementIds, ...actualImpact.globalInvariantIds], taskPacket.requirementIds],
      ["acceptance", actualImpact.acceptanceIds, taskPacket.acceptanceIds],
      ["verifiers", actualImpact.verifierIds, taskPacket.verification.verifierIds],
    ]) {
      const expanded = [...new Set(actualValues)].filter((entry) => !declaredValues.includes(entry));
      if (expanded.length > 0) operationError("ACTUAL_IMPACT_EXPANDED", `actual ${field} impact exceeds the TaskPacket`, { field, expanded });
    }
    const verifierById = new Map(baseControl.active.verifierRegistry.verifiers.map((entry) => [entry.verifierId, entry]));
    const currentDigests = { verifierDefinitionDigests: {}, verifierInputDigests: {} };
    for (const verifierId of results.map((entry) => entry.result.verifierId)) {
      const verifier = verifierById.get(verifierId);
      if (!verifier) operationError("VERIFIER_UNKNOWN", "base Active Control does not contain an evidence verifier", { verifierId });
      currentDigests.verifierDefinitionDigests[verifierId] = digestJson(verifier);
      currentDigests.verifierInputDigests[verifierId] = (await digestDeclaredInputs({
        projectRoot: subjectRoot,
        verifier,
        excludedPaths: frameworkProcessArtifactPrefixes(baseControl.active.config),
      })).digest;
    }
    const bundle = sealEvidenceBundle({
      frameworkVersion: ctx.lock.frameworkVersion,
      bundleId: request.bundleId,
      createdAt: request.createdAt,
      runRecord,
      taskPacket,
      baseline: baseControl.active.baseline,
      projectConfig: baseControl.active.config,
      contextManifest,
      verificationResults: results,
      reviewReports: reviews,
      authorityReceipts: receipts,
      ...currentDigests,
      subjectContent,
      actualImpact: {
        changedPaths: actualImpact.changedPaths,
        matchedImpactRuleIds: actualImpact.matchedRuleIds,
        requirementIds: [...new Set([...actualImpact.impactedRequirementIds, ...actualImpact.globalInvariantIds])].sort(),
        acceptanceIds: actualImpact.acceptanceIds,
        verifierIds: actualImpact.verifierIds,
      },
      limitations: request.limitations ?? [],
      exclusions: request.exclusions ?? [],
    });
    await assertProjectSchema(ctx.projectRoot, "evidence-bundle", "evidence bundle", bundle);
    const outputPath = output
      ? ensureWithinDirectory(output, ctx.config.paths.evidence, "evidence output")
      : normalizeRepoPath(path.posix.join(
        ctx.config.paths.evidence,
        "bundles",
        `${bundle.bundleDigest.slice("sha256:".length)}.json`,
      ));
    const artifact = await writeJsonArtifact({
      projectRoot: ctx.projectRoot,
      relativePath: outputPath,
      allowedDirectory: ctx.config.paths.evidence,
      value: bundle,
      dryRun,
    });
    const afterSeal = await computeSubjectContentSnapshot(subjectRoot, taskPacket.baseRevision, {
      excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
    });
    if (afterSeal.subjectContentDigest !== subjectContent.subjectContentDigest) {
      operationError("EVIDENCE_SUBJECT_CHANGED", "candidate content changed while evidence was being sealed");
    }
    return {
      status: "pass",
      target: ctx.projectRoot,
      outputPath,
      artifact,
      evidenceBundle: bundle,
      warnings: ctx.warnings,
      errors: [],
    };
  });
}

export function sealEvidenceCommand({ project, input, output = null, dryRun = false }) {
  return guardedOperation(async () => {
    const requestContext = await loadHealthyProject(project);
    const request = assertEvidenceSealRequest(await readRequest(requestContext, input));
    return sealEvidenceRequest({ project, request, output, dryRun });
  });
}

export function finalizeRunCommand({ project, runId, expectedRunDigest, input }) {
  return guardedOperation(async () => {
    const requestContext = await loadHealthyProject(project);
    const request = assertObjectKeys(await readRequest(requestContext, input), [
      "bundleId",
      "createdAt",
      "reason",
      "reviewReports",
      "authorityReceiptRefs",
      "limitations",
      "exclusions",
      "resolvedCapabilities",
      "usedCapabilities",
      "observations",
      "externalEffects",
    ], ["bundleId", "createdAt", "reason", "reviewReports"]);
    if (!Array.isArray(request.reviewReports) || request.reviewReports.length !== 1) {
      operationError(
        "FINALIZE_REVIEW_COUNT_INVALID",
        "ordinary finalization requires exactly one independent review report",
      );
    }
    const sealed = await sealEvidenceRequest({
      project,
      request: assertEvidenceSealRequest({
        bundleId: request.bundleId,
        createdAt: request.createdAt,
        run: runId,
        expectedRunDigest,
        reviewReports: request.reviewReports,
        authorityReceiptRefs: request.authorityReceiptRefs ?? [],
        limitations: request.limitations ?? [],
        exclusions: request.exclusions ?? [],
      }),
    });
    const advanceRequest = {
      phase: "sealed",
      at: request.createdAt,
      reason: request.reason,
      evidenceLevel: sealed.evidenceBundle.declaredMaximumLevel,
      evidenceBundleRef: sealed.outputPath,
      reviewReportRef: request.reviewReports[0],
      exclusions: sealed.evidenceBundle.exclusions,
      ...(Object.hasOwn(request, "resolvedCapabilities")
        ? { resolvedCapabilities: request.resolvedCapabilities }
        : {}),
      ...(Object.hasOwn(request, "usedCapabilities")
        ? { usedCapabilities: request.usedCapabilities }
        : {}),
      ...(Object.hasOwn(request, "observations") ? { observations: request.observations } : {}),
      ...(Object.hasOwn(request, "externalEffects") ? { externalEffects: request.externalEffects } : {}),
    };
    const advanced = await advanceRun({
      project,
      runId,
      expectedRunDigest,
      request: advanceRequest,
    });
    return {
      status: "pass",
      target: sealed.target,
      runId,
      outputPath: sealed.outputPath,
      artifact: sealed.artifact,
      evidenceBundle: sealed.evidenceBundle,
      runDigest: advanced.runDigest,
      runRecord: advanced.runRecord,
      envelope: advanced.envelope,
      warnings: sealed.warnings,
      errors: [],
    };
  });
}

export function evidenceStatusCommand({ project, bundle }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const bundlePath = ensureWithinDirectory(
      validateRelativePath(bundle),
      ctx.config.paths.evidence,
      "evidence bundle",
    );
    const evidenceBundle = await readProjectJson(ctx.projectRoot, bundlePath);
    await assertProjectSchema(ctx.projectRoot, "evidence-bundle", "evidence bundle", evidenceBundle);
    const [runLoaded, taskLoaded] = await Promise.all([
      loadRun(ctx, evidenceBundle.runId),
      loadTask(ctx, evidenceBundle.taskId),
    ]);
    const { value: runRecord } = runLoaded;
    const { value: taskPacket } = taskLoaded;
    const controllerInspection = await inspectRun({ project, runId: runRecord.runId });
    if (controllerInspection.status !== "pass") {
      operationError("RUN_BINDING_STALE", "evidence status requires the exact controller-bound worktree", {
        errors: controllerInspection.errors,
      });
    }
    const contextManifest = (await loadContext(ctx, runRecord.contextManifestRef, taskPacket.taskId)).value;
    const results = await verificationEntries(
      ctx,
      (evidenceBundle.verifierEvidence ?? []).map((entry) => entry.resultRef),
    );
    const [reviews, receipts] = await Promise.all([
      reviewEntries(ctx, evidenceBundle.reviewReportRefs ?? []),
      authorityReceipts(ctx, evidenceBundle.authorityReceiptRefs ?? []),
    ]);
    const baseControl = await validateBaseControlBinding(ctx.projectRoot, taskPacket);
    if (!baseControl.ok) {
      operationError("BASE_ACTIVE_CONTROL_MISMATCH", "evidence freshness must be judged by base Active Control", {
        errors: baseControl.errors,
      });
    }
    const subjectRoot = runRecord.workspace.identifier;
    const verifierById = new Map(
      baseControl.active.verifierRegistry.verifiers.map((entry) => [entry.verifierId, entry]),
    );
    const currentDigests = { verifierDefinitionDigests: {}, verifierInputDigests: {} };
    for (const verifierId of results.map((entry) => entry.result.verifierId)) {
      const verifier = verifierById.get(verifierId);
      if (!verifier) operationError("VERIFIER_UNKNOWN", "base Active Control no longer contains the evidence verifier", { verifierId });
      currentDigests.verifierDefinitionDigests[verifierId] = digestJson(verifier);
      currentDigests.verifierInputDigests[verifierId] = (await digestDeclaredInputs({
        projectRoot: subjectRoot,
        verifier,
        excludedPaths: frameworkProcessArtifactPrefixes(baseControl.active.config),
      })).digest;
    }
    const git = await inspectGitRepository(subjectRoot);
    if (!git.ok) {
      operationError("EVIDENCE_GIT_REQUIRED", "evidence freshness requires the current Git worktree", {
        errors: git.errors,
      });
    }
    const snapshot = await computeWorktreeSnapshot(subjectRoot, git.headRevision, {
      excludedPaths: [
        runLoaded.path,
        bundlePath,
        runRecord.contextManifestRef,
        ...(evidenceBundle.verifierEvidence ?? []).map((entry) => entry.resultRef),
        ...(evidenceBundle.reviewReportRefs ?? []),
      ].filter(Boolean),
      excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
    });
    const subjectContent = await computeSubjectContentSnapshot(subjectRoot, runRecord.baseRevision, {
      excludedPrefixes: frameworkProcessArtifactPrefixes(baseControl.active.config),
    });
    const freshness = evaluateSealedEvidenceFreshness(evidenceBundle, {
      frameworkVersion: ctx.lock.frameworkVersion,
      baseline: ctx.baseline,
      taskPacket,
      subjectRevision: snapshot.subjectRevision,
      worktreeDigest: snapshot.worktreeDigest,
      subjectContentDigest: subjectContent.subjectContentDigest,
      contextManifest,
      verificationResults: results,
      reviewReports: reviews,
      authorityReceipts: receipts,
      ...currentDigests,
    });
    return {
      status: freshness.fresh ? "pass" : "blocked",
      code: freshness.fresh ? undefined : "EVIDENCE_STALE",
      target: ctx.projectRoot,
      bundlePath,
      bundleId: evidenceBundle.bundleId,
      ...freshness,
      errors: freshness.reasons,
      warnings: ctx.warnings,
    };
  });
}

export function metricsReportCommand({ project, output = null, dryRun = false }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const metrics = [];
    for (const relativePath of await listJsonArtifacts(ctx.projectRoot, ctx.config.paths.runs)) {
      const runRecord = await readProjectJson(ctx.projectRoot, relativePath);
      await assertProjectSchema(ctx.projectRoot, "run-record", "run record", runRecord);
      const results = await verificationEntries(ctx, runRecord.verificationResultRefs);
      metrics.push(deriveRunMetrics(runRecord, {
        verificationResults: results.map((entry) => entry.result),
      }));
    }
    const report = {
      schemaVersion: 1,
      generatedFromRunCount: metrics.length,
      aggregate: aggregateRunMetrics(metrics),
      runs: metrics,
    };
    let artifact = null;
    let outputPath = null;
    if (output) {
      outputPath = ensureWithinDirectory(output, ctx.config.paths.generated, "metrics output");
      artifact = await writeJsonArtifact({
        projectRoot: ctx.projectRoot,
        relativePath: outputPath,
        allowedDirectory: ctx.config.paths.generated,
        value: report,
        dryRun,
      });
    }
    return {
      status: "pass",
      target: ctx.projectRoot,
      outputPath,
      artifact,
      report,
      warnings: ctx.warnings,
      errors: [],
    };
  });
}
