import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { projectSchemaPaths } from "../cli/constants.mjs";
import { digestJson, sha256 } from "../core/canonical.mjs";
import {
  normalizeRepoPath,
  normalizeScopePattern,
  pathMatchesPattern,
  portablePathKey,
  validateScope,
} from "../core/path-policy.mjs";
import { assertSafeDestinationPath } from "../cli/path-safety.mjs";
import { runProcess } from "./process-runner.mjs";

function splitNull(value) {
  return value.split("\0").filter(Boolean).map(normalizeRepoPath);
}

async function git(projectRoot, args) {
  const result = await runProcess({
    command: "git",
    args,
    cwd: projectRoot,
    timeoutMs: 15_000,
    outputLimitBytes: 64 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    const error = new Error(result.stderr.trim() || result.error || `git ${args[0]} failed`);
    error.code = "GIT_COMMAND_FAILED";
    error.result = result;
    throw error;
  }
  return result.stdout;
}

export async function readTextAtRevision(projectRoot, revision, relativePath, { optional = false } = {}) {
  const normalized = normalizeRepoPath(relativePath);
  try {
    return await git(projectRoot, ["show", `${revision}:${normalized}`]);
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

export async function readProjectSchemaAtRevision(projectRoot, revision, schemaName) {
  for (const relativePath of projectSchemaPaths(schemaName)) {
    const text = await readTextAtRevision(projectRoot, revision, relativePath, { optional: true });
    if (text !== null) return { path: relativePath, text, value: JSON.parse(text) };
  }
  const error = new Error(`project schema is unavailable at ${revision}: ${schemaName}`);
  error.code = "PROJECT_SCHEMA_UNAVAILABLE";
  error.schemaName = schemaName;
  throw error;
}

function samePath(left, right) {
  const normalize = (value) => {
    const normalized = path.resolve(value).replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export async function inspectGitRepository(projectRoot) {
  try {
    const gitRoot = (await git(projectRoot, ["rev-parse", "--show-toplevel"])).trim();
    if (!samePath(gitRoot, projectRoot)) {
      return {
        ok: false,
        errors: [{
          code: "GIT_ROOT_MISMATCH",
          message: "the selected project must be the Git repository root",
          expected: path.resolve(projectRoot),
          actual: gitRoot,
        }],
      };
    }
    const headRevision = (await git(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    return { ok: true, gitRoot, headRevision, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: "GIT_REPOSITORY_REQUIRED",
        message: "deterministic verification requires an initialized Git repository with a HEAD commit",
        detail: error.message,
      }],
    };
  }
}

export async function resolveBaseRevision(projectRoot, baseRevision) {
  try {
    const resolved = (
      await git(projectRoot, ["rev-parse", "--verify", "--end-of-options", `${baseRevision}^{commit}`])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(resolved)) throw new Error("Git returned an invalid commit id");
    return { ok: true, revision: resolved, errors: [] };
  } catch (error) {
    return {
      ok: false,
      revision: null,
      errors: [{
        code: "BASE_REVISION_INVALID",
        message: "task baseRevision does not resolve to a commit",
        baseRevision,
        detail: error.message,
      }],
    };
  }
}

export async function changedPathsSince(projectRoot, resolvedBaseRevision) {
  const [diff, untracked] = await Promise.all([
    git(projectRoot, ["diff", "--no-renames", "--name-only", "-z", resolvedBaseRevision, "--"]),
    git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...splitNull(diff), ...splitNull(untracked)])].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

async function ignoredPathsMatchingPatterns(projectRoot, patterns) {
  const normalizedPatterns = [...new Set(patterns ?? [])].map(normalizeScopePattern);
  if (normalizedPatterns.length === 0) return [];
  const pathspecs = normalizedPatterns.map((pattern) =>
    pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern);
  const output = await git(projectRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...pathspecs,
  ]);
  return [...new Set(splitNull(output).filter((entry) =>
    normalizedPatterns.some((pattern) => pathMatchesPattern(entry, pattern))))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

export async function listRepositoryFiles(projectRoot) {
  const output = await git(projectRoot, ["ls-files", "-co", "--exclude-standard", "-z"]);
  return [...new Set(splitNull(output))].sort((left, right) => left.localeCompare(right, "en"));
}

export function frameworkProcessArtifactPrefixes(config) {
  const candidates = [
    config?.paths?.tasks,
    config?.paths?.runs,
    config?.paths?.reviews,
    config?.paths?.evidence,
    config?.paths?.authorizations,
    config?.paths?.generated,
    config?.paths?.cache,
    config?.paths?.controller,
  ];
  return [...new Set(candidates
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map(normalizeRepoPath))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

async function baseTreeEntry(projectRoot, baseRevision, relativePath) {
  const output = await git(projectRoot, ["ls-tree", "-z", baseRevision, "--", relativePath]);
  const record = output.split("\0").find(Boolean);
  if (!record) return null;
  const tab = record.indexOf("\t");
  if (tab < 0) throw new Error(`Git returned an invalid tree entry for ${relativePath}`);
  const [mode, type, objectId] = record.slice(0, tab).split(" ");
  return { mode, type, objectId };
}

async function indexTreeEntry(projectRoot, relativePath) {
  const output = await git(projectRoot, ["ls-files", "--stage", "-z", "--", relativePath]);
  const record = output.split("\0").find(Boolean);
  if (!record) return null;
  const tab = record.indexOf("\t");
  if (tab < 0) throw new Error(`Git returned an invalid index entry for ${relativePath}`);
  const [mode, objectId, stage] = record.slice(0, tab).split(" ");
  if (stage !== "0") {
    const error = new Error(`subject path has an unresolved Git index stage: ${relativePath}`);
    error.code = "SUBJECT_INDEX_UNMERGED";
    throw error;
  }
  return { mode, objectId };
}

function includedContentPath(relativePath, excluded, prefixes) {
  const key = portablePathKey(relativePath);
  return !excluded.has(key) && !prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
}

async function finalContentEntry(projectRoot, baseRevision, relativePath) {
  const absolutePath = await assertSafeDestinationPath(projectRoot, relativePath);
  const [base, index] = await Promise.all([
    baseTreeEntry(projectRoot, baseRevision, relativePath),
    indexTreeEntry(projectRoot, relativePath),
  ]);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return {
        path: relativePath,
        type: "symlink",
        mode: "120000",
        contentDigest: sha256(Buffer.from(await readlink(absolutePath), "utf8")),
      };
    }
    if (stats.isFile()) {
      const bytes = await readFile(absolutePath);
      const symlinkEntry = index?.mode === "120000" ? index : base?.mode === "120000" ? base : null;
      if (symlinkEntry) {
        const recordedTarget = Buffer.from(await git(projectRoot, ["cat-file", "blob", symlinkEntry.objectId]), "utf8");
        if (sha256(bytes) === sha256(recordedTarget)) {
          return {
            path: relativePath,
            type: "symlink",
            mode: "120000",
            contentDigest: sha256(bytes),
          };
        }
      }
      const executable = process.platform === "win32"
        ? index?.mode === "100755" || (!index && base?.mode === "100755")
        : (stats.mode & 0o111) !== 0;
      return {
        path: relativePath,
        type: "file",
        mode: executable ? "100755" : "100644",
        contentDigest: sha256(bytes),
      };
    }
    if (stats.isDirectory() && (index?.mode === "160000" || base?.mode === "160000")) {
      const objectId = (await git(projectRoot, ["-C", relativePath, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
      return {
        path: relativePath,
        type: "gitlink",
        mode: "160000",
        contentDigest: sha256(Buffer.from(objectId, "ascii")),
      };
    }
    const error = new Error(`subject path is not a regular file, symbolic link, or gitlink: ${relativePath}`);
    error.code = "SUBJECT_CONTENT_UNSUPPORTED_TYPE";
    throw error;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (index?.mode === "160000") {
      return {
        path: relativePath,
        type: "gitlink",
        mode: "160000",
        contentDigest: sha256(Buffer.from(index.objectId, "ascii")),
      };
    }
    if (index?.mode === "120000") {
      return {
        path: relativePath,
        type: "symlink",
        mode: "120000",
        contentDigest: sha256(Buffer.from(await git(projectRoot, ["cat-file", "blob", index.objectId]), "utf8")),
      };
    }
    return {
      path: relativePath,
      type: "deleted",
      mode: base?.mode ?? "000000",
      contentDigest: sha256(Buffer.alloc(0)),
    };
  }
}

export async function computeSubjectContentSnapshot(
  projectRoot,
  baseRevision,
  { excludedPaths = [], excludedPrefixes = [] } = {},
) {
  const resolved = await resolveBaseRevision(projectRoot, baseRevision);
  if (!resolved.ok) {
    const error = new Error("subject content requires a resolvable base commit");
    error.code = "SUBJECT_BASE_REVISION_INVALID";
    error.errors = resolved.errors;
    throw error;
  }
  const excluded = new Set(excludedPaths.map((entry) => portablePathKey(entry)));
  const prefixes = [...new Set(excludedPrefixes.map((entry) => portablePathKey(entry)))];
  const changedPaths = (await changedPathsSince(projectRoot, resolved.revision))
    .filter((entry) => includedContentPath(entry, excluded, prefixes));
  const portableKeys = new Map();
  for (const relativePath of changedPaths) {
    const key = portablePathKey(relativePath);
    if (portableKeys.has(key) && portableKeys.get(key) !== relativePath) {
      const error = new Error(`subject contains portable path aliases: ${portableKeys.get(key)} and ${relativePath}`);
      error.code = "SUBJECT_PORTABLE_PATH_COLLISION";
      throw error;
    }
    portableKeys.set(key, relativePath);
  }
  const entries = [];
  for (const relativePath of changedPaths) {
    entries.push(await finalContentEntry(projectRoot, resolved.revision, relativePath));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const subject = { baseRevision: resolved.revision, entries };
  return {
    baseRevision: resolved.revision,
    changedPaths,
    entries,
    subjectContentDigest: digestJson(subject),
  };
}

async function snapshotPath(projectRoot, relativePath) {
  const absolutePath = await assertSafeDestinationPath(projectRoot, relativePath);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return {
        path: relativePath,
        type: "symlink",
        targetDigest: sha256(await readlink(absolutePath)),
      };
    }
    if (stats.isFile()) {
      return {
        path: relativePath,
        type: "file",
        mode: stats.mode & 0o777,
        size: stats.size,
        contentDigest: sha256(await readFile(absolutePath)),
      };
    }
    return { path: relativePath, type: "non_regular", mode: stats.mode };
  } catch (error) {
    if (error.code === "ENOENT") return { path: relativePath, type: "missing" };
    throw error;
  }
}

async function snapshotPaths(projectRoot, relativePaths) {
  const result = [];
  for (const relativePath of [...new Set(relativePaths)].sort((left, right) => left.localeCompare(right, "en"))) {
    result.push(await snapshotPath(projectRoot, relativePath));
  }
  return result;
}

function parseIndexEntries(value) {
  const byPath = new Map();
  for (const record of value.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, blob, stage] = record.slice(0, tab).split(" ");
    const relativePath = normalizeRepoPath(record.slice(tab + 1));
    if (stage === "0") byPath.set(relativePath, { path: relativePath, mode, blob });
  }
  return byPath;
}

export async function computeWorktreeSnapshot(
  projectRoot,
  headRevision,
  { excludedPaths = [], excludedPrefixes = [] } = {},
) {
  const [trackedNames, stagedNames, unstagedNames, untrackedNames, indexOutput] = await Promise.all([
    git(projectRoot, ["diff", "--name-only", "-z", headRevision, "--"]),
    git(projectRoot, ["diff", "--cached", "--name-only", "-z", headRevision, "--"]),
    git(projectRoot, ["diff", "--name-only", "-z", "--"]),
    git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(projectRoot, ["ls-files", "--stage", "-z"]),
  ]);
  const excluded = new Set(excludedPaths.map((entry) => portablePathKey(entry)));
  const prefixes = [...new Set(excludedPrefixes.map((entry) => portablePathKey(entry)))];
  const included = (entry) => {
    const key = portablePathKey(entry);
    return !excluded.has(key)
      && !prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
  };
  const trackedPaths = splitNull(trackedNames).filter(included);
  const stagedPaths = splitNull(stagedNames).filter(included);
  const unstagedPaths = splitNull(unstagedNames).filter(included);
  const untrackedPaths = splitNull(untrackedNames).filter(included);
  const indexByPath = parseIndexEntries(indexOutput);
  const stagedIndex = [...new Set(stagedPaths)]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((relativePath) => indexByPath.get(relativePath) ?? { path: relativePath, type: "deleted" });
  const snapshot = {
    headRevision,
    trackedFromHead: await snapshotPaths(projectRoot, trackedPaths),
    stagedIndex,
    unstaged: await snapshotPaths(projectRoot, unstagedPaths),
    untracked: await snapshotPaths(projectRoot, untrackedPaths),
  };
  const worktreeDigest = digestJson(snapshot);
  const clean = trackedPaths.length === 0
    && stagedPaths.length === 0
    && unstagedPaths.length === 0
    && untrackedPaths.length === 0;
  return {
    clean,
    worktreeDigest,
    subjectRevision: clean ? headRevision : `${headRevision}+${worktreeDigest}`,
    snapshot,
  };
}

export async function inspectTaskScope({
  projectRoot,
  baseRevision,
  taskPath,
  allowedPaths,
  forbiddenPaths,
  controlPaths,
  excludedPrefixes = [],
}) {
  const resolved = await resolveBaseRevision(projectRoot, baseRevision);
  if (!resolved.ok) return resolved;
  const [ordinaryChanges, ignoredForbiddenChanges] = await Promise.all([
    changedPathsSince(projectRoot, resolved.revision),
    ignoredPathsMatchingPatterns(projectRoot, forbiddenPaths),
  ]);
  const allChangedPaths = [...new Set([...ordinaryChanges, ...ignoredForbiddenChanges])]
    .sort((left, right) => left.localeCompare(right, "en"));
  const normalizedTaskPath = taskPath ? normalizeRepoPath(taskPath) : null;
  const taskKey = normalizedTaskPath ? portablePathKey(normalizedTaskPath) : null;
  const excludedPrefixKeys = [...new Set(excludedPrefixes.map((entry) => portablePathKey(entry)))];
  const excludedByProcessPrefix = (entry) => {
    const key = portablePathKey(entry);
    return excludedPrefixKeys.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
  };
  const changedPaths = allChangedPaths.filter((entry) =>
    portablePathKey(entry) !== taskKey && !excludedByProcessPrefix(entry));
  const excludedControlPaths = normalizedTaskPath && allChangedPaths.some(
    (entry) => portablePathKey(entry) === taskKey,
  )
    ? [normalizedTaskPath]
    : [];
  const excludedProcessPaths = allChangedPaths.filter(excludedByProcessPrefix);
  const validation = validateScope({
    allowedPaths,
    forbiddenPaths,
    controlPaths,
    changedPaths,
    allowEmptyAllowed: (allowedPaths ?? []).length === 0,
  });
  return {
    ok: validation.ok,
    revision: resolved.revision,
    allChangedPaths,
    changedPaths,
    excludedControlPaths,
    excludedProcessPaths,
    errors: validation.errors,
    normalized: validation.normalized,
  };
}
