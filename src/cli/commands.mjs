import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { LOCK_PATH } from "./constants.mjs";
import { digestFileContent } from "./digest.mjs";
import { writeEntries } from "./io.mjs";
import {
  assertDirectoryIsNotSymlink,
  assertSafeDestinationPath,
  resolveWithin,
  validateProjectId,
  validateRelativePath,
} from "./path-safety.mjs";
import { inspectProject, inspectUpgrade } from "./project-state.mjs";
import { loadHealthyProject, writeJsonArtifact } from "./project-artifacts.mjs";
import { loadTask } from "./project-runtime.mjs";
import { buildScaffold, FRAMEWORK_ROOT, frameworkMetadata, validateDisplayName } from "./scaffold.mjs";
import { inspectFramework } from "./self-check.mjs";
import { inspectRun } from "../controller/index.mjs";
import { verifyProject } from "../verify/index.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function publicPlan(scaffold) {
  return {
    frameworkVersion: scaffold.framework.version,
    projectId: scaffold.project.id,
    ...(scaffold.demo ? { demo: scaffold.demo } : {}),
    specificationDigest: scaffold.specificationDigest,
    directories: scaffold.directories,
    files: scaffold.entries.map((entry) => ({ path: entry.path, ownership: entry.ownership })),
  };
}

async function readOptionalSpec(specPath) {
  if (!specPath) return null;
  const absolutePath = path.resolve(specPath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("--spec must point to a regular, non-symbolic-link file");
  }
  return readFile(absolutePath, "utf8");
}

export async function initProject({ target, projectId, projectName, specPath, demo = null, dryRun = false }) {
  const rootDir = path.resolve(target);
  if (rootDir === path.parse(rootDir).root) throw new Error("target cannot be a filesystem root");
  validateRelativePath(path.basename(rootDir));
  validateProjectId(projectId);
  validateDisplayName(projectName);
  const parentDir = path.dirname(rootDir);
  await assertDirectoryIsNotSymlink(parentDir);
  if (await exists(rootDir)) {
    return {
      status: "blocked",
      code: "TARGET_EXISTS",
      message: "init only accepts a target directory that does not exist",
      target: rootDir,
    };
  }

  const scaffold = await buildScaffold({
    frameworkRoot: FRAMEWORK_ROOT,
    projectId,
    projectName,
    specificationText: await readOptionalSpec(specPath),
    demo,
  });
  if (dryRun) return { status: "planned", target: rootDir, ...publicPlan(scaffold) };

  const staging = path.join(parentDir, `.ai-flow-init-${path.basename(rootDir)}-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: false });
    for (const directory of scaffold.directories) {
      await mkdir(resolveWithin(staging, directory), { recursive: true });
    }
    await writeEntries(staging, scaffold.entries);
    const verification = await inspectProject(staging);
    if (verification.status !== "pass") {
      throw new Error(`generated project failed doctor: ${verification.errors.map((entry) => entry.code).join(", ")}`);
    }
    if (await exists(rootDir)) throw new Error("target appeared while initialization was in progress");
    await rename(staging, rootDir);
    return {
      status: "created",
      target: rootDir,
      ...publicPlan(scaffold),
      warnings: verification.warnings,
    };
  } catch (error) {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function derivedProjectId(target) {
  const base = path.basename(path.resolve(target)).normalize("NFKC").replace(/\s+/gu, "-");
  return validateProjectId(base);
}

export async function adoptProject({
  target,
  projectId = null,
  projectName = null,
  apply = false,
  dryRun = false,
}) {
  const rootDir = path.resolve(target);
  await assertDirectoryIsNotSymlink(rootDir);
  await assertSafeDestinationPath(rootDir, LOCK_PATH);
  if (await exists(resolveWithin(rootDir, LOCK_PATH))) {
    return {
      status: "blocked",
      code: "ALREADY_ADOPTED",
      message: "framework lock already exists; use doctor or upgrade-check",
      target: rootDir,
    };
  }
  const id = projectId ?? derivedProjectId(rootDir);
  const name = projectName ?? path.basename(rootDir);
  const existingSpecPath = resolveWithin(rootDir, "docs/product-spec.md");
  await assertSafeDestinationPath(rootDir, "docs/product-spec.md");
  const specificationText = await exists(existingSpecPath) ? await readFile(existingSpecPath, "utf8") : null;
  const scaffold = await buildScaffold({
    frameworkRoot: FRAMEWORK_ROOT,
    projectId: id,
    projectName: name,
    specificationText,
  });
  const actions = [];
  const entriesToCreate = [];
  const conflicts = [];

  for (const directory of scaffold.directories) {
    await assertSafeDestinationPath(rootDir, directory);
  }
  for (const entry of scaffold.entries) {
    await assertSafeDestinationPath(rootDir, entry.path);
  }

  for (const entry of scaffold.entries) {
    const destination = resolveWithin(rootDir, entry.path);
    const present = await exists(destination);
    if (entry.ownership === "framework") {
      if (!present) {
        actions.push({ action: "create", path: entry.path, ownership: entry.ownership });
        entriesToCreate.push(entry);
      } else {
        const actual = digestFileContent(entry.path, await readFile(destination));
        const expected = digestFileContent(entry.path, entry.content);
        if (actual === expected) {
          actions.push({ action: "keep", path: entry.path, ownership: entry.ownership });
        } else {
          const conflict = { action: "conflict", path: entry.path, ownership: entry.ownership };
          actions.push(conflict);
          conflicts.push(conflict);
        }
      }
      continue;
    }

    if (entry.ownership === "lock") {
      actions.push({ action: "create", path: entry.path, ownership: entry.ownership });
      entriesToCreate.push(entry);
      continue;
    }

    if (entry.adopt === "suggest") {
      actions.push({ action: "manual_suggestion", path: entry.path, ownership: entry.ownership, present });
    } else if (entry.adopt === "control_plane" && present) {
      const actual = digestFileContent(entry.path, await readFile(destination));
      const expected = digestFileContent(entry.path, entry.content);
      if (actual !== expected) {
        const conflict = { action: "conflict", path: entry.path, ownership: entry.ownership };
        actions.push(conflict);
        conflicts.push(conflict);
      } else {
        actions.push({ action: "keep", path: entry.path, ownership: entry.ownership });
      }
    } else if (present) {
      actions.push({ action: "preserve", path: entry.path, ownership: entry.ownership });
    } else {
      actions.push({ action: "create", path: entry.path, ownership: entry.ownership });
      entriesToCreate.push(entry);
    }
  }
  actions.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const plan = {
    status: conflicts.length > 0 ? "blocked" : apply && !dryRun ? "ready_to_apply" : "planned",
    target: rootDir,
    frameworkVersion: scaffold.framework.version,
    projectId: id,
    conflicts,
    actions,
  };
  if (!apply || dryRun || conflicts.length > 0) return plan;

  for (const directory of scaffold.directories) {
    await assertSafeDestinationPath(rootDir, directory);
    await mkdir(resolveWithin(rootDir, directory), { recursive: true });
    await assertSafeDestinationPath(rootDir, directory);
  }
  for (const entry of entriesToCreate) await assertSafeDestinationPath(rootDir, entry.path);
  await writeEntries(rootDir, entriesToCreate);
  const verification = await inspectProject(rootDir);
  if (verification.status !== "pass") {
    return { ...plan, status: "blocked", code: "ADOPTION_DOCTOR_FAILED", verification };
  }
  return { ...plan, status: "adopted", verification };
}

export async function doctorProject({ target }) {
  return inspectProject(path.resolve(target));
}

export async function upgradeCheck({ target }) {
  return inspectUpgrade(path.resolve(target), FRAMEWORK_ROOT);
}

export async function selfCheck() {
  return inspectFramework(FRAMEWORK_ROOT);
}

export async function versionInfo() {
  const metadata = await frameworkMetadata(FRAMEWORK_ROOT);
  return { status: "pass", name: metadata.name, version: metadata.version, node: process.versions.node };
}

export async function runVerification({
  project,
  tier,
  task = null,
  runId = null,
  expectedTaskDigest = null,
}) {
  let subjectProject = project;
  let taskPacket = null;
  let boundTaskDigest = expectedTaskDigest;
  let runInspection = null;
  if (runId) {
    runInspection = await inspectRun({ project, runId });
    if (runInspection.status !== "pass") {
      return {
        status: "blocked",
        complete: false,
        code: "VERIFICATION_RUN_INVALID",
        runId,
        errors: runInspection.errors,
      };
    }
    if (runInspection.runRecord.state !== "verifying") {
      return {
        status: "blocked",
        complete: false,
        code: "VERIFICATION_RUN_STATE_INVALID",
        runId,
        errors: [{
          code: "VERIFICATION_RUN_STATE_INVALID",
          message: "run-bound verification requires the run to be in verifying state",
          state: runInspection.runRecord.state,
        }],
      };
    }
    const ctx = await loadHealthyProject(project);
    taskPacket = (await loadTask(ctx, runInspection.runRecord.taskPacketRef)).value;
    subjectProject = runInspection.runRecord.workspace.identifier;
    boundTaskDigest = runInspection.runRecord.expectedTaskDigest;
  }
  const verification = await verifyProject({
    project: subjectProject,
    tier,
    task,
    taskPacket,
    expectedTaskDigest: boundTaskDigest,
  });
  if (!Array.isArray(verification.results) || verification.results.length === 0) return verification;
  const doctor = await inspectProject(path.resolve(project));
  if (doctor.status !== "pass") {
    return {
      ...verification,
      status: "blocked",
      complete: false,
      code: "VERIFICATION_ARTIFACT_PROJECT_UNHEALTHY",
      errors: doctor.errors,
    };
  }
  const artifacts = [];
  for (const result of verification.results) {
    const relativePath = path.posix.join(
      doctor.config.paths.generated,
      "verification-results",
      `${result.resultDigest.slice("sha256:".length)}.json`,
    );
    const artifact = await writeJsonArtifact({
      projectRoot: doctor.rootDir,
      relativePath,
      allowedDirectory: doctor.config.paths.generated,
      value: result,
    });
    artifacts.push({
      reference: relativePath,
      resultId: result.resultId,
      resultDigest: result.resultDigest,
      artifact,
    });
  }
  return {
    ...verification,
    runId,
    subjectProjectRoot: path.resolve(subjectProject),
    artifactProjectRoot: doctor.rootDir,
    verificationResultArtifacts: artifacts,
  };
}
