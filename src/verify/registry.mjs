import path from "node:path";

import { validateSchema } from "../core/schema-validator.mjs";
import { projectSchemaPaths } from "../cli/constants.mjs";
import { readJson } from "../cli/io.mjs";
import { normalizeRepoPath, resolveWithin, validateRelativePath } from "../cli/path-safety.mjs";
import {
  requiredAuthorityKindsForEvidenceLevel,
  requiredMachineEvidenceLevelsForEvidenceLevel,
  validateTaskAuthorizationSnapshot,
} from "../task/index.mjs";
import { resolveSafeFile } from "./safe-path.mjs";
import {
  inspectGitRepository,
  readProjectSchemaAtRevision,
  readTextAtRevision,
  resolveBaseRevision,
} from "./git-scope.mjs";

export const VERIFIER_REGISTRY_PATH = "ai-dev/verifiers/registry.json";
export const IMPACT_MAP_PATH = "ai-dev/impact-map.json";

function schemaFindings(label, errors) {
  return errors.map((entry) => ({
    code: "SCHEMA_INVALID",
    message: `${label} does not satisfy its schema`,
    path: entry.path,
    keyword: entry.keyword,
    detail: entry.message,
  }));
}

async function loadAndValidate(projectRoot, relativePath, schemaName, label) {
  const valuePath = await resolveSafeFile(projectRoot, relativePath);
  let schemaPath;
  let missingError = null;
  for (const candidate of projectSchemaPaths(schemaName)) {
    try {
      schemaPath = await resolveSafeFile(projectRoot, candidate);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missingError = error;
    }
  }
  if (!schemaPath) throw missingError ?? new Error(`schema is unavailable: ${schemaName}`);
  const [value, schema] = await Promise.all([readJson(valuePath), readJson(schemaPath)]);
  const errors = validateSchema(value, schema);
  return { value, errors: schemaFindings(label, errors) };
}

async function loadAndValidateAtRevision(projectRoot, revision, relativePath, schemaName, label) {
  const [valueText, schemaLoad] = await Promise.all([
    readTextAtRevision(projectRoot, revision, relativePath),
    readProjectSchemaAtRevision(projectRoot, revision, schemaName),
  ]);
  const value = JSON.parse(valueText);
  const schema = schemaLoad.value;
  return { value, errors: schemaFindings(label, validateSchema(value, schema)) };
}

export function resolveTaskPath(config, taskArgument) {
  if (!taskArgument) return null;
  const taskRoot = validateRelativePath(config.paths.tasks);
  const candidate = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(taskArgument)
    ? validateRelativePath(path.posix.join(taskRoot, `${taskArgument}.json`))
    : validateRelativePath(taskArgument);
  const comparableRoot = process.platform === "win32" ? taskRoot.toLowerCase() : taskRoot;
  const comparableCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  if (!comparableCandidate.startsWith(`${comparableRoot}/`) || !comparableCandidate.endsWith(".json")) {
    const error = new Error("task must be a JSON file under the configured task directory");
    error.code = "TASK_PATH_INVALID";
    throw error;
  }
  return normalizeRepoPath(candidate);
}

function canonicalSpecDigest(baseline) {
  return baseline.truthSources.find((entry) => entry.sourceId === baseline.canonicalSpecSourceId)?.digest ?? null;
}

function validateRegistrySemantics(registry) {
  const errors = [];
  const byId = new Map();
  for (const verifier of registry.verifiers ?? []) {
    if (byId.has(verifier.verifierId)) {
      errors.push({
        code: "VERIFIER_ID_DUPLICATE",
        message: "verifier ids must be unique",
        verifierId: verifier.verifierId,
      });
    } else {
      byId.set(verifier.verifierId, verifier);
    }
    if (["owner", "production"].includes(verifier.evidenceLevel)) {
      errors.push({
        code: "VERIFIER_EVIDENCE_LEVEL_UNSUPPORTED",
        message: "registered deterministic verifiers cannot claim owner or production evidence",
        verifierId: verifier.verifierId,
      });
    }
  }
  for (const verifierId of registry.globalInvariantVerifierIds ?? []) {
    if (!byId.has(verifierId)) {
      errors.push({
        code: "GLOBAL_VERIFIER_UNKNOWN",
        message: "global invariant references an unknown verifier",
        verifierId,
      });
    }
  }
  return { errors, byId };
}

export async function loadVerificationPlan({
  projectRoot,
  taskArgument,
  taskPacket = null,
  tier,
}) {
  const errors = [];
  let provisionalConfig;
  let taskPath = null;
  let task = taskPacket;
  try {
    provisionalConfig = (await loadAndValidate(projectRoot, "ai-flow.config.json", "project-config", "project config")).value;
    if (taskArgument && taskPacket) {
      throw Object.assign(new Error("taskArgument and taskPacket are mutually exclusive"), {
        code: "TASK_SOURCE_AMBIGUOUS",
      });
    }
    if (!taskPacket) {
      taskPath = resolveTaskPath(provisionalConfig, taskArgument);
      if (taskPath) task = await readJson(await resolveSafeFile(projectRoot, taskPath));
    }
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: error.code ?? "CONTROL_PLANE_DISCOVERY_FAILED", message: error.message }],
    };
  }
  const repository = await inspectGitRepository(projectRoot);
  if (!repository.ok) return { ok: false, errors: repository.errors };
  const activeRevision = task
    ? (await resolveBaseRevision(projectRoot, task.baseRevision)).revision
    : repository.headRevision;
  if (!activeRevision) return { ok: false, errors: [{ code: "BASE_REVISION_INVALID", message: "TaskPacket base revision is invalid" }] };

  let configLoad;
  let baselineLoad;
  let registryLoad;
  let decisionLoad;
  let impactLoad;
  try {
    configLoad = await loadAndValidateAtRevision(projectRoot, activeRevision, "ai-flow.config.json", "project-config", "project config");
    errors.push(...configLoad.errors);
    const baselinePath = configLoad.value?.baselinePath ?? "ai-dev/baseline.json";
    baselineLoad = await loadAndValidateAtRevision(projectRoot, activeRevision, baselinePath, "baseline", "baseline");
    errors.push(...baselineLoad.errors);
    const decisionPath = baselineLoad.value?.decisionRegister ?? "ai-dev/decisions/register.json";
    decisionLoad = await loadAndValidateAtRevision(projectRoot, activeRevision, decisionPath, "decision-register", "decision register");
    errors.push(...decisionLoad.errors);
    impactLoad = await loadAndValidateAtRevision(projectRoot, activeRevision, IMPACT_MAP_PATH, "impact-map", "impact map");
    errors.push(...impactLoad.errors);
    registryLoad = await loadAndValidateAtRevision(projectRoot, activeRevision, VERIFIER_REGISTRY_PATH, "verifier-registry", "verifier registry");
    errors.push(...registryLoad.errors);
    if (task) {
      const taskSchema = (await readProjectSchemaAtRevision(projectRoot, activeRevision, "task-packet")).value;
      errors.push(...schemaFindings("task packet", validateSchema(task, taskSchema)));
      if (!taskPacket) {
        const activeTaskPath = resolveTaskPath(configLoad.value, taskArgument);
        if (activeTaskPath !== taskPath) errors.push({ code: "TASK_PATH_CONTROL_STALE", message: "candidate config resolves the task differently from base Active Control" });
      }
    }
  } catch (error) {
    return { ok: false, errors: [{ code: "BASE_CONTROL_PLANE_LOAD_FAILED", message: error.message }] };
  }
  const config = configLoad.value;
  const baseline = baselineLoad.value;
  const decisionRegister = decisionLoad.value;
  const impactMap = impactLoad.value;
  const registry = registryLoad.value;
  if (impactMap.baselineId !== baseline.baselineId) {
    errors.push({ code: "IMPACT_BASELINE_MISMATCH", message: "impact map belongs to a different baseline" });
  }
  const semantic = validateRegistrySemantics(registry);
  errors.push(...semantic.errors);

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      config,
      baseline,
      impactMap,
      registry,
      decisionRegister,
      task: null,
      taskPath: null,
      specDigest: null,
      selected: [],
      deferredVerifierIds: [],
    };
  }

  const specDigest = canonicalSpecDigest(baseline);
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      config,
      baseline,
      impactMap,
      registry,
      task,
      taskPath,
      specDigest,
      selected: [],
      deferredVerifierIds: [],
    };
  }
  if (task) {
    if (baseline.status !== "active") {
      errors.push({ code: "BASELINE_NOT_ACTIVE", message: "product task verification requires an active baseline" });
    }
    if (task.baselineId !== baseline.baselineId) {
      errors.push({ code: "TASK_BASELINE_MISMATCH", message: "task baselineId differs from the active baseline" });
    }
    if (task.specDigest !== specDigest) {
      errors.push({ code: "TASK_SPEC_MISMATCH", message: "task specDigest differs from the canonical source" });
    }
    errors.push(...validateTaskAuthorizationSnapshot(task, decisionRegister));
    const currentStage = (decisionRegister.stageGates ?? []).find(
      (entry) => entry.stageId === task.stageId,
    );
    if (currentStage) {
      if (
        task.taskKind !== "evidence_collection"
        && currentStage.status !== "authorized"
      ) {
        errors.push({
          code: "TASK_STAGE_NOT_AUTHORIZED",
          message: "implementation and control-plane tasks require a currently authorized stage gate",
          stageId: task.stageId,
          status: currentStage.status,
        });
      }
      if (
        task.taskKind === "evidence_collection"
        && !["pending", "blocked", "ready"].includes(currentStage.status)
      ) {
        errors.push({
          code: "TASK_EVIDENCE_STAGE_INVALID",
          message: "evidence collection is only allowed for pending, blocked, or ready stage gates",
          stageId: task.stageId,
          status: currentStage.status,
        });
      }
    }
    for (const dependency of task.decisionDependencies ?? []) {
      const unresolvedAllowed = task.taskKind === "evidence_collection"
        && dependency.status === "unresolved";
      if (!unresolvedAllowed && (dependency.status !== "resolved" || (dependency.evidenceRefs ?? []).length === 0)) {
        errors.push({
          code: "TASK_DECISION_UNRESOLVED",
          message: "task has an unresolved decision dependency",
          decisionId: dependency.decisionId,
        });
      }
    }
  }

  const executedTier = tier ?? task?.verification?.tier ?? null;
  if (!new Set(["quick", "deep"]).has(executedTier)) {
    errors.push({
      code: "VERIFICATION_TIER_REQUIRED",
      message: "verification tier must be quick or deep; task-bound verification may derive it from the TaskPacket",
    });
  }

  const requestedIds = new Set(
    task ? task.verification?.verifierIds ?? [] : (registry.verifiers ?? []).map((entry) => entry.verifierId),
  );
  for (const verifierId of registry.globalInvariantVerifierIds ?? []) requestedIds.add(verifierId);
  for (const verifier of registry.verifiers ?? []) {
    if (verifier.triggers?.alwaysRun) requestedIds.add(verifier.verifierId);
  }
  for (const verifierId of requestedIds) {
    if (!semantic.byId.has(verifierId)) {
      errors.push({
        code: "VERIFIER_UNKNOWN",
        message: "verification requested an unknown registered verifier",
        verifierId,
      });
    }
  }
  if (task) {
    const definitions = [...requestedIds].map((id) => semantic.byId.get(id)).filter(Boolean);
    const requiredLevels = requiredMachineEvidenceLevelsForEvidenceLevel(
      task.verification?.requiredEvidenceLevel,
    );
    const missingLevels = requiredLevels.filter(
      (level) => !definitions.some((entry) => entry.evidenceLevel === level),
    );
    if (missingLevels.length > 0) {
      errors.push({
        code: "EVIDENCE_CHAIN_UNREACHABLE",
        message: "current verifier registry cannot produce the task's continuous machine evidence chain",
        missingEvidenceLevels: missingLevels,
      });
    }
    const expectedAuthorityKinds = requiredAuthorityKindsForEvidenceLevel(
      task.verification?.requiredEvidenceLevel,
    );
    const actualAuthorityKinds = [...(task.verification?.requiredAuthorityKinds ?? [])].sort();
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
  }

  const selected = [];
  const deferredVerifierIds = [];
  const requiredTier = task?.verification?.tier ?? executedTier;
  for (const verifierId of requestedIds) {
    const verifier = semantic.byId.get(verifierId);
    if (!verifier) continue;
    if (executedTier === "quick" && verifier.tier === "deep") {
      deferredVerifierIds.push(verifierId);
      continue;
    }
    if (verifier.deterministic !== true) {
      errors.push({
        code: "VERIFIER_NOT_DETERMINISTIC",
        message: "the deterministic runner refuses a non-deterministic verifier",
        verifierId,
      });
      continue;
    }
    if (verifier.sideEffect.kind !== "none") {
      errors.push({
        code: "HUMAN_GATE_REQUIRED",
        message: "the built-in deterministic runner never executes verifiers with side effects",
        verifierId,
        sideEffect: verifier.sideEffect.kind,
      });
      continue;
    }
    selected.push({
      ...verifier,
      authorization: { authorized: false, authorizationRef: null },
    });
  }
  selected.sort((left, right) => left.verifierId.localeCompare(right.verifierId, "en"));
  deferredVerifierIds.sort((left, right) => left.localeCompare(right, "en"));
  if (selected.length === 0 && !(executedTier === "quick" && requiredTier === "deep" && deferredVerifierIds.length > 0)) {
    errors.push({ code: "NO_VERIFIERS_SELECTED", message: "no registered verifier is eligible for the selected tier" });
  }

  return {
    ok: errors.length === 0,
    errors,
    config,
    baseline,
    impactMap,
    registry,
    decisionRegister,
    task,
    taskPath,
    specDigest,
    requiredTier,
    executedTier,
    selected,
    deferredVerifierIds,
    activeControlRevision: activeRevision,
  };
}
