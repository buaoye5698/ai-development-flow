import path from "node:path";

import { buildAssetPolicy, canonicalTextDigest, digestJson, normalizeRepoPath, sha256 } from "../core/index.mjs";
import { readTextAtRevision, resolveBaseRevision } from "../verify/git-scope.mjs";

function directoriesForTarget(targetPath) {
  const directory = path.posix.dirname(normalizeRepoPath(targetPath));
  if (directory === ".") return [""];
  const segments = directory.split("/");
  return ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}

async function jsonAt(projectRoot, revision, relativePath) {
  return JSON.parse(await readTextAtRevision(projectRoot, revision, relativePath));
}

async function instructionBindingAt(projectRoot, revision, targetPaths, maxBytes = 32 * 1024) {
  const bindings = [];
  for (const targetPath of [...new Set(targetPaths)].sort()) {
    const files = [];
    let totalBytes = 0;
    for (const directory of directoriesForTarget(targetPath)) {
      let selected = null;
      for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
        const relativePath = directory ? path.posix.join(directory, name) : name;
        const text = await readTextAtRevision(projectRoot, revision, relativePath, { optional: true });
        if (text !== null && text.trim().length > 0) {
          const bytes = Buffer.from(text, "utf8");
          selected = { path: relativePath, contentDigest: sha256(bytes), size: bytes.length };
          break;
        }
      }
      if (!selected) continue;
      totalBytes += selected.size;
      if (totalBytes > maxBytes) {
        const error = new Error(`effective AGENTS instructions exceed ${maxBytes} bytes at the base revision`);
        error.code = "INSTRUCTION_LIMIT_EXCEEDED";
        throw error;
      }
      files.push(selected);
    }
    bindings.push({ targetPath, files, instructionChainDigest: digestJson(files) });
  }
  const digests = [...new Set(bindings.map((entry) => entry.instructionChainDigest))];
  if (digests.length > 1) {
    const error = new Error("base revision gives planned write paths different instruction chains");
    error.code = "INSTRUCTION_CHAIN_SPLIT_REQUIRED";
    throw error;
  }
  return { instructionChainDigest: digests[0] ?? digestJson([]), files: bindings[0]?.files ?? [] };
}

export async function loadActiveControl(projectRoot, taskPacket) {
  const resolved = await resolveBaseRevision(projectRoot, taskPacket.baseRevision);
  if (!resolved.ok || resolved.revision !== taskPacket.baseRevision) {
    const error = new Error("TaskPacket baseRevision is not a full resolvable commit");
    error.code = "BASE_ACTIVE_CONTROL_UNAVAILABLE";
    error.errors = resolved.errors;
    throw error;
  }
  const config = await jsonAt(projectRoot, resolved.revision, "ai-flow.config.json");
  const baseline = await jsonAt(projectRoot, resolved.revision, config.baselinePath);
  const impactMap = await jsonAt(projectRoot, resolved.revision, "ai-dev/impact-map.json");
  const verifierRegistry = await jsonAt(projectRoot, resolved.revision, "ai-dev/verifiers/registry.json");
  const frameworkLock = await jsonAt(projectRoot, resolved.revision, "ai-dev/framework-lock.json");
  const decisionRegister = await jsonAt(projectRoot, resolved.revision, baseline.decisionRegister);
  const assetPolicy = buildAssetPolicy({ config, baseline, impactMap });
  const instructionBinding = await instructionBindingAt(
    projectRoot,
    resolved.revision,
    taskPacket.taskKind === "evidence_collection" ? [] : taskPacket.scope.allowedPaths,
  );
  return {
    baseRevision: resolved.revision,
    config,
    baseline,
    impactMap,
    verifierRegistry,
    frameworkLock,
    decisionRegister,
    assetPolicy,
    instructionBinding,
  };
}

export async function validateBaseControlBinding(projectRoot, taskPacket) {
  const active = await loadActiveControl(projectRoot, taskPacket);
  const errors = [];
  const adapterText = await readTextAtRevision(
    projectRoot,
    active.baseRevision,
    active.config.specAdapter.module,
  );
  const expectedControlComponents = [
    { componentId: "project_config", path: "ai-flow.config.json", digest: digestJson(active.config) },
    { componentId: "impact_map", path: "ai-dev/impact-map.json", digest: digestJson(active.impactMap) },
    { componentId: "verifier_registry", path: "ai-dev/verifiers/registry.json", digest: digestJson(active.verifierRegistry) },
    { componentId: "spec_adapter", path: active.config.specAdapter.module, digest: canonicalTextDigest(adapterText) },
    { componentId: "framework_distribution", path: "ai-dev/framework-lock.json", digest: active.frameworkLock.distributionDigest },
    ...active.instructionBinding.files.map((entry, index) => ({
      componentId: `instructions:${String(index).padStart(4, "0")}`,
      path: entry.path,
      digest: entry.contentDigest,
    })),
  ].sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
  const expectedTruthComponents = [
    { componentId: "baseline", path: active.config.baselinePath, digest: digestJson(active.baseline) },
    ...active.baseline.truthSources.map((entry) => ({
      componentId: `truth:${entry.sourceId}`,
      path: entry.path,
      digest: entry.digest,
    })),
    { componentId: "decision_register", path: active.baseline.decisionRegister, digest: digestJson(active.decisionRegister) },
  ].sort((left, right) => left.componentId.localeCompare(right.componentId, "en"));
  if (digestJson(taskPacket.controlBinding?.components ?? []) !== digestJson(expectedControlComponents)) {
    errors.push({ code: "BASE_CONTROL_COMPONENT_SET_MISMATCH", message: "TaskPacket does not bind the complete base Active Control component set" });
  }
  if (digestJson(taskPacket.truthBinding?.components ?? []) !== digestJson(expectedTruthComponents)) {
    errors.push({ code: "BASE_TRUTH_COMPONENT_SET_MISMATCH", message: "TaskPacket does not bind the complete base Active Truth component set" });
  }
  if (active.assetPolicy.assetPolicyDigest !== taskPacket.controlBinding?.assetPolicyDigest) {
    errors.push({ code: "BASE_CONTROL_ASSET_POLICY_MISMATCH", message: "TaskPacket asset policy differs from base Active Control" });
  }
  if (active.instructionBinding.instructionChainDigest !== taskPacket.controlBinding?.instructionChainDigest) {
    errors.push({ code: "BASE_CONTROL_INSTRUCTIONS_MISMATCH", message: "TaskPacket instruction chain differs from base Active Control" });
  }
  const expectedControlDigest = digestJson({
    components: expectedControlComponents,
    assetPolicyDigest: active.assetPolicy.assetPolicyDigest,
    instructionChainDigest: active.instructionBinding.instructionChainDigest,
  });
  if (expectedControlDigest !== taskPacket.controlDigest) {
    errors.push({ code: "CONTROL_DIGEST_INVALID", message: "TaskPacket controlDigest differs from complete base Active Control" });
  }
  for (const source of active.baseline.truthSources) {
    const actualContent = canonicalTextDigest(await readTextAtRevision(projectRoot, active.baseRevision, source.path));
    if (actualContent !== source.digest) {
      errors.push({ code: "BASE_TRUTH_CONTENT_MISMATCH", message: "base truth content differs from its registered digest", componentId: `truth:${source.sourceId}`, path: source.path });
    }
  }
  const expectedTruthDigest = digestJson(expectedTruthComponents);
  if (expectedTruthDigest !== taskPacket.truthDigest) {
    errors.push({ code: "TRUTH_DIGEST_INVALID", message: "TaskPacket truthDigest differs from complete base Active Truth" });
  }
  return {
    ok: errors.length === 0,
    errors,
    active,
    expectedControlComponents,
    expectedTruthComponents,
    expectedControlDigest,
    expectedTruthDigest,
  };
}
