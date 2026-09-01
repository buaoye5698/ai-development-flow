import path from "node:path";

import { buildAssetPolicy, canonicalTextDigest, classifyAssetPath, digestJson, sha256 } from "../core/index.mjs";
import { buildContextManifest, compileTask, renderContextBrief } from "../task/index.mjs";
import {
  assertObjectKeys,
  assertProjectSchema,
  ensureWithinDirectory,
  guardedOperation,
  listJsonArtifacts,
  loadHealthyProject,
  operationError,
  readProjectBytes,
  readProjectJson,
  schemaErrors,
  writeJsonArtifact,
  writeTextArtifact,
} from "./project-artifacts.mjs";
import {
  canonicalSource,
  defaultContextPath,
  defaultSpecIndexPath,
  loadContext,
  loadTask,
  readDecisionRegister,
  readImpactMap,
  readRequest,
  readSpecIndex,
  readVerifierRegistry,
  reviewSemanticErrors,
  taskSemanticErrors,
} from "./project-runtime.mjs";
import { normalizeRepoPath, validateRelativePath } from "./path-safety.mjs";
import { loadSpecAdapter } from "./spec-adapter.mjs";
import {
  computeSubjectContentSnapshot,
  frameworkProcessArtifactPrefixes,
  inspectGitRepository,
  readProjectSchemaAtRevision,
  readTextAtRevision,
  resolveBaseRevision,
} from "../verify/git-scope.mjs";
import { loadActiveControl } from "../controller/index.mjs";
import { isTerminalState } from "../workflow/index.mjs";

async function schemaAtRevision(projectRoot, baseRevision, schemaName) {
  return (await readProjectSchemaAtRevision(projectRoot, baseRevision, schemaName)).value;
}

async function assertRevisionSchema(projectRoot, baseRevision, schemaName, label, value) {
  const errors = schemaErrors(label, value, await schemaAtRevision(projectRoot, baseRevision, schemaName));
  if (errors.length > 0) {
    operationError("ARTIFACT_SCHEMA_INVALID", `${label} does not satisfy base Active Control`, {
      status: "fail",
      errors,
    });
  }
  return value;
}

async function compileSpecification(ctx, {
  output = null,
  dryRun = false,
  baseRevision = null,
  activeControl = null,
} = {}) {
  let revision = baseRevision;
  if (!revision) {
    const git = await inspectGitRepository(ctx.projectRoot);
    if (!git.ok) {
      operationError("SPEC_PROVENANCE_GIT_REQUIRED", "SpecIndex provenance requires a full base commit", {
        errors: git.errors,
      });
    }
    revision = git.headRevision;
  }
  const active = activeControl ?? await loadActiveControl(ctx.projectRoot, {
    baseRevision: revision,
    taskKind: "evidence_collection",
    scope: { allowedPaths: [] },
  });
  if (active.baseRevision !== revision) {
    operationError("SPEC_PROVENANCE_GIT_REQUIRED", "SpecIndex provenance requires the requested full base commit", {
      errors: [{ code: "BASE_REVISION_MISMATCH", message: "resolved Active Control differs from the requested base" }],
    });
  }
  const source = canonicalSource(active.baseline);
  const [text, adapterText, adapterBytes] = await Promise.all([
    readTextAtRevision(ctx.projectRoot, revision, source.path),
    readTextAtRevision(ctx.projectRoot, revision, active.config.specAdapter.module),
    readProjectBytes(ctx.projectRoot, active.config.specAdapter.module),
  ]);
  const baseAdapterDigest = canonicalTextDigest(adapterText);
  if (canonicalTextDigest(adapterBytes.toString("utf8")) !== baseAdapterDigest) {
    operationError("SPEC_ADAPTER_BASE_MISMATCH", "working-tree specification adapter differs from base Active Control", {
      path: active.config.specAdapter.module,
    });
  }
  const adapter = await loadSpecAdapter(ctx.projectRoot, active.config.specAdapter);
  const specIndex = await adapter.compile({
    text,
    baselineId: active.baseline.baselineId,
    sourceId: source.sourceId,
    path: source.path,
    expectedDigest: source.digest,
    options: structuredClone(active.config.specAdapter.options ?? {}),
    provenance: {
      source: { sourceId: source.sourceId, path: source.path, digest: source.digest },
      adapter: {
        module: active.config.specAdapter.module,
        exportName: active.config.specAdapter.exportName,
        moduleDigest: baseAdapterDigest,
        configDigest: digestJson(active.config.specAdapter),
      },
      frameworkDistribution: {
        name: active.frameworkLock.frameworkName,
        version: active.frameworkLock.frameworkVersion,
        digest: active.frameworkLock.distributionDigest,
      },
      baseRevision: revision,
    },
  });
  const schema = await schemaAtRevision(ctx.projectRoot, revision, "spec-index");
  const validation = schemaErrors("SpecIndex", specIndex, schema);
  const errors = [...(specIndex.integrity?.errors ?? []), ...validation];
  if (errors.length > 0) {
    return {
      status: "fail",
      code: "SPEC_COMPILE_FAILED",
      target: ctx.projectRoot,
      errors,
      warnings: specIndex.integrity?.warnings ?? [],
      specIndex,
    };
  }
  const specIndexDigest = digestJson(specIndex);
  const outputPath = output
    ? ensureWithinDirectory(output, active.config.paths.generated, "spec output")
    : defaultSpecIndexPath(active.config, specIndexDigest);
  const artifact = await writeJsonArtifact({
    projectRoot: ctx.projectRoot,
    relativePath: outputPath,
    allowedDirectory: active.config.paths.generated,
    value: specIndex,
    dryRun,
  });
  return {
    status: "pass",
    target: ctx.projectRoot,
    outputPath,
    artifact,
    specIndex,
    specIndexDigest,
    baseRevision: revision,
    warnings: [...ctx.warnings, ...(specIndex.integrity?.warnings ?? [])],
    errors: [],
  };
}

function rejectMisplacedTaskRequest(ctx, relativePath, value) {
  const isCompilationRequest = value
    && typeof value === "object"
    && !Array.isArray(value)
    && !Object.hasOwn(value, "schemaVersion")
    && typeof value.taskId === "string"
    && typeof value.goal === "string"
    && Array.isArray(value.changedPaths)
    && Array.isArray(value.directRequirementIds);
  if (!isCompilationRequest) return;
  operationError(
    "TASK_REQUEST_MISPLACED",
    "task compilation request must be stored under generated requests, not the TaskPacket directory",
    {
      status: "fail",
      path: relativePath,
      expectedDirectory: normalizeRepoPath(path.posix.join(ctx.config.paths.generated, "requests")),
    },
  );
}

async function historicalTaskErrors(ctx, relativePath, task, runs) {
  const errors = [];
  if (task.truthDigest !== digestJson(task.truthBinding?.components ?? [])) {
    errors.push({ code: "TASK_TRUTH_BINDING_INVALID", message: "task truthDigest does not match its explainable components" });
  }
  if (task.controlDigest !== digestJson({
    components: task.controlBinding?.components ?? [],
    assetPolicyDigest: task.controlBinding?.assetPolicyDigest,
    instructionChainDigest: task.controlBinding?.instructionChainDigest,
  })) {
    errors.push({ code: "TASK_CONTROL_BINDING_INVALID", message: "task controlDigest does not match its explainable components" });
  }
  const resolvedBase = await resolveBaseRevision(ctx.projectRoot, task.baseRevision);
  if (!resolvedBase.ok || resolvedBase.revision !== task.baseRevision) {
    errors.push({ code: "TASK_BASE_REVISION_NOT_FULL", message: "task baseRevision must remain an available full commit id" });
  }
  const specIndexPath = defaultSpecIndexPath(ctx.config, task.specIndexDigest);
  const specIndex = await readProjectJson(ctx.projectRoot, specIndexPath);
  await assertProjectSchema(ctx.projectRoot, "spec-index", "historical SpecIndex", specIndex);
  if (digestJson(specIndex) !== task.specIndexDigest) {
    errors.push({ code: "TASK_SPEC_INDEX_DIGEST_INVALID", message: "historical SpecIndex content differs from the TaskPacket binding" });
  }
  for (const [field, actual, expected] of [
    ["baselineId", specIndex.baselineId, task.baselineId],
    ["specDigest", specIndex.spec?.digest, task.specDigest],
    ["baseRevision", specIndex.provenance?.baseRevision, task.baseRevision],
  ]) {
    if (actual !== expected) {
      errors.push({ code: "TASK_SPEC_INDEX_BINDING_INVALID", message: `historical SpecIndex ${field} differs from the TaskPacket`, field });
    }
  }
  const distribution = (task.controlBinding?.components ?? []).find(
    (entry) => entry.componentId === "framework_distribution",
  )?.digest;
  if (specIndex.provenance?.frameworkDistribution?.digest !== distribution) {
    errors.push({
      code: "TASK_SPEC_INDEX_BINDING_INVALID",
      message: "historical SpecIndex framework distribution differs from the TaskPacket control binding",
      field: "frameworkDistribution",
    });
  }
  const taskDigest = digestJson(task);
  for (const run of runs) {
    for (const [field, actual, expected] of [
      ["taskId", run.taskId, task.taskId],
      ["taskPacketRef", run.taskPacketRef, relativePath],
      ["taskPacketDigest", run.taskPacketDigest, taskDigest],
      ["expectedTaskDigest", run.expectedTaskDigest, taskDigest],
      ["baselineId", run.baselineId, task.baselineId],
      ["specDigest", run.specDigest, task.specDigest],
      ["baseRevision", run.baseRevision, task.baseRevision],
      ["controlDigest", run.controlDigest, task.controlDigest],
    ]) {
      if (actual !== expected) {
        errors.push({ code: "TASK_HISTORY_BINDING_INVALID", message: `terminal run ${field} differs from its TaskPacket`, runId: run.runId, field });
      }
    }
  }
  return errors;
}

export function checkProjectCommand({ project }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    await readDecisionRegister(ctx);
    await readVerifierRegistry(ctx);
    await readImpactMap(ctx);
    const specification = await compileSpecification(ctx, { dryRun: true });
    if (specification.status !== "pass") return specification;
    const checked = {
      tasks: 0,
      reviews: 0,
      runs: 0,
      evidence: 0,
      authorityReceipts: 0,
      executionAuthorizations: 0,
      contexts: 0,
    };
    const runsByTaskId = new Map();
    for (const relativePath of await listJsonArtifacts(ctx.projectRoot, ctx.config.paths.runs)) {
      const run = await readProjectJson(ctx.projectRoot, relativePath);
      await assertProjectSchema(ctx.projectRoot, "run-record", "run record", run);
      const taskRuns = runsByTaskId.get(run.taskId) ?? [];
      taskRuns.push(run);
      runsByTaskId.set(run.taskId, taskRuns);
      checked.runs += 1;
    }
    for (const relativePath of await listJsonArtifacts(ctx.projectRoot, ctx.config.paths.tasks)) {
      const task = await readProjectJson(ctx.projectRoot, relativePath);
      rejectMisplacedTaskRequest(ctx, relativePath, task);
      await assertProjectSchema(ctx.projectRoot, "task-packet", "task packet", task);
      const taskRuns = runsByTaskId.get(task.taskId) ?? [];
      const requiresCurrentSemantics = taskRuns.length === 0
        || taskRuns.some((run) => !isTerminalState(run.state));
      const errors = requiresCurrentSemantics
        ? await taskSemanticErrors(ctx, task)
        : await historicalTaskErrors(ctx, relativePath, task, taskRuns);
      if (errors.length > 0) {
        operationError("TASK_INVALID", "task packet is not execution-ready", {
          status: "fail",
          path: relativePath,
          errors,
        });
      }
      checked.tasks += 1;
    }
    for (const relativePath of await listJsonArtifacts(ctx.projectRoot, ctx.config.paths.reviews)) {
      const report = await readProjectJson(ctx.projectRoot, relativePath);
      await assertProjectSchema(ctx.projectRoot, "review-report", "review report", report);
      const { value: task } = await loadTask(ctx, report.taskId);
      const errors = reviewSemanticErrors(ctx, report, task);
      if (errors.length > 0) {
        operationError("REVIEW_INVALID", "review report is invalid", {
          status: "fail",
          path: relativePath,
          errors,
        });
      }
      checked.reviews += 1;
    }
    for (const relativePath of await listJsonArtifacts(ctx.projectRoot, ctx.config.paths.authorizations)) {
      await assertProjectSchema(
        ctx.projectRoot,
        "execution-authorization",
        "execution authorization",
        await readProjectJson(ctx.projectRoot, relativePath),
      );
      checked.executionAuthorizations += 1;
    }
    const evidenceRoot = ctx.config.paths.evidence;
    const bundleDirectory = normalizeRepoPath(path.posix.join(evidenceRoot, "bundles"));
    const authorityDirectory = normalizeRepoPath(path.posix.join(evidenceRoot, "authority"));
    const [allEvidenceJson, bundles, receipts] = await Promise.all([
      listJsonArtifacts(ctx.projectRoot, evidenceRoot),
      listJsonArtifacts(ctx.projectRoot, bundleDirectory),
      listJsonArtifacts(ctx.projectRoot, authorityDirectory),
    ]);
    const recognized = new Set([...bundles, ...receipts]);
    const unknownEvidence = allEvidenceJson.filter((entry) => !recognized.has(entry));
    if (unknownEvidence.length > 0) {
      operationError("EVIDENCE_LAYOUT_UNKNOWN", "evidence JSON must be a bundle or authority receipt", {
        paths: unknownEvidence,
        errors: unknownEvidence.map((entry) => ({
          code: "EVIDENCE_LAYOUT_UNKNOWN",
          message: "unknown evidence artifact layout",
          path: entry,
        })),
      });
    }
    for (const relativePath of bundles) {
      await assertProjectSchema(
        ctx.projectRoot,
        "evidence-bundle",
        "evidence bundle",
        await readProjectJson(ctx.projectRoot, relativePath),
      );
      checked.evidence += 1;
    }
    for (const relativePath of receipts) {
      await assertProjectSchema(
        ctx.projectRoot,
        "authority-receipt",
        "authority receipt",
        await readProjectJson(ctx.projectRoot, relativePath),
      );
      checked.authorityReceipts += 1;
    }
    const contextDirectory = normalizeRepoPath(path.posix.join(ctx.config.paths.generated, "contexts"));
    for (const relativePath of await listJsonArtifacts(ctx.projectRoot, contextDirectory)) {
      await assertProjectSchema(
        ctx.projectRoot,
        "context-manifest",
        "context manifest",
        await readProjectJson(ctx.projectRoot, relativePath),
      );
      checked.contexts += 1;
    }
    return {
      status: "pass",
      target: ctx.projectRoot,
      checked,
      specificationDigest: specification.specIndex.spec.digest,
      warnings: ctx.warnings,
      errors: [],
    };
  });
}

export function compileSpecCommand({ project, output = null, dryRun = false }) {
  return guardedOperation(async () => compileSpecification(await loadHealthyProject(project), { output, dryRun }));
}

export function compileTaskCommand({ project, input, output = null, dryRun = false }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const request = assertObjectKeys(await readRequest(ctx, input), [
      "taskId",
      "goal",
      "baseRevision",
      "stageId",
      "taskKind",
      "changedPaths",
      "directRequirementIds",
      "evidenceTargetDecisionIds",
      "requiredEvidenceLevel",
      "requestedTier",
      "routingCapability",
      "risk",
      "constraints",
      "declaredCapabilities",
      "reviewLenses",
      "contextHints",
    ], [
      "taskId",
      "goal",
      "baseRevision",
      "stageId",
      "taskKind",
      "changedPaths",
      "directRequirementIds",
    ]);
    const resolvedBase = await resolveBaseRevision(ctx.projectRoot, request.baseRevision);
    if (!resolvedBase.ok) operationError("TASK_BASE_REVISION_INVALID", "task baseRevision must resolve to a full commit", { errors: resolvedBase.errors });
    const active = await loadActiveControl(ctx.projectRoot, {
      baseRevision: resolvedBase.revision,
      taskKind: request.taskKind,
      scope: { allowedPaths: request.taskKind === "evidence_collection" ? [] : request.changedPaths },
    });
    const specification = await compileSpecification(ctx, {
      baseRevision: resolvedBase.revision,
      activeControl: active,
      dryRun,
    });
    if (specification.status !== "pass") return specification;
    const compilation = compileTask({
      ...request,
      baseRevision: resolvedBase.revision,
      specIndex: specification.specIndex,
      specIndexDigest: specification.specIndexDigest,
      baseline: active.baseline,
      instructionBinding: active.instructionBinding,
      impactMap: active.impactMap,
      decisionRegister: active.decisionRegister,
      verifierRegistry: active.verifierRegistry,
      projectConfig: active.config,
      frameworkLock: active.frameworkLock,
    });
    await assertRevisionSchema(
      ctx.projectRoot,
      resolvedBase.revision,
      "task-packet",
      "compiled task packet",
      compilation.taskPacket,
    );
    const outputPath = output
      ? ensureWithinDirectory(output, active.config.paths.tasks, "task output")
      : normalizeRepoPath(path.posix.join(active.config.paths.tasks, `${compilation.taskPacket.taskId}.json`));
    const artifact = await writeJsonArtifact({
      projectRoot: ctx.projectRoot,
      relativePath: outputPath,
      allowedDirectory: active.config.paths.tasks,
      value: compilation.taskPacket,
      dryRun,
    });
    return {
      status: compilation.status === "ready" ? "pass" : "blocked",
      code: compilation.status === "ready" ? undefined : "TASK_DECISIONS_BLOCKED",
      target: ctx.projectRoot,
      outputPath,
      artifact,
      specIndexOutputPath: specification.outputPath,
      specIndexArtifact: specification.artifact,
      compilationStatus: compilation.status,
      taskDigest: digestJson(compilation.taskPacket),
      blockingDecisionIds: compilation.blockingDecisionIds,
      taskPacket: compilation.taskPacket,
      impact: compilation.impact,
      warnings: ctx.warnings,
      errors: [],
    };
  });
}

export function validateTaskCommand({ project, task }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const loaded = await loadTask(ctx, task);
    const errors = await taskSemanticErrors(ctx, loaded.value);
    return {
      status: errors.length === 0 ? "pass" : "blocked",
      code: errors.length === 0 ? undefined : "TASK_NOT_READY",
      target: ctx.projectRoot,
      taskPath: loaded.path,
      taskId: loaded.value.taskId,
      errors,
      warnings: ctx.warnings,
    };
  });
}

export function buildContextCommand({ project, input, output = null, dryRun = false }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const request = assertObjectKeys(await readRequest(ctx, input), [
      "task",
      "manifestId",
      "subjectRevision",
      "createdAt",
      "contracts",
      "exclusions",
    ], ["task", "subjectRevision", "createdAt"]);
    const [{ value: taskPacket }, { value: specIndex }, decision, impactMap] = await Promise.all([
      loadTask(ctx, request.task),
      readSpecIndex(ctx),
      readDecisionRegister(ctx),
      readImpactMap(ctx),
    ]);
    const assetPolicy = buildAssetPolicy({ config: ctx.config, baseline: ctx.baseline, impactMap });
    const contracts = [];
    for (const entry of request.contracts ?? []) {
      assertObjectKeys(entry, [
        "path",
        "requirementIds",
        "acceptanceIds",
        "alwaysInclude",
        "reason",
        "required",
      ], ["path"]);
      const contractPath = validateRelativePath(entry.path);
      const sensitiveReference = classifyAssetPath(contractPath, assetPolicy).assetClass === "sensitive";
      contracts.push({
        ...entry,
        path: contractPath,
        digest: sensitiveReference
          ? digestJson({ kind: "sensitive_reference", path: contractPath })
          : sha256(await readProjectBytes(ctx.projectRoot, contractPath)),
        ...(sensitiveReference ? { sensitiveReference: true } : {}),
      });
    }
    const contextManifest = buildContextManifest({
      manifestId: request.manifestId,
      taskPacket,
      specIndex,
      subjectRevision: request.subjectRevision,
      subjectContentDigest: (await computeSubjectContentSnapshot(
        ctx.projectRoot,
        taskPacket.baseRevision,
        { excludedPrefixes: frameworkProcessArtifactPrefixes(ctx.config) },
      )).subjectContentDigest,
      createdAt: request.createdAt,
      decisionSource: {
        path: decision.path,
        digest: digestJson(decision.value),
      },
      contracts,
      exclusions: request.exclusions ?? [],
    });
    await assertProjectSchema(ctx.projectRoot, "context-manifest", "context manifest", contextManifest);
    const outputPath = output
      ? ensureWithinDirectory(output, ctx.config.paths.generated, "context output")
      : defaultContextPath(ctx.config, taskPacket.taskId, contextManifest.manifestDigest);
    const artifact = await writeJsonArtifact({
      projectRoot: ctx.projectRoot,
      relativePath: outputPath,
      allowedDirectory: ctx.config.paths.generated,
      value: contextManifest,
      dryRun,
    });
    return {
      status: "pass",
      target: ctx.projectRoot,
      outputPath,
      artifact,
      contextManifest,
      warnings: ctx.warnings,
      errors: [],
    };
  });
}

export function renderContextCommand({ project, task, context, audience, output = null, dryRun = false }) {
  return guardedOperation(async () => {
    const ctx = await loadHealthyProject(project);
    const [{ value: taskPacket }, { value: contextManifest }] = await Promise.all([
      loadTask(ctx, task),
      loadContext(ctx, context),
    ]);
    const brief = renderContextBrief({ taskPacket, contextManifest, audience });
    const outputPath = output
      ? ensureWithinDirectory(output, ctx.config.paths.generated, "context brief output")
      : normalizeRepoPath(path.posix.join(
        ctx.config.paths.generated,
        "briefs",
        `${taskPacket.taskId}-${audience}-${brief.briefDigest.slice("sha256:".length)}.md`,
      ));
    const artifact = await writeTextArtifact({
      projectRoot: ctx.projectRoot,
      relativePath: outputPath,
      allowedDirectory: ctx.config.paths.generated,
      content: brief.content,
      dryRun,
    });
    return { status: "pass", target: ctx.projectRoot, outputPath, artifact, ...brief, warnings: ctx.warnings, errors: [] };
  });
}
