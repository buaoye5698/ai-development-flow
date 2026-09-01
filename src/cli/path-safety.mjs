import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  normalizeRepoPath as normalizeCoreRepoPath,
  portablePathKey,
} from "../core/path-policy.mjs";
import { WINDOWS_RESERVED_NAME } from "./constants.mjs";

export function normalizeRepoPath(value) {
  const candidate = typeof value === "string"
    ? value.replaceAll("\\", "/").replace(/^\.\//u, "")
    : value;
  return normalizeCoreRepoPath(candidate);
}

export function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    throw new Error(`path must be a non-empty relative path: ${String(value)}`);
  }
  return normalizeRepoPath(value);
}

export function resolveWithin(rootDir, relativePath) {
  const normalized = validateRelativePath(relativePath);
  const candidate = path.resolve(rootDir, ...normalized.split("/"));
  const relative = path.relative(rootDir, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes target directory: ${relativePath}`);
  }
  return candidate;
}

export function assertPortableFileSet(paths) {
  const seen = new Map();
  for (const value of paths) {
    const normalized = validateRelativePath(value);
    const key = portablePathKey(normalized);
    if (seen.has(key)) {
      throw new Error(`case-insensitive path collision: ${seen.get(key)} and ${normalized}`);
    }
    seen.set(key, normalized);
  }
}

export function validateProjectId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(value)) {
    throw new Error("project id must be 2-128 ASCII letters, digits, dots, underscores, or hyphens");
  }
  if (WINDOWS_RESERVED_NAME.test(value)) {
    throw new Error("project id is a Windows reserved name");
  }
  return value;
}

export async function assertAbsoluteDirectoryChainIsSafe(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const remainder = path.relative(parsed.root, absolute);
  for (const segment of remainder.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`directory chain contains a non-directory, symbolic link, or junction: ${current}`);
    }
  }
  await realpath(absolute);
  return absolute;
}

export async function assertSafeDestinationPath(rootDir, relativePath) {
  await assertAbsoluteDirectoryChainIsSafe(rootDir);
  const normalized = validateRelativePath(relativePath);
  let current = rootDir;
  let missingParent = false;
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (missingParent) continue;
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missingParent = true;
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`destination path contains a symbolic link or junction: ${normalized}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`destination parent is not a directory: ${normalized}`);
    }
  }
  return resolveWithin(rootDir, normalized);
}

export async function assertDirectoryIsNotSymlink(directory) {
  await assertAbsoluteDirectoryChainIsSafe(directory);
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`directory must be a real directory, not a symbolic link: ${directory}`);
  }
  await realpath(directory);
}
