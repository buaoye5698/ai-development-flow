import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { digestJson } from "../core/canonical.mjs";
import { pathMatchesPattern } from "../core/path-policy.mjs";
import { validateSchema } from "../core/schema-validator.mjs";
import { BASELINE_PATH, CONFIG_PATH, LOCK_PATH, projectSchemaPaths } from "./constants.mjs";
import { digestFileContent, sha256, normalizeText } from "./digest.mjs";
import { readJson } from "./io.mjs";
import {
  assertDirectoryIsNotSymlink,
  assertSafeDestinationPath,
  resolveWithin,
  validateRelativePath,
} from "./path-safety.mjs";
import { buildScaffold, frameworkMetadata } from "./scaffold.mjs";
import { loadSpecAdapter } from "./spec-adapter.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

function canonicalSpecDigest(text) {
  return sha256(Buffer.from(normalizeText(text), "utf8"));
}

async function readSafeJson(rootDir, relativePath) {
  const absolutePath = await assertSafeDestinationPath(rootDir, relativePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`control file must be a regular non-link file: ${relativePath}`);
  }
  return readJson(absolutePath);
}

async function validateControlSchema(rootDir, value, schemaName, label, errors) {
  try {
    let schema;
    let missingError = null;
    for (const relativePath of projectSchemaPaths(schemaName)) {
      try {
        schema = await readSafeJson(rootDir, relativePath);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        missingError = error;
      }
    }
    if (!schema) throw missingError ?? new Error(`schema is unavailable: ${schemaName}`);
    for (const entry of validateSchema(value, schema)) {
      errors.push(finding("CONTROL_SCHEMA_INVALID", `${label} does not satisfy its formal schema`, {
        schema: schemaName,
        path: entry.path,
        keyword: entry.keyword,
        detail: entry.message,
      }));
    }
  } catch (error) {
    errors.push(finding("CONTROL_SCHEMA_UNAVAILABLE", `${label} schema cannot be loaded safely`, {
      schema: schemaName,
      detail: error.message,
    }));
  }
}

export async function inspectProject(targetDir) {
  const rootDir = path.resolve(targetDir);
  const errors = [];
  const warnings = [];
  const metrics = { managedFiles: 0, verifiedManagedFiles: 0, truthSources: 0 };
  const readinessMissing = [];

  if (!await exists(rootDir)) {
    errors.push(finding("PROJECT_MISSING", "target project does not exist", { path: rootDir }));
    return { status: "blocked", rootDir, errors, warnings, metrics };
  }

  try {
    await assertDirectoryIsNotSymlink(rootDir);
  } catch (error) {
    errors.push(finding("PROJECT_PATH_UNSAFE", "project path contains a symbolic link or junction", {
      path: rootDir,
      detail: error.message,
    }));
    return { status: "blocked", rootDir, errors, warnings, metrics };
  }

  let config;
  let baseline;
  let lock;
  try {
    config = await readSafeJson(rootDir, CONFIG_PATH);
    await validateControlSchema(rootDir, config, "project-config", "project config", errors);
  } catch (error) {
    errors.push(finding("CONTROL_FILE_INVALID", "config is missing, unsafe, or invalid JSON", {
      path: CONFIG_PATH,
      detail: error.message,
    }));
  }
  const baselinePath = typeof config?.baselinePath === "string" ? config.baselinePath : BASELINE_PATH;
  try {
    baseline = await readSafeJson(rootDir, baselinePath);
    await validateControlSchema(rootDir, baseline, "baseline", "baseline", errors);
  } catch (error) {
    errors.push(finding("CONTROL_FILE_INVALID", "baseline is missing, unsafe, or invalid JSON", {
      path: baselinePath,
      detail: error.message,
    }));
  }
  try {
    lock = await readSafeJson(rootDir, LOCK_PATH);
    await validateControlSchema(rootDir, lock, "framework-lock", "framework lock", errors);
  } catch (error) {
    errors.push(finding("CONTROL_FILE_INVALID", "framework lock is missing, unsafe, or invalid JSON", {
      path: LOCK_PATH,
      detail: error.message,
    }));
  }

  if (config) {
    if (config.schemaVersion !== 2 || typeof config.frameworkVersion !== "string" || typeof config.projectId !== "string") {
      errors.push(finding("CONFIG_CONTRACT_INVALID", "ai-flow.config.json does not satisfy the current bootstrap contract"));
    }
    for (const [name, value] of Object.entries(config.paths ?? {})) {
      try {
        validateRelativePath(value);
      } catch (error) {
        errors.push(finding("CONFIG_PATH_UNSAFE", `configured path is unsafe: ${name}`, { detail: error.message }));
      }
    }
    try {
      const adapterModule = config.specAdapter?.module;
      const controlPatterns = config.automationPolicy?.controlPaths ?? [];
      if (!controlPatterns.some((pattern) => pathMatchesPattern(adapterModule, pattern))) {
        errors.push(finding(
          "SPEC_ADAPTER_UNPROTECTED",
          "configured specification adapter must be covered by automationPolicy.controlPaths",
          { path: adapterModule ?? null },
        ));
      }
      await loadSpecAdapter(rootDir, config.specAdapter);
    } catch (error) {
      errors.push(finding(error.code ?? "SPEC_ADAPTER_INVALID", "configured specification adapter is invalid", {
        detail: error.message,
      }));
    }
  }

  if (baseline) {
    if (baseline.schemaVersion !== 1 || typeof baseline.baselineId !== "string") {
      errors.push(finding("BASELINE_CONTRACT_INVALID", "baseline does not satisfy the current bootstrap contract"));
    }
    const sources = Array.isArray(baseline.truthSources) ? baseline.truthSources : [];
    metrics.truthSources = sources.length;
    const canonical = sources.find((entry) => entry?.sourceId === baseline.canonicalSpecSourceId);
    if (!canonical) {
      errors.push(finding("CANONICAL_SPEC_UNDECLARED", "baseline does not identify a canonical specification source"));
    } else {
      try {
        const specPath = await assertSafeDestinationPath(rootDir, canonical.path);
        const stats = await lstat(specPath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error("canonical specification must be a regular non-link file");
        }
        const specText = await readFile(specPath, "utf8");
        const actual = canonicalSpecDigest(specText);
        if (actual !== canonical.digest) {
          errors.push(finding("SPEC_DIGEST_DRIFT", "canonical specification digest does not match the baseline", {
            path: canonical.path,
            expected: canonical.digest,
            actual,
          }));
        }
      } catch (error) {
        errors.push(finding("CANONICAL_SPEC_INVALID", "canonical specification cannot be read safely", {
          detail: error.message,
        }));
      }
    }
    if (baseline.status === "draft") {
      readinessMissing.push("active baseline");
    }
  }

  if (config && baseline) {
    try {
      const decisionRegister = await readSafeJson(rootDir, baseline.decisionRegister);
      if (!(decisionRegister.stageGates ?? []).some((entry) => entry.status === "authorized")) {
        readinessMissing.push("authorized stage gate");
      }
    } catch {
      readinessMissing.push("decision register");
    }
    try {
      const impactMap = await readSafeJson(rootDir, "ai-dev/impact-map.json");
      if ((impactMap.rules ?? []).length === 0) readinessMissing.push("impact map rules");
    } catch {
      readinessMissing.push("impact map");
    }
    try {
      const verifierRegistry = await readSafeJson(rootDir, "ai-dev/verifiers/registry.json");
      if ((verifierRegistry.verifiers ?? []).length === 0) readinessMissing.push("verifiers");
    } catch {
      readinessMissing.push("verifier registry");
    }
  }
  if (readinessMissing.length > 0) {
    warnings.push(finding(
      "PROJECT_NOT_READY",
      "project integrity is valid but implementation tasks still need project-owned control inputs",
      { missing: [...new Set(readinessMissing)].sort() },
    ));
  }

  if (lock) {
    if (
      lock.schemaVersion !== 1
      || typeof lock.frameworkVersion !== "string"
      || !Array.isArray(lock.managedFiles)
    ) {
      errors.push(finding("FRAMEWORK_LOCK_INVALID", "framework lock does not satisfy its current contract"));
    } else {
      const expectedDistributionDigest = digestJson({
        frameworkName: lock.frameworkName,
        frameworkVersion: lock.frameworkVersion,
        managedFiles: lock.managedFiles,
      });
      if (lock.distributionDigest !== expectedDistributionDigest) {
        errors.push(finding("FRAMEWORK_DISTRIBUTION_DIGEST_INVALID", "framework lock distribution digest is not self-consistent", {
          expected: expectedDistributionDigest,
          actual: lock.distributionDigest ?? null,
        }));
      }
      metrics.managedFiles = lock.managedFiles.length;
      const seen = new Set();
      for (const entry of lock.managedFiles) {
        try {
          const relativePath = validateRelativePath(entry.path);
          const key = relativePath.toLowerCase();
          if (seen.has(key)) throw new Error("duplicate case-insensitive managed path");
          seen.add(key);
          if (!/^sha256:[a-f0-9]{64}$/u.test(entry.digest ?? "")) throw new Error("invalid digest");
          const absolutePath = await assertSafeDestinationPath(rootDir, relativePath);
          const stats = await lstat(absolutePath);
          if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error("managed path must be a regular non-link file");
          }
          const bytes = await readFile(absolutePath);
          const actual = digestFileContent(relativePath, bytes);
          if (actual !== entry.digest) {
            errors.push(finding("MANAGED_FILE_DRIFT", "framework-managed file was modified", {
              path: relativePath,
              expected: entry.digest,
              actual,
            }));
          } else {
            metrics.verifiedManagedFiles += 1;
          }
        } catch (error) {
          errors.push(finding("MANAGED_FILE_INVALID", "framework-managed file is missing or unsafe", {
            path: entry?.path ?? null,
            detail: error.message,
          }));
        }
      }
      if (config && config.frameworkVersion !== lock.frameworkVersion) {
        errors.push(finding("FRAMEWORK_VERSION_MISMATCH", "project config and framework lock versions differ", {
          config: config.frameworkVersion,
          lock: lock.frameworkVersion,
        }));
      }
    }
  }

  return {
    status: errors.length === 0 ? "pass" : "blocked",
    rootDir,
    frameworkVersion: lock?.frameworkVersion ?? null,
    projectId: config?.projectId ?? null,
    errors,
    warnings,
    metrics,
    config,
    baseline,
    lock,
  };
}

export async function inspectUpgrade(targetDir, frameworkRoot) {
  const doctor = await inspectProject(targetDir);
  if (doctor.status !== "pass") {
    return {
      status: "blocked",
      code: "PROJECT_HEALTH_FAILED",
      currentVersion: (await frameworkMetadata(frameworkRoot)).version,
      installedVersion: doctor.frameworkVersion,
      errors: doctor.errors,
      warnings: doctor.warnings,
      changes: [],
    };
  }

  const canonical = doctor.baseline.truthSources.find(
    (entry) => entry.sourceId === doctor.baseline.canonicalSpecSourceId,
  );
  const specificationText = await readFile(resolveWithin(doctor.rootDir, canonical.path), "utf8");
  const packagePath = path.join(doctor.rootDir, "package.json");
  let projectName = doctor.projectId;
  if (await exists(packagePath)) {
    try {
      projectName = (await readJson(packagePath)).name ?? projectName;
    } catch {
      // package.json is project-owned and is not required for an upgrade check.
    }
  }
  const desired = await buildScaffold({
    frameworkRoot,
    projectId: doctor.projectId,
    projectName,
    specificationText,
    createdAt: doctor.baseline.createdAt,
  });
  const desiredByPath = new Map(desired.lock.managedFiles.map((entry) => [entry.path, entry]));
  const installedByPath = new Map(doctor.lock.managedFiles.map((entry) => [entry.path, entry]));
  const changes = [];

  for (const [filePath, desiredEntry] of desiredByPath) {
    const installed = installedByPath.get(filePath);
    if (!installed) {
      changes.push({ action: "add", path: filePath, targetDigest: desiredEntry.digest });
    } else if (installed.digest !== desiredEntry.digest) {
      changes.push({ action: "replace", path: filePath, fromDigest: installed.digest, targetDigest: desiredEntry.digest });
    }
  }
  for (const [filePath, installed] of installedByPath) {
    if (!desiredByPath.has(filePath)) {
      changes.push({ action: "obsolete", path: filePath, fromDigest: installed.digest });
    }
  }
  changes.sort((left, right) => left.path.localeCompare(right.path, "en"));

  return {
    status: desired.framework.version === doctor.lock.frameworkVersion
      && desired.lock.distributionDigest === doctor.lock.distributionDigest
      ? "current"
      : "update_available",
    currentVersion: desired.framework.version,
    installedVersion: doctor.lock.frameworkVersion,
    errors: [],
    warnings: doctor.warnings,
    changes,
  };
}
