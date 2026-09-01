import { randomUUID } from "node:crypto";
import { access, link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestJson, validateSchema } from "../core/index.mjs";
import { resolveSafeDirectory, resolveSafeFile } from "../verify/safe-path.mjs";
import { readJson } from "./io.mjs";
import {
  assertDirectoryIsNotSymlink,
  normalizeRepoPath,
  resolveWithin,
  validateRelativePath,
} from "./path-safety.mjs";
import { inspectProject } from "./project-state.mjs";
import { projectSchemaPaths } from "./constants.mjs";

const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

export class CliOperationError extends Error {
  constructor(code, message, { status = "blocked", ...details } = {}) {
    super(message);
    this.name = "CliOperationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function operationError(code, message, details) {
  throw new CliOperationError(code, message, details);
}

export async function guardedOperation(action) {
  try {
    return await action();
  } catch (error) {
    const details = error instanceof CliOperationError ? error.details : {};
    return {
      status: error instanceof CliOperationError ? error.status : "blocked",
      code: error?.code ?? "OPERATION_BLOCKED",
      message: error instanceof Error ? error.message : String(error),
      errors: details.errors ?? error?.errors ?? [],
      ...Object.fromEntries(Object.entries(details).filter(([key]) => key !== "errors")),
    };
  }
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function comparable(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function ensureWithinDirectory(relativePath, relativeDirectory, label = "path") {
  const candidate = validateRelativePath(relativePath);
  const directory = validateRelativePath(relativeDirectory);
  if (!comparable(candidate).startsWith(`${comparable(directory)}/`)) {
    operationError("ARTIFACT_PATH_OUTSIDE_DIRECTORY", `${label} must be under ${directory}`, {
      path: candidate,
      directory,
    });
  }
  return normalizeRepoPath(candidate);
}

export function resolveArtifactReference(relativeDirectory, argument, label) {
  if (typeof argument !== "string" || argument.length === 0) {
    operationError("ARTIFACT_REFERENCE_MISSING", `${label} is required`);
  }
  const candidate = FILE_ID.test(argument)
    ? path.posix.join(validateRelativePath(relativeDirectory), `${argument}.json`)
    : validateRelativePath(argument);
  if (!candidate.toLowerCase().endsWith(".json")) {
    operationError("ARTIFACT_REFERENCE_INVALID", `${label} must reference a JSON file`, { path: candidate });
  }
  return ensureWithinDirectory(candidate, relativeDirectory, label);
}

export async function readProjectJson(projectRoot, relativePath) {
  const normalized = validateRelativePath(relativePath);
  return readJson(await resolveSafeFile(projectRoot, normalized));
}

export async function readProjectBytes(projectRoot, relativePath) {
  const normalized = validateRelativePath(relativePath);
  return readFile(await resolveSafeFile(projectRoot, normalized));
}

export async function loadProjectSchema(projectRoot, schemaName) {
  let missingError = null;
  for (const relativePath of projectSchemaPaths(schemaName)) {
    try {
      return await readProjectJson(projectRoot, relativePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missingError = error;
    }
  }
  throw missingError ?? new Error(`project schema is unavailable: ${schemaName}`);
}

export function schemaErrors(label, value, schema) {
  return validateSchema(value, schema).map((entry) => ({
    code: "SCHEMA_INVALID",
    message: `${label} does not satisfy its schema`,
    path: entry.path,
    keyword: entry.keyword,
    detail: entry.message,
  }));
}

export async function assertProjectSchema(projectRoot, schemaName, label, value) {
  const errors = schemaErrors(label, value, await loadProjectSchema(projectRoot, schemaName));
  if (errors.length > 0) {
    operationError("ARTIFACT_SCHEMA_INVALID", `${label} does not satisfy its current contract`, {
      status: "fail",
      errors,
    });
  }
  return value;
}

export async function loadHealthyProject(project) {
  const projectRoot = path.resolve(project);
  try {
    await assertDirectoryIsNotSymlink(projectRoot);
  } catch (error) {
    operationError("PROJECT_INVALID", "project must be a real local directory", {
      errors: [{ code: "PROJECT_INVALID", message: error.message }],
    });
  }
  const doctor = await inspectProject(projectRoot);
  if (doctor.status !== "pass") {
    operationError("PROJECT_HEALTH_FAILED", "project doctor must pass before this operation", {
      errors: doctor.errors,
      warnings: doctor.warnings,
    });
  }
  await assertProjectSchema(projectRoot, "project-config", "project config", doctor.config);
  await assertProjectSchema(projectRoot, "baseline", "baseline", doctor.baseline);
  return {
    projectRoot,
    config: doctor.config,
    baseline: doctor.baseline,
    lock: doctor.lock,
    warnings: doctor.warnings,
  };
}

async function ensureOutputDirectory(projectRoot, relativeDirectory) {
  const normalized = validateRelativePath(relativeDirectory);
  let current = projectRoot;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        operationError("OUTPUT_DIRECTORY_UNSAFE", "output path contains a non-directory or symbolic link", {
          path: normalized,
        });
      }
    } catch (error) {
      if (error instanceof CliOperationError) throw error;
      if (error.code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
    }
  }
  await resolveSafeDirectory(projectRoot, normalized);
}

export async function writeJsonArtifact({
  projectRoot,
  relativePath,
  allowedDirectory,
  value,
  dryRun = false,
}) {
  const normalized = ensureWithinDirectory(relativePath, allowedDirectory, "output");
  if (dryRun) return { action: "planned", path: normalized };
  const directory = path.posix.dirname(normalized);
  await ensureOutputDirectory(projectRoot, directory);
  const destination = resolveWithin(projectRoot, normalized);
  if (await pathExists(destination)) {
    const current = await readJson(await resolveSafeFile(projectRoot, normalized));
    if (digestJson(current) === digestJson(value)) return { action: "current", path: normalized };
    operationError("ARTIFACT_CONFLICT", "an immutable artifact already exists with different content", {
      path: normalized,
    });
  }

  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryName = `.${path.basename(normalized)}.${randomUUID()}.tmp`;
  const temporaryPath = path.join(path.dirname(destination), temporaryName);
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
    await resolveSafeDirectory(projectRoot, directory);
    await link(temporaryPath, destination);
    await rm(temporaryPath, { force: true });
  } catch (error) {
    if (await pathExists(temporaryPath)) await rm(temporaryPath, { force: true });
    operationError(error.code === "EEXIST" ? "ARTIFACT_CONFLICT" : "ARTIFACT_WRITE_FAILED", "artifact could not be created atomically", {
      path: normalized,
      detail: error.message,
    });
  }
  return { action: "written", path: normalized };
}

export async function writeTextArtifact({
  projectRoot,
  relativePath,
  allowedDirectory,
  content,
  dryRun = false,
}) {
  const normalized = ensureWithinDirectory(relativePath, allowedDirectory, "output");
  if (typeof content !== "string") operationError("ARTIFACT_CONTENT_INVALID", "text artifact content must be a string");
  if (dryRun) return { action: "planned", path: normalized };
  const directory = path.posix.dirname(normalized);
  await ensureOutputDirectory(projectRoot, directory);
  const destination = resolveWithin(projectRoot, normalized);
  if (await pathExists(destination)) {
    const current = await readFile(await resolveSafeFile(projectRoot, normalized), "utf8");
    if (current === content) return { action: "current", path: normalized };
    operationError("ARTIFACT_CONFLICT", "an immutable artifact already exists with different content", { path: normalized });
  }
  const temporaryName = `.${path.basename(normalized)}.${randomUUID()}.tmp`;
  const temporaryPath = path.join(path.dirname(destination), temporaryName);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await resolveSafeDirectory(projectRoot, directory);
    await link(temporaryPath, destination);
    await rm(temporaryPath, { force: true });
  } catch (error) {
    if (await pathExists(temporaryPath)) await rm(temporaryPath, { force: true });
    operationError(error.code === "EEXIST" ? "ARTIFACT_CONFLICT" : "ARTIFACT_WRITE_FAILED", "artifact could not be created atomically", {
      path: normalized,
      detail: error.message,
    });
  }
  return { action: "written", path: normalized };
}

export async function listJsonArtifacts(projectRoot, relativeDirectory) {
  const rootDirectory = validateRelativePath(relativeDirectory);
  const absolute = resolveWithin(projectRoot, rootDirectory);
  if (!await pathExists(absolute)) return [];
  await resolveSafeDirectory(projectRoot, rootDirectory);
  const result = [];
  async function visit(currentRelative) {
    const currentAbsolute = await resolveSafeDirectory(projectRoot, currentRelative);
    const entries = await readdir(currentAbsolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const child = normalizeRepoPath(path.posix.join(currentRelative, entry.name));
      if (entry.isSymbolicLink()) {
        operationError("ARTIFACT_DIRECTORY_UNSAFE", "artifact directory contains a symbolic link", { path: child });
      }
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        result.push(child);
      }
    }
  }
  await visit(rootDirectory);
  return result;
}

export function assertObjectKeys(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    operationError("REQUEST_INVALID", "request must be a JSON object");
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    operationError("REQUEST_FIELD_UNKNOWN", "request contains unsupported fields", { fields: unknown.sort() });
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    operationError("REQUEST_FIELD_MISSING", "request is missing required fields", { fields: missing });
  }
  return value;
}
