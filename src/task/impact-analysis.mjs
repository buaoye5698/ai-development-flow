import {
  normalizeRepoPath,
  normalizeScopePattern as normalizeCoreScopePattern,
  pathMatchesPattern as corePathMatchesPattern,
  patternsOverlap,
  portablePathKey
} from "../core/index.mjs";
import { taskError } from "./errors.mjs";

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function uniquePortablePaths(values) {
  const byKey = new Map();
  for (const value of values) {
    const normalized = normalizeChangedPath(value);
    const key = portablePathKey(normalized);
    const existing = byKey.get(key);
    if (existing === undefined || normalized < existing) byKey.set(key, normalized);
  }
  return [...byKey.entries()]
    .sort(([leftKey, leftPath], [rightKey, rightPath]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0)
    .map(([, path]) => path);
}

export function normalizeChangedPath(value) {
  try {
    return normalizeRepoPath(value);
  } catch (error) {
    taskError("unsafe_changed_path", error.message, { path: value });
  }
}

export function normalizeScopePattern(value) {
  try {
    return normalizeCoreScopePattern(value);
  } catch (error) {
    taskError("unsafe_scope_pattern", error.message, { pattern: value });
  }
}

export function pathMatchesPattern(pathValue, patternValue) {
  const path = normalizeChangedPath(pathValue);
  const pattern = normalizeScopePattern(patternValue);
  return corePathMatchesPattern(path, pattern);
}

export function scopePatternsOverlap(leftValue, rightValue) {
  try {
    return patternsOverlap(leftValue, rightValue);
  } catch (error) {
    taskError("unsafe_scope_pattern", error.message, { left: leftValue, right: rightValue });
  }
}

export function analyzeImpact({ changedPaths, impactMap, baselineId, requireAllPathsMapped = true }) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    taskError("changed_paths_missing", "at least one planned changed path is required");
  }
  if (!impactMap || typeof impactMap !== "object" || Array.isArray(impactMap)) {
    taskError("impact_map_invalid", "impactMap must be an object");
  }
  if (baselineId && impactMap.baselineId !== baselineId) {
    taskError("impact_baseline_mismatch", "impactMap.baselineId must match the specification baseline", {
      expected: baselineId,
      actual: impactMap.baselineId,
    });
  }

  const normalizedPaths = uniquePortablePaths(changedPaths);
  const matchedRuleIds = [];
  const mappedPathKeys = new Set();
  const requirementIds = [];
  const acceptanceIds = [];
  const verifierIds = [];

  for (const rule of impactMap.rules ?? []) {
    const matchingPaths = normalizedPaths.filter((path) =>
      (rule.pathPatterns ?? []).some((pattern) => pathMatchesPattern(path, pattern)),
    );
    if (matchingPaths.length === 0) continue;
    matchedRuleIds.push(rule.ruleId);
    matchingPaths.forEach((path) => mappedPathKeys.add(portablePathKey(path)));
    requirementIds.push(...(rule.requirementIds ?? []));
    acceptanceIds.push(...(rule.acceptanceIds ?? []));
    verifierIds.push(...(rule.verifierIds ?? []));
  }

  const unmatchedPaths = normalizedPaths.filter((path) => !mappedPathKeys.has(portablePathKey(path)));
  if (requireAllPathsMapped && unmatchedPaths.length > 0) {
    taskError("unmapped_changed_path", "every planned changed path must map to at least one impact rule", {
      paths: unmatchedPaths,
    });
  }

  return {
    schemaVersion: 1,
    mapId: impactMap.mapId,
    baselineId: impactMap.baselineId,
    changedPaths: normalizedPaths,
    matchedRuleIds: uniqueSorted(matchedRuleIds),
    unmatchedPaths,
    impactedRequirementIds: uniqueSorted(requirementIds),
    globalInvariantIds: uniqueSorted(impactMap.globalRequirementIds ?? []),
    acceptanceIds: uniqueSorted(acceptanceIds),
    verifierIds: uniqueSorted([...(impactMap.globalVerifierIds ?? []), ...verifierIds]),
  };
}
