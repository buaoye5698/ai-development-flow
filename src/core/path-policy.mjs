const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const UNSUPPORTED_GLOB = /[?\[\]{}]/u;
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001f\u007f]/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

function pathError(message) {
  const error = new TypeError(message);
  error.code = "INVALID_REPO_PATH";
  return error;
}

export function normalizeRepoPath(value) {
  if (typeof value !== "string" || value.length === 0) throw pathError("Repository path must be a non-empty string");
  value = value.normalize("NFC");
  if (DRIVE_ABSOLUTE.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw pathError(`Repository path must be relative: ${value}`);
  }
  if (value.includes("*") || UNSUPPORTED_GLOB.test(value)) {
    throw pathError(`Repository file path cannot contain glob syntax: ${value}`);
  }

  const segments = value.replaceAll("\\", "/").split("/");
  const normalized = [];
  for (const segment of segments) {
    if (segment === "") throw pathError(`Repository path cannot contain empty segments: ${value}`);
    if (segment === ".") throw pathError(`Repository path cannot contain dot segments: ${value}`);
    if (segment === "..") throw pathError(`Repository path cannot escape the project root: ${value}`);
    if (WINDOWS_INVALID.test(segment)) throw pathError(`Repository path contains Windows-invalid characters: ${value}`);
    if (/[. ]$/u.test(segment)) throw pathError(`Repository path segments cannot end with a dot or space: ${value}`);
    const deviceBase = segment.split(".", 1)[0].replace(/[. ]+$/u, "");
    if (WINDOWS_RESERVED.test(deviceBase)) throw pathError(`Repository path contains a Windows-reserved name: ${value}`);
    normalized.push(segment);
  }
  if (normalized.length === 0) throw pathError("Repository path cannot resolve to the project root");
  return normalized.join("/");
}

function foldPortableCase(value) {
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

export function portablePathKey(value) {
  return foldPortableCase(normalizeRepoPath(value));
}

export function normalizeScopePattern(value) {
  if (typeof value !== "string") throw pathError("Scope pattern must be a string");
  const slashNormalized = value.replaceAll("\\", "/");
  if (UNSUPPORTED_GLOB.test(slashNormalized)) throw pathError(`Unsupported scope glob: ${value}`);
  const recursive = slashNormalized.endsWith("/**");
  const base = recursive ? slashNormalized.slice(0, -3) : slashNormalized;
  if (base.includes("*")) throw pathError(`Only a trailing /** scope glob is supported: ${value}`);
  const normalizedBase = normalizeRepoPath(base);
  return recursive ? `${normalizedBase}/**` : normalizedBase;
}

function patternParts(pattern) {
  const normalized = normalizeScopePattern(pattern);
  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  return { base, baseKey: portablePathKey(base), recursive, normalized };
}

export function pathMatchesPattern(filePath, pattern) {
  const candidate = portablePathKey(filePath);
  const parsed = patternParts(pattern);
  return parsed.recursive
    ? candidate === parsed.baseKey || candidate.startsWith(`${parsed.baseKey}/`)
    : candidate === parsed.baseKey;
}

export function patternCovers(cover, candidate) {
  const left = patternParts(cover);
  const right = patternParts(candidate);
  if (!left.recursive) return !right.recursive && left.baseKey === right.baseKey;
  return right.baseKey === left.baseKey || right.baseKey.startsWith(`${left.baseKey}/`);
}

export function patternsOverlap(leftValue, rightValue) {
  const left = patternParts(leftValue);
  const right = patternParts(rightValue);
  if (!left.recursive && !right.recursive) return left.baseKey === right.baseKey;
  if (left.recursive && right.recursive) {
    return left.baseKey === right.baseKey
      || left.baseKey.startsWith(`${right.baseKey}/`)
      || right.baseKey.startsWith(`${left.baseKey}/`);
  }
  const recursive = left.recursive ? left : right;
  const exact = left.recursive ? right : left;
  return exact.baseKey === recursive.baseKey || exact.baseKey.startsWith(`${recursive.baseKey}/`);
}

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizePatterns(values, label, errors) {
  const result = [];
  const keys = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const normalized = normalizeScopePattern(value);
      const key = normalized.endsWith("/**")
        ? `${portablePathKey(normalized.slice(0, -3))}/**`
        : portablePathKey(normalized);
      if (!keys.has(key)) {
        keys.add(key);
        result.push(normalized);
      }
    } catch (error) {
      errors.push(finding("SCOPE_PATTERN_INVALID", `${label} contains an invalid pattern`, { pattern: value, reason: error.message }));
    }
  }
  return result;
}

export function validateScope({
  allowedPaths,
  forbiddenPaths,
  controlPaths = [],
  changedPaths = [],
  allowEmptyAllowed = false,
  allowEmptyForbidden = false,
}) {
  const errors = [];
  const allowed = normalizePatterns(allowedPaths, "allowedPaths", errors);
  const forbidden = normalizePatterns(forbiddenPaths, "forbiddenPaths", errors);
  const controlSet = normalizePatterns(controlPaths, "controlPaths", errors);

  if (!allowEmptyAllowed && allowed.length === 0) errors.push(finding("SCOPE_ALLOWED_EMPTY", "At least one allowed path is required"));
  if (!allowEmptyForbidden && forbidden.length === 0) errors.push(finding("SCOPE_FORBIDDEN_EMPTY", "At least one forbidden path is required"));

  for (const allowedPattern of allowed) {
    for (const forbiddenPattern of forbidden) {
      if (patternsOverlap(allowedPattern, forbiddenPattern)) {
        errors.push(finding("SCOPE_ALLOWED_FORBIDDEN_OVERLAP", "Allowed and forbidden scopes overlap", {
          allowedPath: allowedPattern,
          forbiddenPath: forbiddenPattern
        }));
      }
    }
    for (const controlPattern of controlSet) {
      if (patternsOverlap(allowedPattern, controlPattern)) {
        errors.push(finding("SCOPE_CONTROL_ALLOWED", "Allowed scope overlaps a control path", {
          allowedPath: allowedPattern,
          controlPath: controlPattern
        }));
      }
    }
  }

  for (const controlPattern of controlSet) {
    if (!forbidden.some((candidate) => patternCovers(candidate, controlPattern))) {
      errors.push(finding("SCOPE_CONTROL_FORBIDDEN_MISSING", "A control path is not covered by forbiddenPaths", {
        controlPath: controlPattern
      }));
    }
  }

  for (const changedPath of changedPaths) {
    let normalized;
    try {
      normalized = normalizeRepoPath(changedPath);
    } catch (error) {
      errors.push(finding("SCOPE_CHANGED_PATH_INVALID", "Changed path is invalid", { path: changedPath, reason: error.message }));
      continue;
    }
    if (!allowed.some((pattern) => pathMatchesPattern(normalized, pattern))) {
      errors.push(finding("SCOPE_CHANGE_NOT_ALLOWED", "Changed path is outside allowedPaths", { path: normalized }));
    }
    if (forbidden.some((pattern) => pathMatchesPattern(normalized, pattern))) {
      errors.push(finding("SCOPE_CHANGE_FORBIDDEN", "Changed path is covered by forbiddenPaths", { path: normalized }));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: { allowedPaths: allowed, forbiddenPaths: forbidden, controlPaths: controlSet }
  };
}
