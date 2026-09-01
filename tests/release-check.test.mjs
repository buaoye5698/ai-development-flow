import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { shouldScanDistributionText } from "../src/cli/self-check.mjs";

import {
  REQUIRED_WHITELIST_ENTRIES,
  inspectLicenseText,
  inspectPackageMetadata,
  inspectPackManifest,
  inspectStarterManifestCoverage,
  parsePackDryRunJson,
  scanPackageText,
} from "../tools/release-check.mjs";

function validMetadata() {
  return {
    name: "ai-development-flow",
    version: "0.2.0",
    private: true,
    license: "Apache-2.0",
    files: [...REQUIRED_WHITELIST_ENTRIES],
    scripts: {
      check: "node bin/ai-flow.mjs self-check && node --test",
      "release:check": "npm run check && node tools/release-check.mjs",
    },
  };
}

function validPackFiles() {
  return [
    "package.json",
    "README.md",
    "LICENSE",
    "ai-flow.config.json",
    "ai-dev/baseline.json",
    "bin/ai-flow.mjs",
    "src/cli/main.mjs",
    "src/core/index.mjs",
    "src/spec/index.mjs",
    "src/task/index.mjs",
    "src/verify/index.mjs",
    "src/workflow/index.mjs",
    "src/controller/index.mjs",
    "src/metrics/index.mjs",
    "schemas/project-config.schema.json",
    "starter/manifest.json",
    "docs/framework-spec.md",
  ].map((path) => ({ path }));
}

test("self-check scans only packaged text content", () => {
  const packageJson = { files: ["src/", "docs/"] };
  const text = Buffer.from("safe text\n", "utf8");
  assert.equal(shouldScanDistributionText("src/cli/main.mjs", packageJson, text), true);
  assert.equal(shouldScanDistributionText("docs/.editorconfig", packageJson, text), true);
  assert.equal(shouldScanDistributionText("docs/reference.pdf", packageJson, Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff])), false);
  assert.equal(shouldScanDistributionText("output/debug.md", packageJson, text), false);
});

test("release metadata and a complete allowlisted pack manifest pass", () => {
  assert.deepEqual(inspectPackageMetadata(validMetadata()), []);
  assert.deepEqual(inspectPackManifest({ files: validPackFiles() }), []);
  assert.deepEqual(
    parsePackDryRunJson(JSON.stringify([{ files: validPackFiles(), unpackedSize: 100 }])),
    { files: validPackFiles(), unpackedSize: 100 },
  );
});

test("release license is the canonical Apache-2.0 text", () => {
  const license = fs.readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
  assert.deepEqual(inspectLicenseText(license), []);
  assert.equal(inspectLicenseText(license.replace("Version 2.0", "Version 2.1"))[0]?.code, "LICENSE_CONTENT_INVALID");
});

test("release metadata protects private ownership and the exact files whitelist", () => {
  const metadata = validMetadata();
  metadata.private = false;
  metadata.license = "MIT";
  metadata.files = metadata.files.filter((entry) => entry !== "src/workflow/");
  metadata.files.push("examples/");
  metadata.scripts.prepack = "node mutate.mjs";
  metadata.scripts["release:check"] = "node tools/release-check.mjs";

  const codes = new Set(inspectPackageMetadata(metadata).map((entry) => entry.code));
  assert.equal(codes.has("PACKAGE_NOT_PRIVATE"), true);
  assert.equal(codes.has("PACKAGE_LICENSE_INVALID"), true);
  assert.equal(codes.has("PACKAGE_WHITELIST_MISSING"), true);
  assert.equal(codes.has("PACKAGE_WHITELIST_UNEXPECTED"), true);
  assert.equal(codes.has("PACK_LIFECYCLE_FORBIDDEN"), true);
  assert.equal(codes.has("RELEASE_SCRIPT_INVALID"), true);
});

test("pack manifest rejects missing modules, license, history and sensitive files", () => {
  const files = validPackFiles().filter(
    (entry) => !entry.path.startsWith("src/verify/") && entry.path !== "LICENSE",
  );
  files.push(
    { path: "ai-dev/evidence/run-001.json" },
    { path: "docs/client.pem" },
  );
  const codes = new Set(inspectPackManifest({ files }).map((entry) => entry.code));
  assert.equal(codes.has("PACK_REQUIRED_MODULE_MISSING"), true);
  assert.equal(codes.has("PACK_REQUIRED_FILE_MISSING"), true);
  assert.equal(codes.has("EVIDENCE_HISTORY_INCLUDED"), true);
  assert.equal(codes.has("SENSITIVE_FILE_SHAPE"), true);
  assert.equal(codes.has("PACK_PATH_NOT_WHITELISTED"), true);
});

test("pack manifest covers every starter source used at runtime", () => {
  const manifest = {
    projectFiles: [{ source: ".gitignore.tpl" }],
    managedMappings: [{ source: "src/core" }],
  };
  const complete = {
    files: [
      { path: "starter/project/.gitignore.tpl" },
      { path: "src/core/index.mjs" },
    ],
  };
  assert.deepEqual(inspectStarterManifestCoverage(complete, manifest), []);
  const issues = inspectStarterManifestCoverage({ files: [{ path: "starter/manifest.json" }] }, manifest);
  assert.deepEqual(
    new Set(issues.map((entry) => entry.code)),
    new Set(["PACK_STARTER_SOURCE_MISSING", "PACK_MANAGED_SOURCE_MISSING"]),
  );
});

test("starter derives both vendored and project control schemas from the canonical schema source", () => {
  const manifest = JSON.parse(fs.readFileSync(
    new URL("../starter/manifest.json", import.meta.url),
    "utf8",
  ));
  const schemaMappings = manifest.managedMappings.filter((entry) => entry.source === "schemas");
  assert.deepEqual(schemaMappings, [
    { source: "schemas", destination: "tools/ai-flow/schemas" },
    { source: "schemas", destination: "ai-dev/schemas" },
  ]);
});

test("text scan detects absolute development paths and credential-shaped values without echoing them", () => {
  const text = [
    "workspace=C:\\dev\\private-project",
    "api_key=\"abcdefghijklmnopqrstuvwx\"",
  ].join("\n");
  const findings = scanPackageText("docs/example.md", text);
  const codes = new Set(findings.map((entry) => entry.code));
  assert.equal(codes.has("ABSOLUTE_DEVELOPMENT_PATH"), true);
  assert.equal(codes.has("SECRET_SHAPE"), true);
  assert.equal(JSON.stringify(findings).includes("abcdefghijklmnopqrstuvwx"), false);
});

test("text scan detects escaped Windows paths and quoted credential keys without leaking values", () => {
  const escapedPath = ["C:", "private", "repo"].join("\\\\");
  const secretValue = "release-secret-value-123456";
  const text = [
    `const workspace = "${escapedPath}";`,
    JSON.stringify({ clientSecret: secretValue }),
  ].join("\n");

  const findings = scanPackageText("src/example.mjs", text);
  const pathFinding = findings.find((entry) => entry.code === "ABSOLUTE_DEVELOPMENT_PATH");
  const keyFinding = findings.find((entry) => entry.kind === "quoted_credential_key");
  assert.deepEqual(
    { path: pathFinding?.path, line: pathFinding?.line, kind: pathFinding?.kind },
    { path: "src/example.mjs", line: 1, kind: "windows_absolute_path" },
  );
  assert.deepEqual(
    { path: keyFinding?.path, line: keyFinding?.line, kind: keyFinding?.kind, name: keyFinding?.name },
    { path: "src/example.mjs", line: 2, kind: "quoted_credential_key", name: "clientSecret" },
  );
  const serialized = JSON.stringify(findings);
  assert.equal(serialized.includes(escapedPath), false);
  assert.equal(serialized.includes(secretValue), false);
});

test("text scan detects raw and escaped UNC paths plus explicit POSIX development roots", () => {
  const backslash = String.fromCharCode(92);
  const rawUnc = [backslash, backslash, "server", backslash, "share", backslash, "repo"].join("");
  const escapedUnc = rawUnc.replaceAll(backslash, backslash + backslash);
  const posixPath = ["", "workspace", "private", "repo"].join("/");
  for (const value of [rawUnc, escapedUnc]) {
    const findings = scanPackageText("src/unc-example.mjs", `workspace="${value}"`);
    assert.ok(findings.some((entry) => entry.kind === "unc_absolute_path"));
    assert.equal(JSON.stringify(findings).includes(value), false);
  }
  const posixFindings = scanPackageText("src/posix-example.mjs", `workspace="${posixPath}"`);
  assert.ok(posixFindings.some((entry) => entry.kind === "unix_absolute_path"));
  assert.equal(JSON.stringify(posixFindings).includes(posixPath), false);
});

test("UNC scan rejects regex fragments and actual framework sources stay clean", () => {
  const backslash = String.fromCharCode(92);
  const invalidCandidates = [
    [backslash, backslash, "server", backslash, "sha[re"].join(""),
    [backslash, backslash, "server", backslash, "sha*re"].join(""),
    [backslash, backslash, "server", backslash, backslash, "share"].join(""),
    [backslash, backslash, "s*", backslash, "s*"].join(""),
  ];
  for (const value of invalidCandidates) {
    assert.equal(scanPackageText("src/regex.mjs", value).some(
      (entry) => entry.kind === "unc_absolute_path",
    ), false);
  }

  for (const relativePath of ["schemas/baseline.schema.json", "src/spec/structured-markdown.mjs"]) {
    const text = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.deepEqual(scanPackageText(relativePath, text), [], relativePath);
  }
});
test("absolute path scan does not treat ordinary URLs or API routes as filesystem paths", () => {
  const safeText = [
    "https://example.com/opt/health",
    "https://example.com/workspace/items",
    "/api/v1/items",
    "/health",
  ].join("\\n");
  assert.equal(scanPackageText("docs/routes.md", safeText).some(
    (entry) => entry.code === "ABSOLUTE_DEVELOPMENT_PATH",
  ), false);
});
test("quoted credential-key scan requires an exact key name", () => {
  assert.deepEqual(
    scanPackageText("schemas/safe.json", JSON.stringify({ tokenBudget: 1000, passwordPolicy: "strict" })),
    [],
  );
});
test("pack JSON parser rejects non-JSON and multi-package output", () => {
  assert.throws(() => parsePackDryRunJson("not json"), /valid JSON/u);
  assert.throws(() => parsePackDryRunJson("[]"), /exactly one package/u);
});
