#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_WHITELIST_ENTRIES = Object.freeze([
  "LICENSE",
  "ai-flow.config.json",
  "ai-dev/baseline.json",
  "bin/",
  "src/cli/",
  "src/core/",
  "src/spec/",
  "src/task/",
  "src/verify/",
  "src/workflow/",
  "src/controller/",
  "src/metrics/",
  "schemas/",
  "starter/",
  "docs/",
]);

export const REQUIRED_PACKAGE_PREFIXES = Object.freeze([
  "src/cli/",
  "src/core/",
  "src/spec/",
  "src/task/",
  "src/verify/",
  "src/workflow/",
  "src/controller/",
  "src/metrics/",
  "schemas/",
  "starter/",
  "docs/",
]);

const REQUIRED_PACKAGE_FILES = Object.freeze([
  "package.json",
  "README.md",
  "LICENSE",
  "ai-flow.config.json",
  "ai-dev/baseline.json",
  "bin/ai-flow.mjs",
]);

const ALLOWED_EXACT_FILES = new Set(REQUIRED_PACKAGE_FILES);
const ALLOWED_PREFIXES = REQUIRED_PACKAGE_PREFIXES;
const EVIDENCE_HISTORY_PREFIXES = Object.freeze([
  ".ai-flow/cache/",
  ".ai-flow/generated/",
  "ai-dev/evidence/",
  "ai-dev/reviews/",
  "ai-dev/runs/",
  "ai-dev/tasks/",
  "generated/",
]);
const SENSITIVE_FILE_PATTERNS = Object.freeze([
  /(?:^|\/)\.env(?:\.|$)/iu,
  /\.(?:key|p12|pfx|pem)$/iu,
  /(?:^|\/)(?:credentials|secrets?)(?:\.|\/)/iu,
]);
const UNC_SEGMENT_PATTERN = String.raw`[\p{L}\p{N}_$-]+(?:\.[\p{L}\p{N}_$-]+)*`;
const UNC_PATH_PATTERN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9+.\-\\])(?:\\{2}${UNC_SEGMENT_PATTERN}\\${UNC_SEGMENT_PATTERN}(?:\\${UNC_SEGMENT_PATTERN})*|\\{4}${UNC_SEGMENT_PATTERN}\\{2}${UNC_SEGMENT_PATTERN}(?:\\{2}${UNC_SEGMENT_PATTERN})*)(?=$|[\s"'\x60),;])`,
  "u",
);
const ABSOLUTE_PATH_PATTERNS = Object.freeze([
  {
    kind: "windows_absolute_path",
    pattern: /(?:^|[^A-Za-z0-9+.-])(?:[A-Za-z]:(?:[\\/](?![\\/])|\\\\))[^\r\n"'`)]+/u,
  },
  {
    kind: "unc_absolute_path",
    pattern: UNC_PATH_PATTERN,
  },
  {
    kind: "unix_absolute_path",
    pattern: /(?:^|[\s"'(`])\/(?:Users|home|mnt|private|opt|var|tmp|srv|workspace|root)\/[^\s"'`)]+/u,
  },
  {
    kind: "file_url_absolute_path",
    pattern: /file:\/\/\/(?:[A-Za-z]:|Users\/|home\/|mnt\/|private\/|opt\/|var\/|tmp\/|srv\/|workspace\/|root\/)/iu,
  },
]);
const SECRET_SHAPES = Object.freeze([
  { kind: "private_key", pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { kind: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { kind: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { kind: "cloud_secret_id", pattern: /\bAKID[A-Za-z0-9]{13,}\b/u },
  {
    kind: "assigned_credential",
    pattern: /\b(?<name>api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]\s*["'][A-Za-z0-9+/_=-]{12,}["']/iu,
  },
  {
    kind: "quoted_credential_key",
    pattern: /(["'])(?<name>api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret(?:[_-]?key)?|password|credential|token)\1\s*:/iu,
  },
]);
const APACHE_2_0_LICENSE_DIGEST = "sha256:c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizePackPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split("/").some((segment) => segment === ".." || segment.length === 0)) {
    return null;
  }
  return normalized;
}

function isAllowedPackagePath(filePath) {
  return ALLOWED_EXACT_FILES.has(filePath)
    || ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function inspectPackageMetadata(packageJson) {
  const issues = [];
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return [issue("PACKAGE_METADATA_INVALID", "package.json must contain an object")];
  }
  if (packageJson.private !== true) {
    issues.push(issue("PACKAGE_NOT_PRIVATE", "package.json must set private to true"));
  }
  if (packageJson.license !== "Apache-2.0") {
    issues.push(issue("PACKAGE_LICENSE_INVALID", "package.json license must be Apache-2.0"));
  }
  if (packageJson.scripts?.["release:check"] !== "npm run check && node tools/release-check.mjs") {
    issues.push(issue("RELEASE_SCRIPT_INVALID", "release:check must run the existing check before the pack scan"));
  }
  for (const lifecycle of ["prepack", "prepare", "postpack"]) {
    if (packageJson.scripts?.[lifecycle]) {
      issues.push(issue("PACK_LIFECYCLE_FORBIDDEN", `package must not define ${lifecycle}`, { lifecycle }));
    }
  }
  const declared = Array.isArray(packageJson.files) ? packageJson.files : [];
  const declaredSet = new Set(declared);
  for (const entry of REQUIRED_WHITELIST_ENTRIES) {
    if (!declaredSet.has(entry)) {
      issues.push(issue("PACKAGE_WHITELIST_MISSING", "package files whitelist is missing a required entry", { entry }));
    }
  }
  for (const entry of declared) {
    if (!REQUIRED_WHITELIST_ENTRIES.includes(entry)) {
      issues.push(issue("PACKAGE_WHITELIST_UNEXPECTED", "package files whitelist contains an unexpected entry", { entry }));
    }
  }
  return issues;
}

export function inspectLicenseText(text) {
  if (typeof text !== "string") {
    return [issue("LICENSE_CONTENT_INVALID", "LICENSE must contain the canonical Apache-2.0 text")];
  }
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const digest = `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  return digest === APACHE_2_0_LICENSE_DIGEST
    ? []
    : [issue("LICENSE_CONTENT_INVALID", "LICENSE must contain the canonical Apache-2.0 text")];
}

export function parsePackDryRunJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error("npm pack did not return valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
    throw new Error("npm pack JSON must describe exactly one package and its files");
  }
  return parsed[0];
}

export function inspectPackManifest(pack) {
  if (!pack || !Array.isArray(pack.files)) {
    return [issue("PACK_MANIFEST_INVALID", "npm pack manifest is missing files")];
  }
  const issues = [];
  const paths = [];
  const seen = new Set();
  for (const entry of pack.files) {
    const filePath = normalizePackPath(entry?.path);
    if (!filePath) {
      issues.push(issue("PACK_PATH_UNSAFE", "npm pack returned an unsafe file path"));
      continue;
    }
    if (seen.has(filePath)) {
      issues.push(issue("PACK_PATH_DUPLICATE", "npm pack returned a duplicate file path", { path: filePath }));
      continue;
    }
    seen.add(filePath);
    paths.push(filePath);
    if (EVIDENCE_HISTORY_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      issues.push(issue("EVIDENCE_HISTORY_INCLUDED", "release artifact contains project evidence history", { path: filePath }));
    }
    if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filePath))) {
      issues.push(issue("SENSITIVE_FILE_SHAPE", "release artifact contains a sensitive file shape", { path: filePath }));
    }
    if (!isAllowedPackagePath(filePath)) {
      issues.push(issue("PACK_PATH_NOT_WHITELISTED", "release artifact contains a path outside the package whitelist", { path: filePath }));
    }
  }
  for (const filePath of REQUIRED_PACKAGE_FILES) {
    if (!seen.has(filePath)) {
      issues.push(issue("PACK_REQUIRED_FILE_MISSING", "release artifact is missing a required file", { path: filePath }));
    }
  }
  for (const prefix of REQUIRED_PACKAGE_PREFIXES) {
    if (!paths.some((filePath) => filePath.startsWith(prefix))) {
      issues.push(issue("PACK_REQUIRED_MODULE_MISSING", "release artifact is missing a required module tree", { prefix }));
    }
  }
  return issues;
}

export function inspectStarterManifestCoverage(pack, manifest) {
  if (!pack || !Array.isArray(pack.files) || !manifest
    || !Array.isArray(manifest.projectFiles) || !Array.isArray(manifest.managedMappings)) {
    return [issue("PACK_STARTER_MANIFEST_INVALID", "starter manifest coverage cannot be inspected")];
  }
  const packedPaths = pack.files
    .map((entry) => normalizePackPath(entry?.path))
    .filter(Boolean);
  const packedSet = new Set(packedPaths);
  const issues = [];
  for (const definition of manifest.projectFiles) {
    const sourcePath = normalizePackPath(`starter/project/${definition?.source ?? ""}`);
    if (!sourcePath || !packedSet.has(sourcePath)) {
      issues.push(issue(
        "PACK_STARTER_SOURCE_MISSING",
        "release artifact is missing a starter project source",
        { path: sourcePath ?? null },
      ));
    }
  }
  for (const mapping of manifest.managedMappings) {
    const sourceRoot = normalizePackPath(mapping?.source);
    if (!sourceRoot || !packedPaths.some(
      (filePath) => filePath === sourceRoot || filePath.startsWith(`${sourceRoot}/`),
    )) {
      issues.push(issue(
        "PACK_MANAGED_SOURCE_MISSING",
        "release artifact is missing a managed source tree",
        { path: sourceRoot ?? null },
      ));
    }
  }
  return issues;
}

export function scanPackageText(filePath, text) {
  const issues = [];
  for (const shape of ABSOLUTE_PATH_PATTERNS) {
    const match = shape.pattern.exec(text);
    if (match) {
      issues.push(issue("ABSOLUTE_DEVELOPMENT_PATH", "packaged text contains an absolute development path", {
        path: filePath,
        line: lineNumberAt(text, match.index),
        kind: shape.kind,
      }));
    }
  }
  for (const shape of SECRET_SHAPES) {
    const match = shape.pattern.exec(text);
    if (match) {
      const details = {
        path: filePath,
        line: lineNumberAt(text, match.index),
        kind: shape.kind,
      };
      if (match.groups?.name) details.name = match.groups.name;
      issues.push(issue("SECRET_SHAPE", "packaged text contains a credential-like value", details));
    }
  }
  return issues;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function inspectPackedFileContents(projectRoot, pack) {
  const issues = [];
  const root = await realpath(projectRoot);
  for (const entry of pack.files) {
    const filePath = normalizePackPath(entry?.path);
    if (!filePath) continue;
    const candidate = path.join(root, ...filePath.split("/"));
    let stats;
    let resolved;
    try {
      stats = await lstat(candidate);
      resolved = await realpath(candidate);
    } catch {
      issues.push(issue("PACK_FILE_UNREADABLE", "packed file cannot be read from the project", { path: filePath }));
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || !isWithin(root, resolved)) {
      issues.push(issue("PACK_FILE_UNSAFE", "packed file must be a regular in-project file", { path: filePath }));
      continue;
    }
    const content = await readFile(resolved);
    if (!content.includes(0)) {
      issues.push(...scanPackageText(filePath, content.toString("utf8")));
    }
  }
  return issues;
}

function runNpmPackDryRun(projectRoot) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !/\.(?:c?js|mjs)$/iu.test(npmExecPath)) {
    throw new Error("release:check must run through the current npm executable");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      npmExecPath,
      "pack",
      "--dry-run",
      "--json",
      "--ignore-scripts",
    ], {
      cwd: projectRoot,
      env: { ...process.env, npm_config_update_notifier: "false" },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`npm pack --dry-run failed with exit code ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

export async function runReleaseArtifactCheck(projectRoot) {
  const [packageJson, starterManifest, licenseText] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then((text) => JSON.parse(text)),
    readFile(path.join(projectRoot, "starter", "manifest.json"), "utf8").then((text) => JSON.parse(text)),
    readFile(path.join(projectRoot, "LICENSE"), "utf8"),
  ]);
  const issues = inspectPackageMetadata(packageJson);
  issues.push(...inspectLicenseText(licenseText));
  const pack = parsePackDryRunJson(await runNpmPackDryRun(projectRoot));
  issues.push(...inspectPackManifest(pack));
  issues.push(...inspectStarterManifestCoverage(pack, starterManifest));
  issues.push(...await inspectPackedFileContents(projectRoot, pack));
  return {
    status: issues.length === 0 ? "pass" : "blocked",
    package: packageJson.name ?? null,
    version: packageJson.version ?? null,
    fileCount: pack.files.length,
    unpackedSize: pack.unpackedSize ?? null,
    issues,
  };
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = await runReleaseArtifactCheck(projectRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "blocked",
      code: "RELEASE_CHECK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
