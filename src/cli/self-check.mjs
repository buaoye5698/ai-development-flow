import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { validateSchema } from "../core/schema-validator.mjs";
import { sha256, normalizeText } from "./digest.mjs";
import { listFiles, readJson } from "./io.mjs";
import { assertSafeDestinationPath, resolveWithin } from "./path-safety.mjs";
import { buildScaffold, FRAMEWORK_ROOT } from "./scaffold.mjs";
import { loadSpecAdapter } from "./spec-adapter.mjs";

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

function distributionLeak(text) {
  const windowsAbsolute = /(?:^|[\s"'\x60(])([A-Za-z]:[\\/][^\s"'\x60<>]+)/mu.exec(text);
  if (windowsAbsolute) return { kind: "windows_absolute_path", sample: windowsAbsolute[1] };
  const unixHome = /(?:^|[\s"'\x60(])((?:\/Users|\/home)\/[^\s"'\x60<>]+)/mu.exec(text);
  if (unixHome) return { kind: "user_home_path", sample: unixHome[1] };
  const privateKeyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  if (text.includes(privateKeyMarker)) return { kind: "private_key_marker", sample: privateKeyMarker };
  const tokenPrefix = ["s", "k", "-"].join("");
  const token = new RegExp(`\\b${tokenPrefix}[A-Za-z0-9_-]{20,}`, "u").exec(text);
  return token ? { kind: "secret_token_shape", sample: `${token[0].slice(0, 5)}...` } : null;
}

function isDistributionContentPath(relativePath, packageJson) {
  if (relativePath === "package.json" || relativePath === "README.md") return true;
  return (packageJson?.files ?? []).some((entry) => {
    const root = String(entry).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return root.length > 0 && (relativePath === root || relativePath.startsWith(`${root}/`));
  });
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const BINARY_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;

export function shouldScanDistributionText(relativePath, packageJson, bytes) {
  if (!isDistributionContentPath(relativePath, packageJson)) return false;
  if (!(bytes instanceof Uint8Array)) return false;
  try {
    return !BINARY_CONTROL_CHARACTERS.test(STRICT_UTF8.decode(bytes));
  } catch {
    return false;
  }
}

export async function inspectFramework(frameworkRoot = FRAMEWORK_ROOT) {
  const errors = [];
  const warnings = [];
  let packageJson;
  try {
    packageJson = await readJson(path.join(frameworkRoot, "package.json"));
    if (packageJson.name !== "ai-development-flow" || packageJson.bin?.["ai-flow"] !== "bin/ai-flow.mjs") {
      errors.push(finding("PACKAGE_ENTRY_INVALID", "package must expose ai-flow at bin/ai-flow.mjs"));
    }
    for (const lifecycle of ["preinstall", "install", "postinstall"]) {
      if (packageJson.scripts?.[lifecycle]) {
        errors.push(finding("LIFECYCLE_SCRIPT_FORBIDDEN", `package must not define ${lifecycle}`));
      }
    }
  } catch (error) {
    errors.push(finding("PACKAGE_INVALID", "package.json is missing or invalid", { detail: error.message }));
  }

  try {
    const [config, configSchema] = await Promise.all([
      readJson(path.join(frameworkRoot, "ai-flow.config.json")),
      readJson(path.join(frameworkRoot, "schemas", "project-config.schema.json")),
    ]);
    const validationErrors = validateSchema(config, configSchema);
    for (const entry of validationErrors) {
      errors.push(finding("FRAMEWORK_CONFIG_SCHEMA_INVALID", "framework config does not satisfy its schema", {
        path: entry.path,
        keyword: entry.keyword,
        detail: entry.message,
      }));
    }
    await loadSpecAdapter(frameworkRoot, config.specAdapter);
  } catch (error) {
    errors.push(finding("FRAMEWORK_CONFIG_INVALID", "framework config or specification adapter is invalid", {
      detail: error.message,
    }));
  }

  let scaffold;
  try {
    scaffold = await buildScaffold({
      frameworkRoot,
      projectId: "self-check-project",
      projectName: "Self Check Project",
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    if (scaffold.lock.managedFiles.length === 0) {
      errors.push(finding("MANAGED_FILES_EMPTY", "starter must vendor at least one framework-managed file"));
    }
    if (!scaffold.lock.managedFiles.some((entry) => entry.path.startsWith("ai-dev/schemas/"))) {
      errors.push(finding("SCHEMAS_NOT_VENDORED", "starter must vendor control-plane schemas"));
    }
    if (!scaffold.lock.managedFiles.some((entry) => entry.path.startsWith("tools/ai-flow/src/core/"))) {
      errors.push(finding("CORE_NOT_VENDORED", "starter must vendor deterministic core modules"));
    }
    for (const moduleName of ["spec", "task", "workflow", "metrics"]) {
      if (!scaffold.lock.managedFiles.some(
        (entry) => entry.path.startsWith(`tools/ai-flow/src/${moduleName}/`),
      )) {
        errors.push(finding("FRAMEWORK_MODULE_NOT_VENDORED", "starter is missing a required framework module", {
          module: moduleName,
        }));
      }
    }
    const lockSchema = await readJson(path.join(frameworkRoot, "schemas", "framework-lock.schema.json"));
    for (const entry of validateSchema(scaffold.lock, lockSchema)) {
      errors.push(finding("GENERATED_LOCK_SCHEMA_INVALID", "generated framework lock does not satisfy its schema", {
        path: entry.path,
        keyword: entry.keyword,
        detail: entry.message,
      }));
    }
  } catch (error) {
    errors.push(finding("STARTER_INVALID", "starter cannot produce a safe project plan", { detail: error.message }));
  }

  try {
    for (const relativePath of await listFiles(frameworkRoot)) {
      if (
        relativePath.startsWith(".git/")
        || relativePath.startsWith("node_modules/")
        || relativePath.startsWith(".ai-flow/")
      ) continue;
      const bytes = await readFile(path.join(frameworkRoot, ...relativePath.split("/")));
      if (!shouldScanDistributionText(relativePath, packageJson, bytes)) continue;
      const leak = distributionLeak(STRICT_UTF8.decode(bytes));
      if (leak) {
        errors.push(finding("DISTRIBUTION_CONTENT_LEAK", "package content contains a local absolute path or secret-shaped value", {
          path: relativePath,
          kind: leak.kind,
          sample: leak.sample,
        }));
      }
    }
  } catch (error) {
    errors.push(finding("DISTRIBUTION_SCAN_FAILED", "package content leak scan could not complete", {
      detail: error.message,
    }));
  }

  try {
    const baseline = await readJson(path.join(frameworkRoot, "ai-dev", "baseline.json"));
    const canonical = baseline.truthSources?.find(
      (entry) => entry.sourceId === baseline.canonicalSpecSourceId,
    );
    if (!canonical) {
      errors.push(finding("FRAMEWORK_SPEC_UNDECLARED", "framework baseline has no canonical specification"));
    } else {
      const bytes = await readFile(resolveWithin(frameworkRoot, canonical.path));
      const actual = sha256(Buffer.from(normalizeText(bytes.toString("utf8")), "utf8"));
      if (actual !== canonical.digest) {
        errors.push(finding("FRAMEWORK_SPEC_DRIFT", "framework specification digest differs from its baseline", {
          expected: canonical.digest,
          actual,
        }));
      }
    }
  } catch (error) {
    errors.push(finding("FRAMEWORK_BASELINE_INVALID", "framework baseline cannot be validated", { detail: error.message }));
  }

  if (packageJson && scaffold && packageJson.version !== scaffold.framework.version) {
    errors.push(finding("FRAMEWORK_VERSION_DRIFT", "package and starter framework versions differ"));
  }

  return {
    status: errors.length === 0 ? "pass" : "blocked",
    frameworkVersion: packageJson?.version ?? null,
    errors,
    warnings,
    metrics: {
      generatedFiles: scaffold?.entries.length ?? 0,
      managedFiles: scaffold?.lock.managedFiles.length ?? 0,
    },
  };
}
