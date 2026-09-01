import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PATH,
  DEFAULT_FRAMEWORK_VERSION,
  FRAMEWORK_NAME,
  LOCK_PATH,
} from "./constants.mjs";
import { digestJson } from "../core/canonical.mjs";
import { digestFileContent, normalizeText, sha256 } from "./digest.mjs";
import { listFiles, readJson } from "./io.mjs";
import { assertPortableFileSet, normalizeRepoPath, validateProjectId, validateRelativePath } from "./path-safety.mjs";

export const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DEMO_PROJECT_FILES = Object.freeze({
  minimal: Object.freeze([
    { source: "README.md.tpl", destination: "README.md" },
    { source: "ai-dev/baseline.json.tpl", destination: "ai-dev/baseline.json" },
    { source: "ai-dev/decisions/register.json", destination: "ai-dev/decisions/register.json" },
    { source: "ai-dev/impact-map.json", destination: "ai-dev/impact-map.json" },
    { source: "ai-dev/verifiers/registry.json", destination: "ai-dev/verifiers/registry.json" },
    { source: "demo-task.json", destination: "demo-task.json" },
    { source: "docs/product-spec.md", destination: "docs/product-spec.md" },
    { source: "src/normalize.mjs", destination: "src/normalize.mjs" },
    { source: "tests/normalize.test.mjs", destination: "tests/normalize.test.mjs" },
  ]),
});

function renderTemplate(value, replacements) {
  let rendered = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, replacement);
  }
  const unresolved = rendered.match(/__[A-Z0-9_]+__/gu);
  if (unresolved) throw new Error(`unresolved starter token(s): ${[...new Set(unresolved)].join(", ")}`);
  return rendered;
}

export function validateDisplayName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 || /[\r\n\0]/u.test(value)) {
    throw new Error("project name must be a single non-empty line of at most 100 characters");
  }
  return value;
}

export async function frameworkMetadata(frameworkRoot = FRAMEWORK_ROOT) {
  try {
    const packageJson = await readJson(path.join(frameworkRoot, "package.json"));
    return {
      name: packageJson.name ?? FRAMEWORK_NAME,
      version: packageJson.version ?? DEFAULT_FRAMEWORK_VERSION,
    };
  } catch {
    return { name: FRAMEWORK_NAME, version: DEFAULT_FRAMEWORK_VERSION };
  }
}

async function starterManifest(frameworkRoot) {
  const manifest = await readJson(path.join(frameworkRoot, "starter", "manifest.json"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.projectFiles) || !Array.isArray(manifest.managedMappings)) {
    throw new Error("starter/manifest.json does not use the supported current contract");
  }
  return manifest;
}

async function managedEntries(frameworkRoot, manifest, metadata) {
  const entries = [];
  for (const mapping of manifest.managedMappings) {
    const sourceRelative = validateRelativePath(mapping.source);
    const destinationRoot = validateRelativePath(mapping.destination);
    const sourceDirectory = path.join(frameworkRoot, ...sourceRelative.split("/"));
    for (const relativeFile of await listFiles(sourceDirectory)) {
      const sourcePath = path.join(sourceDirectory, ...relativeFile.split("/"));
      const destination = normalizeRepoPath(path.posix.join(destinationRoot, relativeFile));
      entries.push({
        path: destination,
        content: await readFile(sourcePath),
        ownership: "framework",
        source: normalizeRepoPath(path.posix.join(sourceRelative, relativeFile)),
      });
    }
  }

  const vendorPackage = `${JSON.stringify({
    name: metadata.name,
    version: metadata.version,
    private: true,
    type: "module",
    bin: { "ai-flow": "bin/ai-flow.mjs" },
    engines: { node: ">=20" },
  }, null, 2)}\n`;
  entries.push({
    path: "tools/ai-flow/package.json",
    content: Buffer.from(vendorPackage, "utf8"),
    ownership: "framework",
    source: "package.json#vendored-metadata",
  });
  return entries;
}

async function defaultSpecification(frameworkRoot, projectName) {
  const template = await readFile(path.join(frameworkRoot, "starter", "project", "docs", "product-spec.md.tpl"), "utf8");
  return normalizeText(renderTemplate(template, { __PROJECT_NAME__: projectName }));
}

function selectedDemo(demo) {
  if (demo === null || demo === undefined) return null;
  if (!Object.hasOwn(DEMO_PROJECT_FILES, demo)) throw new Error(`unsupported starter demo: ${demo}`);
  return demo;
}

async function demoSpecification(frameworkRoot, demo) {
  return readFile(path.join(frameworkRoot, "starter", "demo", demo, "docs", "product-spec.md"), "utf8");
}

async function demoProjectEntries(frameworkRoot, demo, replacements, specificationText) {
  const entries = [];
  for (const definition of DEMO_PROJECT_FILES[demo]) {
    const source = validateRelativePath(definition.source);
    const destination = validateRelativePath(definition.destination);
    const value = await readFile(path.join(frameworkRoot, "starter", "demo", demo, ...source.split("/")), "utf8");
    const content = destination === "docs/product-spec.md"
      ? specificationText
      : (source.endsWith(".tpl") ? renderTemplate(value, replacements) : value);
    entries.push({
      path: destination,
      content: Buffer.from(content, "utf8"),
      ownership: "project",
      adopt: "create_missing",
      source: normalizeRepoPath(path.posix.join("starter/demo", demo, source)),
    });
  }
  return entries;
}

function normalizedSpecification(value) {
  const normalized = normalizeText(value);
  if (normalized.includes("\0")) throw new Error("specification must be UTF-8 text without NUL characters");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export async function buildScaffold({
  frameworkRoot = FRAMEWORK_ROOT,
  projectId,
  projectName,
  specificationText = null,
  demo = null,
  createdAt = new Date().toISOString(),
} = {}) {
  validateProjectId(projectId);
  validateDisplayName(projectName);
  const metadata = await frameworkMetadata(frameworkRoot);
  const manifest = await starterManifest(frameworkRoot);
  const demoName = selectedDemo(demo);
  if (demoName && specificationText !== null) throw new Error("a starter demo cannot be combined with a custom specification");
  const specText = normalizedSpecification(
    specificationText
      ?? (demoName ? await demoSpecification(frameworkRoot, demoName) : await defaultSpecification(frameworkRoot, projectName)),
  );
  const specDigest = sha256(Buffer.from(specText, "utf8"));
  const replacements = {
    __PROJECT_ID_JSON__: JSON.stringify(projectId),
    __PROJECT_NAME__: projectName,
    __FRAMEWORK_VERSION__: metadata.version,
    __FRAMEWORK_VERSION_JSON__: JSON.stringify(metadata.version),
    __CREATED_AT_JSON__: JSON.stringify(createdAt),
    __SPEC_DIGEST_JSON__: JSON.stringify(specDigest),
  };

  let projectEntries = [];
  for (const definition of manifest.projectFiles) {
    const source = validateRelativePath(definition.source);
    const destination = validateRelativePath(definition.destination);
    const content = destination === "docs/product-spec.md"
      ? specText
      : renderTemplate(
        await readFile(path.join(frameworkRoot, "starter", "project", ...source.split("/")), "utf8"),
        replacements,
      );
    projectEntries.push({
      path: destination,
      content: Buffer.from(content, "utf8"),
      ownership: "project",
      adopt: definition.adopt,
      source: normalizeRepoPath(path.posix.join("starter/project", source)),
    });
  }
  if (demoName) {
    const byPath = new Map(projectEntries.map((entry) => [entry.path, entry]));
    for (const entry of await demoProjectEntries(frameworkRoot, demoName, replacements, specText)) byPath.set(entry.path, entry);
    projectEntries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
  }

  const frameworkEntries = await managedEntries(frameworkRoot, manifest, metadata);
  const managedFiles = frameworkEntries
    .map((entry) => ({
      path: entry.path,
      digest: digestFileContent(entry.path, entry.content),
      ownership: "framework",
      source: entry.source,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const lock = {
    schemaVersion: 1,
    frameworkName: metadata.name,
    frameworkVersion: metadata.version,
    installMode: "vendored",
    distributionDigest: digestJson({
      frameworkName: metadata.name,
      frameworkVersion: metadata.version,
      managedFiles,
    }),
    managedFiles,
  };
  const lockEntry = {
    path: LOCK_PATH,
    content: Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8"),
    ownership: "lock",
    adopt: "control_plane",
    source: "generated:framework-lock",
  };
  const entries = [...projectEntries, ...frameworkEntries, lockEntry]
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  assertPortableFileSet(entries.map((entry) => entry.path));
  for (const required of [BASELINE_PATH, LOCK_PATH, "ai-flow.config.json", "docs/product-spec.md"]) {
    if (!entries.some((entry) => entry.path === required)) throw new Error(`starter is missing required file: ${required}`);
  }

  return {
    schemaVersion: 1,
    framework: metadata,
    project: { id: projectId, name: projectName },
    ...(demoName ? { demo: demoName } : {}),
    specificationDigest: specDigest,
    directories: manifest.directories.map(validateRelativePath),
    entries,
    lock,
  };
}
