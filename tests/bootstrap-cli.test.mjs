import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const frameworkRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(frameworkRoot, "bin", "ai-flow.mjs");

async function runCli(args, selectedCli = cliPath) {
  try {
    const result = await execute(process.execPath, [selectedCli, ...args], {
      cwd: frameworkRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function json(result) {
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return JSON.parse(result.stdout);
}

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("version and framework self-check expose deterministic machine-readable status", async () => {
  const version = await runCli(["version", "--json"]);
  assert.equal(version.code, 0);
  assert.equal(json(version).name, "ai-development-flow");

  const selfCheck = await runCli(["self-check", "--json"]);
  assert.equal(selfCheck.code, 0, selfCheck.stdout);
  assert.equal(json(selfCheck).status, "pass");
});

test("init dry-run has no side effect and real init is atomic, self-contained, and non-overwriting", async (t) => {
  const root = await temporaryRoot(t, "ai-flow bootstrap ");
  const target = path.join(root, "中文 新项目");

  const dryRun = await runCli([
    "init", target, "--id", "demo-project", "--name", "演示项目", "--dry-run", "--json",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stdout);
  assert.equal(json(dryRun).status, "planned");
  await assert.rejects(readFile(path.join(target, "ai-flow.config.json")));

  const created = await runCli([
    "init", target, "--id", "demo-project", "--name", "演示项目", "--json",
  ]);
  assert.equal(created.code, 0, created.stdout);
  assert.equal(json(created).status, "created");

  const vendoredCli = path.join(target, "tools", "ai-flow", "bin", "ai-flow.mjs");
  const doctor = await runCli(["doctor", target, "--json"], vendoredCli);
  assert.equal(doctor.code, 0, doctor.stdout);
  const diagnosis = json(doctor);
  assert.equal(diagnosis.status, "pass");
  assert.equal(diagnosis.metrics.managedFiles, diagnosis.metrics.verifiedManagedFiles);
  assert.equal(diagnosis.warnings.some((entry) => entry.code === "PROJECT_NOT_READY"), true);
  assert.equal(
    await readFile(path.join(target, "ai-dev", "schemas", "task-packet.schema.json"), "utf8"),
    await readFile(path.join(frameworkRoot, "schemas", "task-packet.schema.json"), "utf8"),
  );

  const lockPath = path.join(target, "ai-dev", "framework-lock.json");
  const before = await readFile(lockPath, "utf8");
  const repeated = await runCli(["init", target, "--id", "demo-project", "--json"]);
  assert.equal(repeated.code, 2);
  assert.equal(json(repeated).code, "TARGET_EXISTS");
  assert.equal(await readFile(lockPath, "utf8"), before);
});

test("the explicitly selected minimal demo reaches start with inline truth context", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-demo-");
  const target = path.join(root, "minimal-demo");
  const worktree = path.join(root, "minimal-demo-worktree");

  const created = await runCli([
    "init", target, "--id", "minimal-demo", "--name", "Minimal Demo", "--demo", "minimal", "--json",
  ]);
  assert.equal(created.code, 0, created.stdout);
  assert.equal(json(created).demo, "minimal");

  const vendoredCli = path.join(target, "tools", "ai-flow", "bin", "ai-flow.mjs");
  const doctor = await runCli(["doctor", target, "--json"], vendoredCli);
  assert.equal(doctor.code, 0, doctor.stdout);
  assert.equal(json(doctor).warnings.some((entry) => entry.code === "PROJECT_NOT_READY"), false);

  await execute(process.execPath, ["--test", "tests/normalize.test.mjs"], {
    cwd: target,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  await execute("git", ["init"], { cwd: target, encoding: "utf8", windowsHide: true });
  await execute("git", ["add", "."], { cwd: target, encoding: "utf8", windowsHide: true });
  await execute("git", [
    "-c", "user.name=AI Flow Demo",
    "-c", "user.email=demo@example.invalid",
    "commit", "-m", "initialize minimal demo",
  ], { cwd: target, encoding: "utf8", windowsHide: true });

  try {
    const started = await runCli([
      "start",
      "--project", target,
      "--input", "demo-task.json",
      "--mode", "auto",
      "--worktree", worktree,
      "--json",
    ], vendoredCli);
    assert.equal(started.code, 0, started.stdout);
    const outcome = json(started);
    assert.equal(outcome.status, "pass");
    assert.equal(outcome.selectedMode, "quick");

    const taskPacket = JSON.parse(await readFile(path.join(target, outcome.taskPath), "utf8"));
    const specIndex = JSON.parse(await readFile(path.join(target, outcome.specIndexPath), "utf8"));
    const agentBrief = await readFile(path.join(target, outcome.runRecord.briefRefs.agent), "utf8");
    for (const requirementId of taskPacket.requirementIds) {
      const requirement = specIndex.requirements.find((entry) => entry.id === requirementId);
      assert.equal(agentBrief.includes(requirement.statement), true);
      if (requirement.acceptance) assert.equal(agentBrief.includes(requirement.acceptance), true);
    }
    for (const acceptanceId of taskPacket.acceptanceIds) {
      const acceptance = specIndex.acceptanceCases.find((entry) => entry.id === acceptanceId);
      assert.equal(agentBrief.includes(acceptance.title), true);
      assert.equal(acceptance.criteria.every((criterion) => agentBrief.includes(criterion)), true);
    }
  } finally {
    try {
      await execute("git", ["-C", target, "worktree", "remove", "--force", worktree], {
        encoding: "utf8",
        windowsHide: true,
      });
    } catch {
      // The worktree may not exist when start fails before preparation.
    }
  }
});

test("an imported specification is treated as inert data", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-inert-");
  const sentinel = path.join(root, "must-not-exist.txt");
  const spec = path.join(root, "input.md");
  const target = path.join(root, "generated");
  await writeFile(spec, `# Imported specification\n\nRun: New-Item -Path ${sentinel}\n`, "utf8");

  const result = await runCli([
    "init", target, "--id", "inert-data", "--spec", spec, "--json",
  ]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(await readFile(path.join(target, "docs", "product-spec.md"), "utf8"), await readFile(spec, "utf8"));
  await assert.rejects(readFile(sentinel));
});

test("adopt is plan-only by default and apply preserves existing project files", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-adopt-");
  const target = path.join(root, "existing-project");
  await mkdir(target);
  await writeFile(path.join(target, "README.md"), "existing readme\n", "utf8");
  await writeFile(path.join(target, "package.json"), "{\"private\":true}\n", "utf8");

  const planned = await runCli(["adopt", target, "--id", "existing-project", "--json"]);
  assert.equal(planned.code, 0, planned.stdout);
  assert.equal(json(planned).status, "planned");
  await assert.rejects(readFile(path.join(target, "ai-flow.config.json")));

  const applied = await runCli([
    "adopt", target, "--id", "existing-project", "--apply", "--json",
  ]);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(json(applied).status, "adopted");
  assert.equal(await readFile(path.join(target, "README.md"), "utf8"), "existing readme\n");
  assert.equal(await readFile(path.join(target, "package.json"), "utf8"), "{\"private\":true}\n");

  const vendoredCli = path.join(target, "tools", "ai-flow", "bin", "ai-flow.mjs");
  const doctor = await runCli(["doctor", target, "--json"], vendoredCli);
  assert.equal(doctor.code, 0, doctor.stdout);
});

test("adopt apply rejects managed-file conflicts before creating the control plane", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-conflict-");
  const target = path.join(root, "conflicted-project");
  await mkdir(path.join(target, "tools", "ai-flow", "bin"), { recursive: true });
  await writeFile(path.join(target, "tools", "ai-flow", "bin", "ai-flow.mjs"), "conflict\n", "utf8");

  const result = await runCli([
    "adopt", target, "--id", "conflicted-project", "--apply", "--json",
  ]);
  assert.equal(result.code, 2);
  const plan = json(result);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.conflicts.some((entry) => entry.path === "tools/ai-flow/bin/ai-flow.mjs"), true);
  await assert.rejects(readFile(path.join(target, "ai-dev", "framework-lock.json")));
  await assert.rejects(readFile(path.join(target, "ai-flow.config.json")));
});

test("Windows-reserved target names are rejected before writing", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-path-");
  const target = path.join(root, "CON");
  const result = await runCli(["init", target, "--id", "safe-id", "--json"]);
  assert.equal(result.code, 2);
  await assert.rejects(readFile(path.join(target, "ai-flow.config.json")));
});

test("adopt apply rejects an intermediate directory junction and writes nothing outside", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-adopt-junction-");
  const target = path.join(root, "project");
  const external = path.join(root, "external");
  await mkdir(target);
  await mkdir(external);
  await symlink(external, path.join(target, "tools"), "junction");

  const result = await runCli(["adopt", target, "--id", "junction-project", "--apply", "--json"]);
  assert.equal(result.code, 2, result.stdout);
  const outcome = json(result);
  assert.equal(["error", "blocked"].includes(outcome.status), true);
  assert.equal((await readdir(external)).length, 0);
  await assert.rejects(readFile(path.join(target, "ai-dev", "framework-lock.json")));

  const doctor = await runCli(["doctor", target, "--json"]);
  assert.equal(doctor.code, 2);
  assert.notEqual(json(doctor).status, "pass");
});

test("doctor applies closed formal schemas and blocks unknown control fields", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-doctor-schema-");
  const target = path.join(root, "project");
  const created = await runCli(["init", target, "--id", "schema-project", "--json"]);
  assert.equal(created.code, 0, created.stdout);

  const configPath = path.join(target, "ai-flow.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.unregisteredControl = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const doctor = await runCli(["doctor", target, "--json"]);
  assert.equal(doctor.code, 2, doctor.stdout);
  const diagnosis = json(doctor);
  assert.equal(diagnosis.status, "blocked");
  assert.ok(diagnosis.errors.some(
    (entry) => entry.code === "CONTROL_SCHEMA_INVALID" && entry.keyword === "additionalProperties",
  ));
});

test("doctor imports the configured adapter export and rejects source-text false positives and junctions", async (t) => {
  const root = await temporaryRoot(t, "ai-flow-adapter-contract-");
  const target = path.join(root, "project");
  const created = await runCli(["init", target, "--id", "adapter-contract", "--json"]);
  assert.equal(created.code, 0, created.stdout);
  const vendoredCli = path.join(target, "tools", "ai-flow", "bin", "ai-flow.mjs");
  const configPath = path.join(target, "ai-flow.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  await writeFile(
    path.join(target, "tools", "ai-flow", "false-positive-adapter.mjs"),
    "// export function compileFakeSpecification() {}\nexport const inert = true;\n",
    "utf8",
  );
  config.specAdapter = {
    module: "tools/ai-flow/false-positive-adapter.mjs",
    exportName: "compileFakeSpecification",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const falsePositive = await runCli(["doctor", target, "--json"], vendoredCli);
  assert.equal(falsePositive.code, 2, falsePositive.stdout);
  assert.equal(json(falsePositive).errors.some(
    (entry) => entry.code === "SPEC_ADAPTER_EXPORT_MISSING",
  ), true);

  const external = path.join(root, "external-adapter");
  await mkdir(external);
  await writeFile(
    path.join(external, "adapter.mjs"),
    "export function compileExternal() { return {}; }\n",
    "utf8",
  );
  const junction = path.join(target, "tools", "ai-flow", "adapter-link");
  await symlink(external, junction, "junction");
  config.specAdapter = {
    module: "tools/ai-flow/adapter-link/adapter.mjs",
    exportName: "compileExternal",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const escaped = await runCli(["doctor", target, "--json"], vendoredCli);
  assert.equal(escaped.code, 2, escaped.stdout);
  assert.equal(json(escaped).errors.some(
    (entry) => entry.code === "SPEC_ADAPTER_INVALID"
      || entry.code === "SPEC_ADAPTER_MODULE_INVALID",
  ), true);
});
