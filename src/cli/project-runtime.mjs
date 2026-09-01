import path from "node:path";

import {
  buildAssetPolicy,
  classifyAssetPatterns,
  digestJson,
  evaluateTaskAssetWrites,
  TASK_KIND_WRITE_CLASSES,
  validateFindingFingerprint,
  validateScope,
} from "../core/index.mjs";
import {
  analyzeImpact,
  requiredAuthorityKindsForEvidenceLevel,
  requiredMachineEvidenceLevelsForEvidenceLevel,
  validateTaskAuthorizationSnapshot,
} from "../task/index.mjs";
import {
  assertObjectKeys,
  assertProjectSchema,
  ensureWithinDirectory,
  listJsonArtifacts,
  operationError,
  readProjectJson,
  resolveArtifactReference,
} from "./project-artifacts.mjs";
import { normalizeRepoPath, validateRelativePath } from "./path-safety.mjs";
import { inspectGitRepository, resolveBaseRevision } from "../verify/git-scope.mjs";
import { validateReviewCoverage } from "../workflow/review-coverage.mjs";

export const IMPACT_MAP_PATH = "ai-dev/impact-map.json";
export const VERIFIER_REGISTRY_PATH = "ai-dev/verifiers/registry.json";

export function canonicalSource(baseline) {
  const source = baseline.truthSources.find((entry) => entry.sourceId === baseline.canonicalSpecSourceId);
  if (!source) operationError("CANONICAL_SPEC_UNDECLARED", "baseline does not identify its canonical source");
  return source;
}

export function defaultSpecIndexPath(config, specIndexDigest) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(specIndexDigest ?? "")) {
    operationError("SPEC_INDEX_DIGEST_INVALID", "content-addressed SpecIndex output requires the full SpecIndex digest");
  }
  return normalizeRepoPath(path.posix.join(
    config.paths.generated,
    "spec-index",
    `${specIndexDigest.slice("sha256:".length)}.json`,
  ));
}

export function defaultContextPath(config, taskId, manifestDigest = null) {
  const fileName = /^sha256:[a-f0-9]{64}$/u.test(manifestDigest ?? "")
    ? `${manifestDigest.slice("sha256:".length)}.json`
    : `${taskId}.json`;
  return normalizeRepoPath(path.posix.join(config.paths.generated, "contexts", fileName));
}

export async function readRequest(ctx, inputPath) {
  if (!inputPath) operationError("REQUEST_PATH_MISSING", "--input is required");
  return readProjectJson(ctx.projectRoot, validateRelativePath(inputPath));
}

export async function readDecisionRegister(ctx) {
  const relativePath = ensureWithinDirectory(
    ctx.baseline.decisionRegister,
    ctx.config.paths.decisions,
    "decision register",
  );
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "decision-register", "decision register", value);
  return { value, path: relativePath };
}

export async function readVerifierRegistry(ctx) {
  const value = await readProjectJson(ctx.projectRoot, VERIFIER_REGISTRY_PATH);
  await assertProjectSchema(ctx.projectRoot, "verifier-registry", "verifier registry", value);
  return value;
}

export async function readImpactMap(ctx) {
  const value = await readProjectJson(ctx.projectRoot, IMPACT_MAP_PATH);
  await assertProjectSchema(ctx.projectRoot, "impact-map", "impact map", value);
  if (value.baselineId !== ctx.baseline.baselineId) {
    operationError("IMPACT_BASELINE_MISMATCH", "impact map belongs to a different baseline");
  }
  return value;
}

export async function readSpecIndex(ctx) {
  const source = canonicalSource(ctx.baseline);
  const git = await inspectGitRepository(ctx.projectRoot);
  if (!git.ok) operationError("SPEC_INDEX_GIT_REQUIRED", "SpecIndex selection requires the current full base commit", { errors: git.errors });
  const directory = normalizeRepoPath(path.posix.join(ctx.config.paths.generated, "spec-index"));
  const candidates = [];
  for (const relativePath of await listJsonArtifacts(ctx.projectRoot, directory)) {
    const value = await readProjectJson(ctx.projectRoot, relativePath);
    await assertProjectSchema(ctx.projectRoot, "spec-index", "SpecIndex", value);
    const fullDigest = digestJson(value);
    if (relativePath !== defaultSpecIndexPath(ctx.config, fullDigest)) {
      operationError("SPEC_INDEX_ADDRESS_MISMATCH", "SpecIndex filename does not match its full canonical digest", {
        path: relativePath,
        expected: defaultSpecIndexPath(ctx.config, fullDigest),
      });
    }
    if (
      value.baselineId === ctx.baseline.baselineId
      && value.spec?.digest === source.digest
      && value.provenance?.baseRevision === git.headRevision
    ) candidates.push({ value, path: relativePath, specIndexDigest: fullDigest });
  }
  if (candidates.length !== 1) {
    operationError("SPEC_INDEX_STALE", "SpecIndex is not bound to the active baseline and canonical digest", {
      status: "fail",
      candidateCount: candidates.length,
    });
  }
  const [{ value, path: relativePath, specIndexDigest }] = candidates;
  if (value.integrity?.status !== "pass") {
    operationError("SPEC_INDEX_FAILED", "SpecIndex reports failed integrity", {
      status: "fail",
      errors: value.integrity?.errors ?? [],
    });
  }
  return { value, path: relativePath, specIndexDigest };
}

export async function loadTask(ctx, argument) {
  const relativePath = resolveArtifactReference(ctx.config.paths.tasks, argument, "task");
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "task-packet", "task packet", value);
  return { value, path: relativePath };
}

export async function taskSemanticErrors(ctx, taskPacket, registry = null) {
  const source = canonicalSource(ctx.baseline);
  const verifierRegistry = registry ?? await readVerifierRegistry(ctx);
  const decisionRegister = (await readDecisionRegister(ctx)).value;
  const [impactMap, specIndexLoaded] = await Promise.all([readImpactMap(ctx), readSpecIndex(ctx)]);
  const errors = [];
  if (ctx.baseline.status !== "active") {
    errors.push({ code: "BASELINE_NOT_ACTIVE", message: "product task requires an active baseline" });
  }
  if (taskPacket.baselineId !== ctx.baseline.baselineId) {
    errors.push({ code: "TASK_BASELINE_MISMATCH", message: "task baselineId differs from the project baseline" });
  }
  if (taskPacket.specDigest !== source.digest) {
    errors.push({ code: "TASK_SPEC_MISMATCH", message: "task specDigest differs from the canonical source" });
  }
  if (taskPacket.specIndexDigest !== specIndexLoaded.specIndexDigest) {
    errors.push({ code: "TASK_SPEC_INDEX_MISMATCH", message: "task specIndexDigest differs from the active content-addressed SpecIndex" });
  }
  if (taskPacket.truthDigest !== digestJson(taskPacket.truthBinding?.components ?? [])) {
    errors.push({ code: "TASK_TRUTH_BINDING_INVALID", message: "task truthDigest does not match its explainable components" });
  }
  if (taskPacket.controlDigest !== digestJson({
    components: taskPacket.controlBinding?.components ?? [],
    assetPolicyDigest: taskPacket.controlBinding?.assetPolicyDigest,
    instructionChainDigest: taskPacket.controlBinding?.instructionChainDigest,
  })) {
    errors.push({ code: "TASK_CONTROL_BINDING_INVALID", message: "task controlDigest does not match its explainable components" });
  }
  const resolvedBase = await resolveBaseRevision(ctx.projectRoot, taskPacket.baseRevision);
  if (!resolvedBase.ok || resolvedBase.revision !== taskPacket.baseRevision) {
    errors.push({ code: "TASK_BASE_REVISION_NOT_FULL", message: "task baseRevision must be the full immutable commit id" });
  }
  errors.push(...validateTaskAuthorizationSnapshot(taskPacket, decisionRegister));
  const currentStage = (decisionRegister.stageGates ?? []).find(
    (entry) => entry.stageId === taskPacket.stageId,
  );
  if (currentStage) {
    if (taskPacket.taskKind !== "evidence_collection" && currentStage.status !== "authorized") {
      errors.push({ code: "TASK_STAGE_NOT_AUTHORIZED", message: "task requires a currently authorized stage gate" });
    }
    if (
      taskPacket.taskKind === "evidence_collection"
      && !["pending", "blocked", "ready"].includes(currentStage.status)
    ) {
      errors.push({ code: "TASK_EVIDENCE_STAGE_INVALID", message: "evidence collection stage is not eligible" });
    }
  }
  for (const dependency of taskPacket.decisionDependencies ?? []) {
    const unresolvedAllowed = taskPacket.taskKind === "evidence_collection"
      && dependency.status === "unresolved";
    if (!unresolvedAllowed && (dependency.status !== "resolved" || (dependency.evidenceRefs ?? []).length === 0)) {
      errors.push({
        code: "TASK_DECISION_UNRESOLVED",
        message: "task has an unresolved or unproven decision dependency",
        decisionId: dependency.decisionId,
      });
    }
  }
  const scope = validateScope({
    allowedPaths: taskPacket.scope?.allowedPaths,
    forbiddenPaths: taskPacket.scope?.forbiddenPaths,
    controlPaths: [],
    changedPaths: [],
    allowEmptyAllowed: taskPacket.taskKind === "evidence_collection",
  });
  errors.push(...scope.errors);
  const assetPolicy = buildAssetPolicy({ config: ctx.config, baseline: ctx.baseline, impactMap });
  const assetCheck = evaluateTaskAssetWrites({
    taskKind: taskPacket.taskKind,
    paths: taskPacket.scope?.allowedPaths ?? [],
    policy: assetPolicy,
  });
  errors.push(...assetCheck.violations);
  const subjectPaths = [...new Set(taskPacket.scope?.subjectPaths ?? [])].sort();
  const allowedPaths = [...new Set(taskPacket.scope?.allowedPaths ?? [])].sort();
  const expectedAllowedPaths = taskPacket.taskKind === "evidence_collection" ? [] : subjectPaths;
  if (digestJson(allowedPaths) !== digestJson(expectedAllowedPaths)) {
    errors.push({ code: "TASK_SCOPE_BINDING_INVALID", message: "task write scope must exactly match its declared subject paths for this task kind" });
  }
  const expectedWriteClasses = TASK_KIND_WRITE_CLASSES[taskPacket.taskKind] ?? [];
  if (digestJson(taskPacket.assets?.allowedWriteClasses ?? []) !== digestJson(expectedWriteClasses)
    || digestJson(taskPacket.repairPolicy?.allowedWriteClasses ?? []) !== digestJson(expectedWriteClasses)) {
    errors.push({ code: "TASK_ASSET_CLASSES_INVALID", message: "task and repair asset classes do not match the task kind" });
  }
  if (digestJson(taskPacket.assets?.classifiedWrites ?? []) !== digestJson(assetCheck.classified)
    || digestJson(taskPacket.assets?.declaredScope ?? []) !== digestJson(classifyAssetPatterns(subjectPaths, assetPolicy))) {
    errors.push({ code: "TASK_ASSET_BINDING_INVALID", message: "task asset classification differs from Active Control" });
  }
  try {
    const plannedImpact = analyzeImpact({
      changedPaths: subjectPaths,
      impactMap,
      baselineId: taskPacket.baselineId,
      requireAllPathsMapped: taskPacket.taskKind === "implementation" || taskPacket.taskKind === "evidence_collection",
    });
    for (const [field, actualValues, declaredValues] of [
      ["requirements", [...plannedImpact.impactedRequirementIds, ...plannedImpact.globalInvariantIds], taskPacket.requirementIds ?? []],
      ["acceptance", plannedImpact.acceptanceIds, taskPacket.acceptanceIds ?? []],
      ["verifiers", plannedImpact.verifierIds, taskPacket.verification?.verifierIds ?? []],
      ["impact rules", plannedImpact.matchedRuleIds, taskPacket.derivation?.matchedImpactRuleIds ?? []],
    ]) {
      const expanded = [...new Set(actualValues)].filter((entry) => !declaredValues.includes(entry));
      if (expanded.length > 0) {
        errors.push({ code: "TASK_IMPACT_BINDING_INVALID", message: `task under-declares planned ${field} impact`, field, expanded });
      }
    }
  } catch (error) {
    errors.push({ code: "TASK_IMPACT_INVALID", message: error.message, detailCode: error.code ?? null, ...(error.details ?? {}) });
  }
  const byId = new Map((verifierRegistry.verifiers ?? []).map((entry) => [entry.verifierId, entry]));
  for (const verifierId of taskPacket.verification?.verifierIds ?? []) {
    const verifier = byId.get(verifierId);
    if (!verifier) {
      errors.push({ code: "VERIFIER_UNKNOWN", message: "task references an unknown verifier", verifierId });
    } else if (verifier.deterministic !== true) {
      errors.push({ code: "VERIFIER_NOT_DETERMINISTIC", message: "task references a non-deterministic verifier", verifierId });
    }
  }
  const requiredLevel = taskPacket.verification?.requiredEvidenceLevel;
  const selected = (taskPacket.verification?.verifierIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  const requiredMachineLevels = requiredMachineEvidenceLevelsForEvidenceLevel(requiredLevel);
  const missingMachineLevels = requiredMachineLevels.filter(
    (level) => !selected.some((entry) => entry.evidenceLevel === level),
  );
  if (missingMachineLevels.length > 0) {
    errors.push({
      code: "EVIDENCE_CHAIN_UNREACHABLE",
      message: "selected verifiers cannot produce the continuous machine evidence chain",
      missingEvidenceLevels: missingMachineLevels,
    });
  }
  const expectedAuthorityKinds = requiredAuthorityKindsForEvidenceLevel(requiredLevel);
  const actualAuthorityKinds = [...(taskPacket.verification?.requiredAuthorityKinds ?? [])].sort();
  if (
    expectedAuthorityKinds.length !== actualAuthorityKinds.length
    || expectedAuthorityKinds.some((entry, index) => entry !== actualAuthorityKinds[index])
  ) {
    errors.push({
      code: "AUTHORITY_REQUIREMENTS_STALE",
      message: "task authority receipt requirements do not match its required evidence level",
      expected: expectedAuthorityKinds,
      actual: actualAuthorityKinds,
    });
  }
  return errors;
}

export async function loadReview(ctx, argument) {
  const relativePath = resolveArtifactReference(ctx.config.paths.reviews, argument, "review");
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "review-report", "review report", value);
  return { value, path: relativePath };
}

export function reviewSemanticErrors(ctx, report, taskPacket) {
  const errors = [];
  for (const [field, expected] of [
    ["taskId", taskPacket.taskId],
    ["baselineId", taskPacket.baselineId],
    ["specDigest", taskPacket.specDigest],
    ["taskPacketDigest", digestJson(taskPacket)],
    ["controlDigest", taskPacket.controlDigest],
  ]) {
    if (report[field] !== expected) {
      errors.push({ code: "REVIEW_TASK_BINDING_MISMATCH", message: `review ${field} differs from its task`, field });
    }
  }
  errors.push(...validateReviewCoverage(report, taskPacket).errors);
  if (
    ctx.config.automationPolicy.implementerCannotReviewOwnTask
    && report.implementerContextId === report.reviewContextId
  ) {
    errors.push({ code: "REVIEW_SELF_REVIEW", message: "implementer context cannot review its own task" });
  }
  for (const finding of report.findings ?? []) {
    const result = validateFindingFingerprint(finding);
    if (!result.ok) {
      errors.push({
        code: "FINDING_FINGERPRINT_INVALID",
        message: "finding fingerprint does not match normalized content",
        findingId: finding.findingId,
        expected: result.expected,
        actual: result.actual,
      });
    }
  }
  if (report.verdict === "pass" && (report.findings ?? []).length > 0) {
    errors.push({ code: "PASS_WITH_FINDINGS", message: "a passing review cannot contain findings" });
  }
  return errors;
}

export function generatedReference(ctx, argument, label) {
  return ensureWithinDirectory(validateRelativePath(argument), ctx.config.paths.generated, label);
}

export async function loadVerificationResult(ctx, argument) {
  const relativePath = generatedReference(ctx, argument, "verification result");
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "verification-result", "verification result", value);
  return { value, path: relativePath };
}

export async function loadRun(ctx, argument) {
  const relativePath = resolveArtifactReference(ctx.config.paths.runs, argument, "run");
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "run-record", "run record", value);
  return { value, path: relativePath };
}

export async function loadContext(ctx, argument, taskId = null) {
  const candidate = argument ?? defaultContextPath(ctx.config, taskId);
  const relativePath = generatedReference(ctx, candidate, "context manifest");
  const value = await readProjectJson(ctx.projectRoot, relativePath);
  await assertProjectSchema(ctx.projectRoot, "context-manifest", "context manifest", value);
  return { value, path: relativePath };
}

export function validateRequest(value, allowed, required) {
  return assertObjectKeys(value, allowed, required);
}
