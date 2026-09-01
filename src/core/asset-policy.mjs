import {
  normalizeRepoPath,
  normalizeScopePattern,
  pathMatchesPattern,
  patternsOverlap,
} from "./path-policy.mjs";
import { digestJson } from "./canonical.mjs";

export const ASSET_CLASSES = Object.freeze([
  "sensitive",
  "process",
  "active_control",
  "active_truth",
  "managed_implementation",
  "unmanaged",
]);

export const TASK_KIND_WRITE_CLASSES = Object.freeze({
  implementation: Object.freeze(["managed_implementation"]),
  truth_proposal: Object.freeze(["active_truth"]),
  control_plane: Object.freeze(["active_control"]),
  evidence_collection: Object.freeze([]),
});

function uniquePatterns(values = []) {
  return [...new Set(values.map(normalizeScopePattern))].sort((left, right) => left.localeCompare(right, "en"));
}

function recursivePath(value) {
  return `${normalizeRepoPath(value)}/**`;
}

export function deriveProcessPatterns(config) {
  const paths = config?.paths ?? {};
  return uniquePatterns([
    paths.tasks,
    paths.reviews,
    paths.runs,
    paths.evidence,
    paths.authorizations,
    paths.generated,
    paths.cache,
    paths.controller,
  ].filter(Boolean).map(recursivePath));
}

export function deriveTruthPatterns(config, baseline) {
  return uniquePatterns([
    config?.baselinePath,
    baseline?.decisionRegister,
    ...(baseline?.truthSources ?? []).map((entry) => entry?.path),
  ].filter(Boolean));
}

export function deriveManagedPatterns(impactMap) {
  return uniquePatterns((impactMap?.rules ?? []).flatMap((rule) => rule?.pathPatterns ?? []));
}

export function buildAssetPolicy({ config, baseline, impactMap }) {
  const patterns = {
    sensitive: uniquePatterns(config?.automationPolicy?.sensitivePaths ?? []),
    process: deriveProcessPatterns(config),
    active_control: uniquePatterns([
      ...(config?.automationPolicy?.controlPaths ?? []),
      config?.specAdapter?.module,
    ].filter(Boolean)),
    active_truth: deriveTruthPatterns(config, baseline),
    managed_implementation: deriveManagedPatterns(impactMap),
  };
  const policy = { schemaVersion: 1, patterns };
  return { ...policy, assetPolicyDigest: digestJson(policy) };
}

export function classifyAssetPath(filePath, policy) {
  const normalized = normalizeRepoPath(filePath);
  for (const assetClass of ASSET_CLASSES.filter((entry) => entry !== "unmanaged")) {
    if ((policy?.patterns?.[assetClass] ?? []).some((pattern) => pathMatchesPattern(normalized, pattern))) {
      return { path: normalized, assetClass };
    }
  }
  return { path: normalized, assetClass: "unmanaged" };
}

export function classifyAssetPatterns(scopePatterns, policy) {
  return [...new Set(scopePatterns ?? [])].sort().map((pattern) => {
    const normalized = normalizeScopePattern(pattern);
    const matches = ASSET_CLASSES.filter((assetClass) =>
      assetClass === "unmanaged"
        ? false
        : (policy?.patterns?.[assetClass] ?? []).some((candidate) => patternsOverlap(normalized, candidate)));
    return {
      pattern: normalized,
      assetClasses: matches.length > 0 ? matches : ["unmanaged"],
    };
  });
}

export function evaluateTaskAssetWrites({ taskKind, paths, policy }) {
  const allowed = new Set(TASK_KIND_WRITE_CLASSES[taskKind] ?? []);
  const classified = (paths ?? []).map((entry) => classifyAssetPath(entry, policy));
  const violations = classified
    .filter((entry) => !allowed.has(entry.assetClass))
    .map((entry) => ({
      code: entry.assetClass === "sensitive" ? "SENSITIVE_WRITE_FORBIDDEN" : "ASSET_WRITE_FORBIDDEN",
      message: `${taskKind} cannot write ${entry.assetClass} assets`,
      path: entry.path,
      assetClass: entry.assetClass,
      taskKind,
    }));
  return { ok: violations.length === 0, classified, violations };
}
