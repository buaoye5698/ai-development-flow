import { normalizeRepoPath, sha256, stableStringify } from "../core/index.mjs";
import { taskError } from "./errors.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UTC_DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const TASK_KINDS = new Set(["implementation", "truth_proposal", "evidence_collection", "control_plane"]);
const STAGE_GATE_STATUSES = new Set(["pending", "blocked", "ready", "authorized", "not_authorized"]);

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) taskError("context_input_invalid", `${name} must be a non-empty string`);
  return value.trim();
}

function repoPath(value, name) {
  const normalized = normalizeRepoPath(requiredString(value, name));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    taskError("context_path_unsafe", `${name} must be a repository-relative path`, { path: value });
  }
  return normalized;
}

function digest(value, name) {
  const normalized = requiredString(value, name);
  if (!DIGEST.test(normalized)) taskError("context_digest_invalid", `${name} must be a SHA-256 digest`);
  return normalized;
}

function normalizeTaskStage(taskPacket) {
  const stageId = requiredString(taskPacket.stageId, "taskPacket.stageId");
  const taskKind = requiredString(taskPacket.taskKind, "taskPacket.taskKind");
  if (!TASK_KINDS.has(taskKind)) taskError("context_task_kind_invalid", `unsupported task kind: ${taskKind}`);
  const source = taskPacket.derivation?.stageGate;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    taskError("context_stage_gate_missing", "taskPacket.derivation.stageGate is required");
  }
  const status = requiredString(source.status, "taskPacket.derivation.stageGate.status");
  if (!STAGE_GATE_STATUSES.has(status)) {
    taskError("context_stage_gate_invalid", `unsupported stage gate status: ${status}`);
  }
  const authorizationBoundary = requiredString(
    source.authorizationBoundary,
    "taskPacket.derivation.stageGate.authorizationBoundary",
  );
  if (!Array.isArray(source.evidenceRequired)
    || source.evidenceRequired.some((entry) => typeof entry !== "string" || !entry.trim())) {
    taskError("context_stage_gate_invalid", "stage gate evidenceRequired must contain non-empty strings");
  }
  return {
    stageId,
    taskKind,
    stageGate: {
      status,
      authorizationBoundary,
      evidenceRequired: [...new Set(source.evidenceRequired.map((entry) => entry.trim()))].sort(),
    },
  };
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((entry) => rightSet.has(entry));
}

function uniqueItems(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const key = [
      item.kind,
      item.path,
      item.digest,
      item.startLine ?? "",
      item.endLine ?? "",
      item.reason,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((left, right) =>
    `${left.path}:${left.startLine ?? 0}:${left.kind}`.localeCompare(`${right.path}:${right.startLine ?? 0}:${right.kind}`),
  );
}

export function buildContextManifest({
  manifestId,
  taskPacket,
  specIndex,
  subjectRevision,
  subjectContentDigest,
  createdAt,
  decisionSource,
  contracts = [],
  exclusions = [],
}) {
  if (!taskPacket || !specIndex) taskError("context_input_invalid", "taskPacket and specIndex are required");
  if (taskPacket.baselineId !== specIndex.baselineId || taskPacket.specDigest !== specIndex.spec?.digest) {
    taskError("context_baseline_mismatch", "task packet and SpecIndex must describe the same baseline and digest");
  }
  const expectedSpecIndexDigest = digest(taskPacket.specIndexDigest, "taskPacket.specIndexDigest");
  const actualSpecIndexDigest = sha256(stableStringify(specIndex));
  if (expectedSpecIndexDigest !== actualSpecIndexDigest) {
    taskError("context_spec_index_mismatch", "SpecIndex content does not match the TaskPacket binding", {
      expected: expectedSpecIndexDigest,
      actual: actualSpecIndexDigest,
    });
  }
  const revision = requiredString(subjectRevision, "subjectRevision");
  const contentDigest = digest(subjectContentDigest, "subjectContentDigest");
  const taskStage = normalizeTaskStage(taskPacket);
  if (typeof createdAt !== "string" || !UTC_DATE_TIME.test(createdAt)) {
    taskError("context_created_at_invalid", "createdAt must be an explicit UTC ISO-8601 timestamp");
  }

  const requirementIds = taskPacket.requirementIds ?? [];
  const acceptanceIds = taskPacket.acceptanceIds ?? [];
  const requirementById = new Map((specIndex.requirements ?? []).map((entry) => [entry.id, entry]));
  const acceptanceById = new Map((specIndex.acceptanceCases ?? []).map((entry) => [entry.id, entry]));
  const specPath = repoPath(specIndex.spec.path, "specIndex.spec.path");
  const specDigest = digest(specIndex.spec.digest, "specIndex.spec.digest");
  const items = [];

  for (const id of requirementIds) {
    const requirement = requirementById.get(id);
    if (!requirement) taskError("context_requirement_unknown", `task references unknown requirement ${id}`, { id });
    items.push({
      kind: "spec_excerpt",
      path: specPath,
      digest: specDigest,
      ...(Number.isInteger(requirement.line) ? { startLine: requirement.line, endLine: requirement.line } : {}),
      reason: [
        `selected requirement ${id}: ${requiredString(requirement.statement, `requirement ${id} statement`)}`,
        ...(typeof requirement.acceptance === "string" && requirement.acceptance.trim()
          ? [`inline acceptance: ${requirement.acceptance.trim()}`]
          : []),
      ].join(" — "),
      required: true,
    });
  }
  for (const id of acceptanceIds) {
    const acceptance = acceptanceById.get(id);
    if (!acceptance) taskError("context_acceptance_unknown", `task references unknown acceptance ${id}`, { id });
    items.push({
      kind: "spec_excerpt",
      path: specPath,
      digest: specDigest,
      ...(Number.isInteger(acceptance.line) ? { startLine: acceptance.line, endLine: acceptance.line } : {}),
      reason: `selected acceptance ${id}: ${requiredString(acceptance.title, `acceptance ${id} title`)} — ${(acceptance.criteria ?? [])
        .map((criterion, index) => requiredString(criterion, `acceptance ${id} criteria[${index}]`))
        .join("; ")}`,
      required: true,
    });
  }

  const relatedDecisionIds = [
    ...(taskPacket.decisionDependencies ?? []).map((entry) => entry.decisionId),
    ...(taskPacket.derivation?.evidenceTargetDecisionIds ?? []),
  ];
  if (relatedDecisionIds.length > 0) {
    if (!decisionSource) taskError("context_decision_source_missing", "related decisions require a path and digest");
    items.push({
      kind: "decision",
      path: repoPath(decisionSource.path, "decisionSource.path"),
      digest: digest(decisionSource.digest, "decisionSource.digest"),
      reason: `related decisions: ${[...new Set(relatedDecisionIds)].sort().join(", ")}`,
      required: true,
    });
  }

  for (const [index, contract] of contracts.entries()) {
    const contractRequirements = contract.requirementIds ?? [];
    const contractAcceptances = contract.acceptanceIds ?? [];
    const relevant = contract.alwaysInclude === true
      || intersects(contractRequirements, requirementIds)
      || intersects(contractAcceptances, acceptanceIds);
    if (!relevant) continue;
    const sensitiveReference = contract.sensitiveReference === true;
    items.push({
      kind: sensitiveReference ? "sensitive_reference" : "contract",
      path: repoPath(contract.path, `contracts[${index}].path`),
      digest: digest(contract.digest, `contracts[${index}].digest`),
      reason: sensitiveReference
        ? "sensitive path reference; content must not be loaded"
        : contract.reason || "contract selected by task requirements",
      required: contract.required !== false,
    });
  }

  const exclusionEntries = [
    ...exclusions.map((entry, index) => ({
      path: repoPath(entry.path, `exclusions[${index}].path`),
      reason: requiredString(entry.reason, `exclusions[${index}].reason`),
    })),
    ...(taskPacket.contextHints?.excludedPaths ?? []).map((path) => ({
      path: repoPath(path, "taskPacket.contextHints.excludedPaths"),
      reason: "excluded by task context hint",
    })),
  ];
  const uniqueExclusions = [];
  const excludedPaths = new Set();
  for (const entry of exclusionEntries.sort((left, right) => left.path.localeCompare(right.path))) {
    if (excludedPaths.has(entry.path)) continue;
    excludedPaths.add(entry.path);
    uniqueExclusions.push(entry);
  }
  const selectedItems = uniqueItems(items);
  const conflict = selectedItems.find((item) => excludedPaths.has(item.path));
  if (conflict) taskError("context_selection_conflict", `required context path is also excluded: ${conflict.path}`, { path: conflict.path });
  if (selectedItems.length === 0) taskError("context_selection_empty", "context manifest must contain at least one relevant item");

  const manifest = {
    schemaVersion: 2,
    manifestId: manifestId ?? `${taskPacket.taskId}:context`,
    taskId: taskPacket.taskId,
    baselineId: taskPacket.baselineId,
    specDigest: taskPacket.specDigest,
    specIndexDigest: taskPacket.specIndexDigest,
    taskPacketDigest: sha256(stableStringify(taskPacket)),
    controlDigest: taskPacket.controlDigest,
    subjectContentDigest: contentDigest,
    subjectRevision: revision,
    stageId: taskStage.stageId,
    taskKind: taskStage.taskKind,
    stageGate: taskStage.stageGate,
    createdAt,
    items: selectedItems,
    exclusions: uniqueExclusions,
  };
  return { ...manifest, manifestDigest: sha256(stableStringify(manifest)) };
}
