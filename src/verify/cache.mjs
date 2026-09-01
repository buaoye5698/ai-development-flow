import { access, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestJson, sha256, stableStringify } from "../core/canonical.mjs";
import { normalizeScopePattern, portablePathKey } from "../core/path-policy.mjs";
import { readJson } from "../cli/io.mjs";
import { resolveWithin, validateRelativePath } from "../cli/path-safety.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkPath(projectRoot, relativeDirectory) {
  let current = projectRoot;
  for (const segment of relativeDirectory.replaceAll("\\", "/").split("/").filter(Boolean)) {
    current = path.join(current, segment);
    if (!await exists(current)) continue;
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) throw new Error(`cache path contains a symbolic link: ${relativeDirectory}`);
  }
}

function unsafeInput(code, message, relativePath) {
  const error = new Error(message);
  error.code = code;
  error.path = relativePath;
  return error;
}

function exclusionKeys(excludedPaths) {
  return excludedPaths.map((entry) => portablePathKey(validateRelativePath(entry)));
}

function isExcluded(relativePath, excluded) {
  const key = portablePathKey(relativePath);
  return key === ".git"
    || key.startsWith(".git/")
    || excluded.some((base) => key === base || key.startsWith(`${base}/`));
}

async function snapshotFile(absolutePath, relativePath, stats) {
  if (stats.isSymbolicLink()) {
    throw unsafeInput(
      "VERIFIER_INPUT_SYMLINK",
      `declared verifier input contains a symbolic link or junction: ${relativePath}`,
      relativePath,
    );
  }
  if (!stats.isFile()) {
    throw unsafeInput(
      "VERIFIER_INPUT_NON_REGULAR",
      `declared verifier input is not a regular file: ${relativePath}`,
      relativePath,
    );
  }
  const bytes = await readFile(absolutePath);
  return {
    path: relativePath,
    type: "file",
    size: stats.size,
    contentDigest: sha256(bytes),
  };
}

async function snapshotExact(projectRoot, relativePath, excluded) {
  if (isExcluded(relativePath, excluded)) return [{ path: relativePath, type: "excluded" }];
  const absolutePath = resolveWithin(projectRoot, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return [{ path: relativePath, type: "missing" }];
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    return [{ path: relativePath, type: "directory" }];
  }
  return [await snapshotFile(absolutePath, relativePath, stats)];
}

async function snapshotRecursive(projectRoot, basePath, excluded) {
  if (isExcluded(basePath, excluded)) return [{ path: basePath, type: "excluded" }];
  const baseAbsolute = resolveWithin(projectRoot, basePath);
  let baseStats;
  try {
    baseStats = await lstat(baseAbsolute);
  } catch (error) {
    if (error.code === "ENOENT") return [{ path: basePath, type: "missing" }];
    throw error;
  }
  if (baseStats.isSymbolicLink()) {
    throw unsafeInput(
      "VERIFIER_INPUT_SYMLINK",
      `declared verifier input contains a symbolic link or junction: ${basePath}`,
      basePath,
    );
  }
  if (!baseStats.isDirectory()) return snapshotExact(projectRoot, basePath, excluded);

  const inputs = [{ path: basePath, type: "directory" }];
  async function visit(absoluteDirectory, relativeDirectory) {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll("\\", "/");
      if (isExcluded(relativePath, excluded)) {
        inputs.push({ path: relativePath, type: "excluded" });
        continue;
      }
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw unsafeInput(
          "VERIFIER_INPUT_SYMLINK",
          `declared verifier input contains a symbolic link or junction: ${relativePath}`,
          relativePath,
        );
      }
      if (stats.isDirectory()) {
        inputs.push({ path: relativePath, type: "directory" });
        await visit(absolutePath, relativePath);
      } else {
        inputs.push(await snapshotFile(absolutePath, relativePath, stats));
      }
    }
  }
  await visit(baseAbsolute, basePath);
  return inputs;
}

export function environmentFingerprint(environment = process.env) {
  const entries = Object.keys(environment)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, sha256(String(environment[key] ?? ""))]);
  return digestJson({
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    environment: entries,
  });
}

export async function digestDeclaredInputs({ projectRoot, verifier, excludedPaths = [] }) {
  const excluded = exclusionKeys(excludedPaths);
  const patterns = verifier.inputPatterns.map(normalizeScopePattern)
    .sort((left, right) => left.localeCompare(right, "en"));
  const inputs = [];
  for (const pattern of patterns) {
    const recursive = pattern.endsWith("/**");
    const basePath = recursive ? pattern.slice(0, -3) : pattern;
    const entries = recursive
      ? await snapshotRecursive(projectRoot, basePath, excluded)
      : await snapshotExact(projectRoot, basePath, excluded);
    inputs.push({ pattern, entries });
  }
  return { digest: digestJson(inputs), inputs };
}

export function verificationCacheKey({
  baselineDigest,
  definitionDigest,
  declaredInputDigest,
  environmentDigest,
}) {
  return digestJson({
    baselineDigest,
    definitionDigest,
    declaredInputDigest,
    environmentDigest,
  });
}

function cacheRelativePath(config, cacheKey) {
  const fileName = `${cacheKey.replace(/^sha256:/u, "")}.json`;
  return path.posix.join(config.paths.cache, "verification", fileName);
}

export async function readVerificationCache({ projectRoot, config, cacheKey, resultSchema }) {
  const relativePath = cacheRelativePath(config, cacheKey);
  const absolutePath = resolveWithin(projectRoot, relativePath);
  if (!await exists(absolutePath)) return null;
  try {
    await assertNoSymlinkPath(projectRoot, path.posix.dirname(relativePath));
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const value = await readJson(absolutePath);
    if (value.schemaVersion !== 1 || value.cacheKey !== cacheKey) return null;
    const { validateSchema } = await import("../core/schema-validator.mjs");
    if (validateSchema(value.result, resultSchema).length > 0) return null;
    return { ...value.result, cacheHit: true };
  } catch {
    return null;
  }
}

export async function writeVerificationCache({ projectRoot, config, cacheKey, result }) {
  const relativePath = cacheRelativePath(config, cacheKey);
  const directory = path.posix.dirname(relativePath);
  await assertNoSymlinkPath(projectRoot, directory);
  await mkdir(resolveWithin(projectRoot, directory), { recursive: true });
  await assertNoSymlinkPath(projectRoot, directory);
  const absolutePath = resolveWithin(projectRoot, relativePath);
  const payload = `${stableStringify({ schemaVersion: 1, cacheKey, result })}\n`;
  try {
    await writeFile(absolutePath, payload, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
