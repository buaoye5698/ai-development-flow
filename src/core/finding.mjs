import { digestJson } from "./canonical.mjs";
import { normalizeRepoPath } from "./path-policy.mjs";

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizeIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)))].sort();
}

export function findingFingerprintPayload(finding) {
  let locationPath = "";
  try {
    locationPath = finding?.location?.path ? normalizeRepoPath(finding.location.path) : "";
  } catch {
    locationPath = normalizeText(finding?.location?.path);
  }
  return {
    category: normalizeText(finding?.category),
    summary: normalizeText(finding?.summary),
    expected: normalizeText(finding?.expected),
    observed: normalizeText(finding?.observed),
    requirementIds: normalizeIds(finding?.requirementIds),
    acceptanceIds: normalizeIds(finding?.acceptanceIds),
    locationPath
  };
}

export function computeFindingFingerprint(finding) {
  return digestJson(findingFingerprintPayload(finding));
}

export function validateFindingFingerprint(finding) {
  const expected = computeFindingFingerprint(finding);
  return {
    ok: finding?.fingerprint === expected,
    expected,
    actual: finding?.fingerprint ?? null
  };
}
