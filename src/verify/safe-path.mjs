import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveWithin, validateRelativePath } from "../cli/path-safety.mjs";

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function resolveSafePath(projectRoot, relativePath, expectedKind) {
  const rootReal = await realpath(projectRoot);
  const normalized = relativePath === "." && expectedKind === "directory"
    ? null
    : validateRelativePath(relativePath);
  if (!normalized) {
    const rootStats = await lstat(projectRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("project root must be a real directory");
    }
    return projectRoot;
  }

  const absolutePath = resolveWithin(projectRoot, normalized);
  let current = projectRoot;
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`path contains a symbolic link: ${normalized}`);
    }
    const final = index === segments.length - 1;
    if (!final && !stats.isDirectory()) {
      throw new Error(`path parent is not a directory: ${normalized}`);
    }
    if (final && expectedKind === "file" && !stats.isFile()) {
      throw new Error(`path must be a regular file: ${normalized}`);
    }
    if (final && expectedKind === "directory" && !stats.isDirectory()) {
      throw new Error(`path must be a directory: ${normalized}`);
    }
  }
  const targetReal = await realpath(absolutePath);
  if (isOutside(rootReal, targetReal)) {
    throw new Error(`path resolves outside the project root: ${normalized}`);
  }
  return absolutePath;
}

export function resolveSafeFile(projectRoot, relativePath) {
  return resolveSafePath(projectRoot, relativePath, "file");
}

export function resolveSafeDirectory(projectRoot, relativePath) {
  return resolveSafePath(projectRoot, relativePath, "directory");
}
