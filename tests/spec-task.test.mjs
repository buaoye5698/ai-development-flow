import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { digestJson, portablePathKey, sha256, stableStringify, validateSchema } from "../src/core/index.mjs";
import { compileStructuredMarkdown } from "../src/spec/index.mjs";
import { analyzeImpact } from "../src/task/impact-analysis.mjs";
import { buildContextManifest } from "../src/task/context-manifest.mjs";
import { compileTask } from "../src/task/task-compiler.mjs";

const SPEC = `# Example 产品规格书

> 版本：1.0.0
> 状态：active

## 1. 来源登记

| 来源 ID | 标题 | authority | 路径 |
|---|---|---|---|
| SRC-001 | Owner brief | authoritative_input | docs/owner-brief.md |

## 2. 规范性需求

**REQ-001（必须｜archive）** 系统必须保存有效记录。
验收：记录在事务完成后可查询。

**REQ-SEC-001（必须｜security）** 所有变更必须保持审计关联。
验收：每条变更具有 operation ID。

## 3. 验收矩阵

| 验收 ID | 标题 | 通过条件 |
|---|---|---|
| AT-001 | 保存记录 | 事务完成；记录可查询 |
| AT-SEC-001 | 审计关联 | 事件包含 operation ID |

## 4. 需求追踪

| 需求 ID | 来源 ID | 验收 ID | 决策 ID |
|---|---|---|---|
| REQ-001 | SRC-001 | AT-001 | DEC-001 |
| REQ-SEC-001 | SRC-001 | AT-SEC-001 | — |

## 5. 未决决策

| 决策 ID | 问题 | Owner |
|---|---|---|
| DEC-001 | 选择持久化策略？ | Owner |
`;

const PROJECT_CONFIG = {
  schemaVersion: 2,
  frameworkVersion: "0.2.0",
  projectId: "spec-task-tests",
  baselinePath: "ai-dev/baseline.json",
  specAdapter: {
    module: "src/spec/structured-markdown.mjs",
    exportName: "compileStructuredMarkdown",
  },
  paths: {
    decisions: "ai-dev/decisions",
    tasks: "ai-dev/tasks",
    reviews: "ai-dev/reviews",
    runs: "ai-dev/runs",
    evidence: "ai-dev/evidence",
    authorizations: "ai-dev/authorizations",
    generated: ".ai-flow/generated",
    cache: ".ai-flow/cache",
    controller: ".ai-flow/controller",
  },
  automationPolicy: {
    maxRepairRounds: 3,
    controlPaths: ["AGENTS.md", "ai-flow.config.json", "ai-dev/impact-map.json", "ai-dev/verifiers/**", "schemas/**", "src/core/**"],
    sensitivePaths: [".env", "credentials/**", "secrets/**"],
    reviewProfile: {
      profileId: "default",
      mandatoryLensIds: ["spec_conformance", "scope", "evidence"],
    },
  },
};

const IMPACT_MAP = {
  schemaVersion: 1,
  mapId: "IMPACT-001",
  baselineId: "BASELINE-001",
  rules: [
    {
      ruleId: "RULE-APP",
      pathPatterns: ["src/app/**"],
      requirementIds: ["REQ-001"],
      acceptanceIds: ["AT-001"],
      verifierIds: ["VERIFY-UNIT"],
    },
  ],
  globalRequirementIds: ["REQ-SEC-001"],
  globalVerifierIds: ["VERIFY-SCOPE"],
};

const DECISIONS = {
  schemaVersion: 1,
  registerId: "DECISIONS-001",
  baselineId: "BASELINE-001",
  status: "pending",
  decisions: [
    {
      decisionId: "DEC-001",
      question: "选择持久化策略？",
      status: "unresolved",
      owner: "Owner",
      options: [
        { optionId: "OPT-001", description: "Use the contract-defined persistence strategy." },
      ],
      dependencies: [],
      blockedStageIds: ["PRODUCT-CODE"],
      relatedRequirementIds: ["REQ-001"],
      relatedAcceptanceIds: ["AT-001"],
      resolutionEvidence: [],
    },
  ],
  stageGates: [
    {
      stageId: "PRODUCT-CODE",
      title: "Product code work",
      status: "blocked",
      blockingDecisionIds: ["DEC-001"],
      evidenceRequired: ["Owner decision evidence"],
      authorizationBoundary: "No implementation before explicit authorization.",
    },
  ],
};

const VERIFIERS = {
  schemaVersion: 1,
  registryId: "VERIFIERS-001",
  globalInvariantVerifierIds: ["VERIFY-SCOPE"],
  verifiers: [
    {
      verifierId: "VERIFY-UNIT",
      tier: "quick",
      command: "node",
      args: ["--test"],
      workingDirectory: ".",
      timeoutMs: 30000,
      evidenceLevel: "contract",
      deterministic: true,
      inputPatterns: ["src/app/**", "tests/**"],
      triggers: {
        requirementIds: ["REQ-001"],
        acceptanceIds: ["AT-001"],
        pathPatterns: ["src/app/**"],
        riskDomains: [],
        alwaysRun: false,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    },
    {
      verifierId: "VERIFY-SCOPE",
      tier: "quick",
      command: "node",
      args: ["tools/scope-check.mjs"],
      workingDirectory: ".",
      timeoutMs: 30000,
      evidenceLevel: "contract",
      deterministic: true,
      inputPatterns: ["src/**"],
      triggers: {
        requirementIds: ["REQ-SEC-001"],
        acceptanceIds: ["AT-SEC-001"],
        pathPatterns: [],
        riskDomains: [],
        alwaysRun: true,
      },
      sideEffect: { kind: "none", requiresApproval: false },
    },
  ],
};

function compileSpec(overrides = {}) {
  return compileStructuredMarkdown({
    text: SPEC,
    baselineId: "BASELINE-001",
    sourceId: "SPEC-001",
    path: "docs/product-spec.md",
    ...overrides,
  });
}

test("standalone specification provenance uses the rolling framework and embedded adapter identity", () => {
  const index = compileSpec();
  const { adapter, frameworkDistribution } = index.provenance;
  assert.equal(frameworkDistribution.version, "1.0.0");
  assert.equal(frameworkDistribution.digest, digestJson({
    frameworkName: frameworkDistribution.name,
    frameworkVersion: frameworkDistribution.version,
    adapter: {
      module: adapter.module,
      exportName: adapter.exportName,
      moduleDigest: adapter.moduleDigest,
    },
  }));
  assert.notEqual(frameworkDistribution.digest, sha256("embedded:ai-development-flow-1.0.0"));
});

async function schema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8"));
}

function compileReadyTask(overrides = {}) {
  const specIndex = compileSpec();
  const baseline = {
    schemaVersion: 1,
    baselineId: "BASELINE-001",
    status: "active",
    createdAt: "2026-08-27T00:00:00Z",
    canonicalSpecSourceId: "SPEC-001",
    truthSources: [{
      sourceId: "SPEC-001",
      path: "docs/product-spec.md",
      role: "product_content_truth",
      authority: "canonical",
      digest: specIndex.spec.digest,
    }],
    knownConflicts: [],
    decisionRegister: "ai-dev/decisions/register.json",
  };
  return compileTask({
    taskId: "TASK-001",
    goal: "实现记录保存",
    baseRevision: "a".repeat(40),
    stageId: "PRODUCT-CODE",
    taskKind: "evidence_collection",
    changedPaths: ["src/app/archive.mjs"],
    directRequirementIds: ["REQ-001"],
    evidenceTargetDecisionIds: ["DEC-001"],
    specIndex,
    baseline,
    impactMap: IMPACT_MAP,
    decisionRegister: DECISIONS,
    verifierRegistry: VERIFIERS,
    projectConfig: PROJECT_CONFIG,
    frameworkLock: { managedFiles: [] },
    ...overrides,
  });
}

function authorizedResolvedDecisions() {
  const register = structuredClone(DECISIONS);
  register.status = "resolved";
  register.stageGates[0].status = "authorized";
  Object.assign(register.decisions[0], {
    status: "resolved",
    selectedOptionId: "OPT-001",
    decidedBy: "Owner",
    resolvedAt: "2026-08-27T10:00:00Z",
    resolutionEvidence: ["owner://decisions/DEC-001"],
  });
  return register;
}

function authorityVerifierRegistry({ includeRuntimeStub = true } = {}) {
  const registry = structuredClone(VERIFIERS);
  const additional = [
    ...(includeRuntimeStub ? [{
      ...structuredClone(VERIFIERS.verifiers[0]),
      verifierId: "VERIFY-RUNTIME-STUB",
      evidenceLevel: "runtime_stub",
      triggers: {
        requirementIds: [],
        acceptanceIds: [],
        pathPatterns: [],
        riskDomains: [],
        alwaysRun: true,
      },
    }] : []),
    {
      ...structuredClone(VERIFIERS.verifiers[0]),
      verifierId: "VERIFY-TARGET",
      evidenceLevel: "target_integration",
      triggers: {
        requirementIds: [],
        acceptanceIds: [],
        pathPatterns: [],
        riskDomains: [],
        alwaysRun: true,
      },
    },
  ];
  registry.verifiers.push(...additional);
  registry.globalInvariantVerifierIds.push(...additional.map((entry) => entry.verifierId));
  return registry;
}

test("structured Markdown compiles to the closed SpecIndex contract", async () => {
  const index = compileSpec();
  assert.equal(index.integrity.status, "pass");
  assert.deepEqual(index.requirements.map((entry) => entry.id), ["REQ-001", "REQ-SEC-001"]);
  assert.deepEqual(index.traceability[0].decisionIds, ["DEC-001"]);
  assert.deepEqual(validateSchema(index, await schema("spec-index")), []);
});

test("line-ending differences produce the same canonical specification digest", () => {
  assert.equal(compileSpec().spec.digest, compileSpec({ text: SPEC.replace(/\n/gu, "\r\n") }).spec.digest);
});

test("compiler reports duplicate IDs, unknown references, placeholders and digest drift", () => {
  const duplicate = compileSpec({
    text: SPEC.replace(
      "**REQ-SEC-001（必须｜security）**",
      "**REQ-001（必须｜security）**",
    ),
    expectedDigest: `sha256:${"0".repeat(64)}`,
  });
  const codes = new Set(duplicate.integrity.errors.map((entry) => entry.code));
  assert.equal(duplicate.integrity.status, "fail");
  assert.equal(codes.has("duplicate_id"), true);
  assert.equal(codes.has("spec_digest_mismatch"), true);

  const unknown = compileSpec({ text: SPEC.replace("SRC-001 | AT-001", "SRC-404 | AT-001") });
  assert.equal(unknown.integrity.errors.some((entry) => entry.code === "unknown_source_reference"), true);

  const placeholder = compileSpec({ text: SPEC.replace("Owner brief", "尚未登记。") });
  assert.equal(placeholder.integrity.errors.some((entry) => entry.code === "spec_not_configured"), true);
});

test("impact analysis adds mapped requirements and global invariants deterministically", () => {
  const impact = analyzeImpact({
    changedPaths: ["src\\APP\\archive.mjs", "SRC/app/archive.mjs"],
    impactMap: IMPACT_MAP,
    baselineId: "BASELINE-001",
  });
  assert.equal(impact.changedPaths.length, 1);
  assert.equal(portablePathKey(impact.changedPaths[0]), "src/app/archive.mjs");
  assert.deepEqual(impact.matchedRuleIds, ["RULE-APP"]);
  assert.deepEqual(impact.impactedRequirementIds, ["REQ-001"]);
  assert.deepEqual(impact.globalInvariantIds, ["REQ-SEC-001"]);
  assert.deepEqual(impact.verifierIds, ["VERIFY-SCOPE", "VERIFY-UNIT"]);
});

test("impact analysis rejects unmapped and unsafe paths", () => {
  assert.throws(
    () => analyzeImpact({ changedPaths: ["src/other.mjs"], impactMap: IMPACT_MAP, baselineId: "BASELINE-001" }),
    (error) => error.code === "unmapped_changed_path",
  );
  for (const unsafePath of ["../escape.mjs", "src/CON/file.mjs", "src/app/file.mjs.", "src/app/file:ads"]) {
    assert.throws(
      () => analyzeImpact({ changedPaths: [unsafePath], impactMap: IMPACT_MAP, baselineId: "BASELINE-001" }),
      (error) => error.code === "unsafe_changed_path",
      unsafePath,
    );
  }
});

test("task compiler separates direct, impacted and global requirements and treats an evidence target as non-blocking", async () => {
  const result = compileReadyTask();
  assert.equal(result.status, "ready");
  assert.deepEqual(result.taskPacket.requirementIds, ["REQ-001", "REQ-SEC-001"]);
  assert.deepEqual(result.taskPacket.derivation.directRequirementIds, ["REQ-001"]);
  assert.deepEqual(result.taskPacket.derivation.impactedRequirementIds, []);
  assert.deepEqual(result.taskPacket.derivation.globalInvariantIds, ["REQ-SEC-001"]);
  assert.deepEqual(result.taskPacket.derivation.blockingDecisionIds, []);
  assert.deepEqual(result.taskPacket.derivation.evidenceTargetDecisionIds, ["DEC-001"]);
  assert.equal(result.taskPacket.stageId, "PRODUCT-CODE");
  assert.equal(result.taskPacket.taskKind, "evidence_collection");
  assert.equal(result.taskPacket.derivation.stageGate.stageId, "PRODUCT-CODE");
  assert.equal(result.taskPacket.derivation.stageGate.title, "Product code work");
  assert.equal(result.taskPacket.derivation.stageGate.status, "blocked");
  assert.deepEqual(result.taskPacket.derivation.stageGate.blockingDecisionIds, ["DEC-001"]);
  assert.match(result.taskPacket.derivation.stageGate.stageGateDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.taskPacket.verification.verifierIds, ["VERIFY-SCOPE", "VERIFY-UNIT"]);
  assert.deepEqual(result.taskPacket.scope.allowedPaths, []);
  assert.deepEqual(result.taskPacket.scope.subjectPaths, ["src/app/archive.mjs"]);
  assert.deepEqual(result.taskPacket.assets.allowedWriteClasses, []);
  assert.equal(result.taskPacket.routing.capability, "fast");
  assert.deepEqual(validateSchema(result.taskPacket, await schema("task-packet")), []);
});

test("implementation requires explicit stage authorization and resolved gate decisions", async () => {
  assert.throws(
    () => compileReadyTask({ baseRevision: "abc1234" }),
    (error) => error.code === "base_revision_invalid",
  );
  assert.throws(
    () => compileReadyTask({ taskKind: "implementation", evidenceTargetDecisionIds: [] }),
    (error) => error.code === "stage_gate_authorization_required",
  );

  const authorizedButUnresolved = structuredClone(DECISIONS);
  authorizedButUnresolved.stageGates[0].status = "authorized";
  assert.throws(
    () => compileReadyTask({
      taskKind: "implementation",
      evidenceTargetDecisionIds: [],
      decisionRegister: authorizedButUnresolved,
    }),
    (error) => error.code === "stage_gate_decision_unresolved",
  );

  const result = compileReadyTask({
    taskKind: "implementation",
    evidenceTargetDecisionIds: [],
    decisionRegister: authorizedResolvedDecisions(),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.taskPacket.decisionDependencies.length, 1);
  assert.deepEqual(result.taskPacket.decisionDependencies[0].evidenceRefs, [
    "owner://decisions/DEC-001",
  ]);
  assert.equal(result.taskPacket.decisionDependencies[0].selectedOptionId, "OPT-001");
  assert.match(result.taskPacket.decisionDependencies[0].decisionDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(validateSchema(result.taskPacket, await schema("task-packet")), []);
});

test("task compiler enforces the asset matrix and a contiguous machine evidence chain", () => {
  const controlMap = {
    ...IMPACT_MAP,
    rules: [{ ...IMPACT_MAP.rules[0], pathPatterns: ["src/core/**"] }],
  };
  assert.throws(
    () => compileReadyTask({
      taskKind: "implementation",
      evidenceTargetDecisionIds: [],
      decisionRegister: authorizedResolvedDecisions(),
      changedPaths: ["src/core/judge.mjs"],
      impactMap: controlMap,
    }),
    (error) => error.code === "asset_write_forbidden"
      && error.details.violations[0].assetClass === "active_control",
  );
  assert.throws(
    () => compileReadyTask({
      requiredEvidenceLevel: "owner",
      verifierRegistry: authorityVerifierRegistry({ includeRuntimeStub: false }),
    }),
    (error) => error.code === "EVIDENCE_CHAIN_UNREACHABLE"
      && error.details.missingEvidenceLevels.includes("runtime_stub"),
  );
  const sensitiveRegistry = structuredClone(VERIFIERS);
  sensitiveRegistry.verifiers[0].inputPatterns = ["secrets/**"];
  assert.throws(
    () => compileReadyTask({ verifierRegistry: sensitiveRegistry }),
    (error) => error.code === "sensitive_verifier_input_forbidden"
      && error.details.inputs[0].inputPattern === "secrets/**",
  );
});

test("Owner and production tasks compile with a complete machine chain and explicit authority requirements", async () => {
  const common = {
    taskKind: "implementation",
    evidenceTargetDecisionIds: [],
    decisionRegister: authorizedResolvedDecisions(),
    verifierRegistry: authorityVerifierRegistry(),
  };
  const owner = compileReadyTask({ ...common, requiredEvidenceLevel: "owner" });
  assert.equal(owner.status, "ready");
  assert.deepEqual(owner.taskPacket.verification.requiredAuthorityKinds, ["owner_acceptance"]);
  assert.deepEqual(validateSchema(owner.taskPacket, await schema("task-packet")), []);

  const production = compileReadyTask({ ...common, requiredEvidenceLevel: "production" });
  assert.equal(production.status, "ready");
  assert.deepEqual(production.taskPacket.verification.requiredAuthorityKinds, [
    "owner_acceptance",
    "production_release",
  ]);
  assert.deepEqual(validateSchema(production.taskPacket, await schema("task-packet")), []);
});

test("evidence collection is bounded to matching gate decisions and pre-authorization states", () => {
  for (const status of ["pending", "blocked", "ready"]) {
    const register = structuredClone(DECISIONS);
    register.stageGates[0].status = status;
    const result = compileReadyTask({ decisionRegister: register });
    assert.equal(result.status, "ready", status);
    assert.equal(result.taskPacket.derivation.stageGate.status, status);
  }

  const authorized = structuredClone(DECISIONS);
  authorized.stageGates[0].status = "authorized";
  assert.throws(
    () => compileReadyTask({ decisionRegister: authorized }),
    (error) => error.code === "stage_gate_evidence_collection_forbidden",
  );

  const forbidden = structuredClone(DECISIONS);
  forbidden.stageGates[0].status = "not_authorized";
  assert.throws(
    () => compileReadyTask({ decisionRegister: forbidden }),
    (error) => error.code === "stage_gate_not_authorized",
  );

  assert.throws(
    () => compileReadyTask({ evidenceTargetDecisionIds: [] }),
    (error) => error.code === "evidence_target_required",
  );

  const mismatched = structuredClone(DECISIONS);
  mismatched.stageGates[0].blockingDecisionIds = [];
  assert.throws(
    () => compileReadyTask({ decisionRegister: mismatched }),
    (error) => error.code === "evidence_target_stage_mismatch",
  );

  assert.throws(
    () => compileReadyTask({ stageId: "UNKNOWN-STAGE" }),
    (error) => error.code === "stage_gate_unknown",
  );
});

test("control-plane tasks only propose Active Control and carry no inline authorization", () => {
  const decisionRegister = authorizedResolvedDecisions();
  const controlMap = {
    ...IMPACT_MAP,
    rules: [{ ...IMPACT_MAP.rules[0], pathPatterns: ["schemas/**"] }],
  };
  const baseOverrides = {
    taskKind: "control_plane",
    evidenceTargetDecisionIds: [],
    decisionRegister,
    requiredEvidenceLevel: "owner",
    verifierRegistry: authorityVerifierRegistry(),
    changedPaths: ["schemas/task-packet.schema.json"],
    impactMap: controlMap,
  };
  const result = compileReadyTask(baseOverrides);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.taskPacket.assets.allowedWriteClasses, ["active_control"]);
  assert.equal("controlPlaneAuthorizationRef" in result.taskPacket, false);

  assert.throws(
    () => compileReadyTask({
      ...baseOverrides,
      changedPaths: ["src/app/archive.mjs"],
      impactMap: IMPACT_MAP,
    }),
    (error) => error.code === "asset_write_forbidden"
      && error.details.violations[0].assetClass === "managed_implementation",
  );
});

test("framework documentation-only impact selects contract evidence", async () => {
  const frameworkImpactMap = JSON.parse(await readFile(
    new URL("../ai-dev/impact-map.json", import.meta.url),
    "utf8",
  ));
  const documentation = analyzeImpact({
    changedPaths: ["docs/usage.md"],
    impactMap: frameworkImpactMap,
    baselineId: frameworkImpactMap.baselineId,
  });
  assert.deepEqual(documentation.matchedRuleIds, ["FRAMEWORK-DOCUMENTATION"]);
  assert.deepEqual(documentation.verifierIds, ["VERIFY-FRAMEWORK-CONTRACT"]);

  const mixed = analyzeImpact({
    changedPaths: ["docs/usage.md", "src/cli/main.mjs"],
    impactMap: frameworkImpactMap,
    baselineId: frameworkImpactMap.baselineId,
  });
  assert.deepEqual(mixed.verifierIds, [
    "VERIFY-FRAMEWORK-CONTRACT",
    "VERIFY-FRAMEWORK-RUNTIME",
    "VERIFY-FRAMEWORK-TARGET",
  ]);
});

test("framework-managed writes require a reachable control-plane task with a lock update", () => {
  const distributionBoundSpec = compileSpec();
  distributionBoundSpec.provenance = {
    baseRevision: "a".repeat(40),
    frameworkDistribution: { digest: "sha256:distribution" },
  };
  assert.throws(
    () => compileReadyTask({ specIndex: distributionBoundSpec, frameworkLock: null }),
    (error) => error.code === "framework_lock_invalid",
  );

  assert.throws(
    () => compileReadyTask({
      taskKind: "implementation",
      evidenceTargetDecisionIds: [],
      decisionRegister: authorizedResolvedDecisions(),
      frameworkLock: { managedFiles: [{ path: "src/app/archive.mjs" }] },
    }),
    (error) => error.code === "managed_file_requires_control_plane"
      && error.details.paths.includes("src/app/archive.mjs"),
  );

  const controlMap = {
    ...IMPACT_MAP,
    rules: [{ ...IMPACT_MAP.rules[0], pathPatterns: ["schemas/**"] }],
  };
  const common = {
    taskKind: "control_plane",
    evidenceTargetDecisionIds: [],
    decisionRegister: authorizedResolvedDecisions(),
    requiredEvidenceLevel: "owner",
    verifierRegistry: authorityVerifierRegistry(),
    impactMap: controlMap,
    frameworkLock: { managedFiles: [{ path: "schemas/task-packet.schema.json" }] },
  };
  assert.throws(
    () => compileReadyTask({
      ...common,
      changedPaths: ["schemas/task-packet.schema.json"],
    }),
    (error) => error.code === "managed_lock_update_required"
      && error.details.paths.includes("schemas/task-packet.schema.json"),
  );

  const reachable = compileReadyTask({
    ...common,
    changedPaths: ["schemas/task-packet.schema.json", "ai-dev/framework-lock.json"],
    projectConfig: {
      ...PROJECT_CONFIG,
      automationPolicy: {
        ...PROJECT_CONFIG.automationPolicy,
        controlPaths: [...PROJECT_CONFIG.automationPolicy.controlPaths, "ai-dev/framework-lock.json"],
      },
    },
  });
  assert.equal(reachable.status, "ready");
  assert.deepEqual(reachable.taskPacket.scope.allowedPaths, [
    "ai-dev/framework-lock.json",
    "schemas/task-packet.schema.json",
  ]);
});

test("routing is raised deterministically for high-risk and approval-bearing work", () => {
  const highRisk = compileReadyTask({ risk: { level: "high", domains: ["security"] }, routingCapability: "fast" });
  assert.equal(highRisk.taskPacket.routing.capability, "high_reasoning");

  const declared = compileReadyTask({
    risk: {
      level: "low",
      domains: ["external"],
      sideEffects: [{ kind: "external_service", requiresApproval: true }],
    },
  });
  assert.equal(declared.taskPacket.routing.capability, "human");
  assert.deepEqual(declared.taskPacket.risk.sideEffects, [
    { kind: "external_service", requiresApproval: true },
  ]);

  const physicalRegistry = structuredClone(VERIFIERS);
  physicalRegistry.verifiers[0].sideEffect = { kind: "physical", requiresApproval: true };
  const physical = compileReadyTask({ verifierRegistry: physicalRegistry });
  assert.equal(physical.taskPacket.routing.capability, "human");
  assert.deepEqual(physical.taskPacket.risk.sideEffects, [{ kind: "physical", requiresApproval: true }]);

  assert.throws(
    () => compileReadyTask({ risk: { level: "low", domains: ["external"], sideEffects: [{ kind: "network" }] } }),
    (error) => error.code === "risk_side_effect_invalid",
  );
});

test("minimal context includes only selected spec lines, related decisions and relevant contracts", async () => {
  const { taskPacket } = compileReadyTask();
  const specIndex = compileSpec();
  const subjectContentDigest = sha256("subject-content");
  const manifest = buildContextManifest({
    taskPacket,
    specIndex,
    subjectRevision: "abc1234",
    subjectContentDigest,
    createdAt: "2026-08-27T12:00:00Z",
    decisionSource: { path: "ai-dev/decisions/register.json", digest: sha256("decisions") },
    contracts: [
      { path: "contracts/archive.json", digest: sha256("archive"), requirementIds: ["REQ-001"] },
      { path: "contracts/unrelated.json", digest: sha256("unrelated"), requirementIds: ["REQ-OTHER"] },
    ],
    exclusions: [{ path: "docs/background.md", reason: "not needed for this task" }],
  });
  assert.equal(manifest.stageId, "PRODUCT-CODE");
  assert.equal(manifest.taskKind, "evidence_collection");
  assert.deepEqual(manifest.stageGate, {
    status: "blocked",
    authorizationBoundary: "No implementation before explicit authorization.",
    evidenceRequired: ["Owner decision evidence"],
  });
  assert.equal(manifest.items.some((entry) => entry.path === "contracts/archive.json"), true);
  assert.equal(manifest.items.some((entry) => entry.path === "contracts/unrelated.json"), false);
  assert.equal(manifest.items.every((entry) => ["spec_excerpt", "decision", "contract"].includes(entry.kind)), true);
  for (const requirementId of taskPacket.requirementIds) {
    const requirement = specIndex.requirements.find((entry) => entry.id === requirementId);
    const item = manifest.items.find((entry) => entry.reason.startsWith(`selected requirement ${requirementId}:`));
    assert.equal(item.reason.includes(requirement.statement), true);
    if (requirement.acceptance) assert.equal(item.reason.includes(requirement.acceptance), true);
  }
  for (const acceptanceId of taskPacket.acceptanceIds) {
    const acceptance = specIndex.acceptanceCases.find((entry) => entry.id === acceptanceId);
    const item = manifest.items.find((entry) => entry.reason.startsWith(`selected acceptance ${acceptanceId}:`));
    assert.equal(item.reason.includes(acceptance.title), true);
    assert.equal(acceptance.criteria.every((criterion) => item.reason.includes(criterion)), true);
  }
  assert.deepEqual(validateSchema(manifest, await schema("context-manifest")), []);

  const repeated = buildContextManifest({
    taskPacket,
    specIndex: compileSpec(),
    subjectRevision: "abc1234",
    subjectContentDigest,
    createdAt: "2026-08-27T12:00:00Z",
    decisionSource: { path: "ai-dev/decisions/register.json", digest: sha256("decisions") },
    contracts: [{ path: "contracts/archive.json", digest: sha256("archive"), requirementIds: ["REQ-001"] }],
    exclusions: [{ path: "docs/background.md", reason: "not needed for this task" }],
  });
  assert.equal(manifest.manifestDigest, repeated.manifestDigest);
});

test("context manifest rejects SpecIndex content outside the TaskPacket binding", () => {
  const { taskPacket } = compileReadyTask();
  const specIndex = compileSpec();
  specIndex.requirements.find((entry) => entry.id === "REQ-001").statement = "altered unbound statement";

  assert.throws(
    () => buildContextManifest({
      taskPacket,
      specIndex,
      subjectRevision: "abc1234",
      subjectContentDigest: sha256("subject-content"),
      createdAt: "2026-08-27T12:00:00Z",
      decisionSource: { path: "ai-dev/decisions/register.json", digest: sha256("decisions") },
    }),
    (error) => error.code === "context_spec_index_mismatch",
  );
});

test("context manifest preserves distinct selected spec entries without source lines", () => {
  const { taskPacket } = compileReadyTask();
  const specIndex = compileSpec();
  for (const entry of [...specIndex.requirements, ...specIndex.acceptanceCases]) delete entry.line;
  const boundTaskPacket = {
    ...taskPacket,
    specIndexDigest: sha256(stableStringify(specIndex)),
  };

  const manifest = buildContextManifest({
    taskPacket: boundTaskPacket,
    specIndex,
    subjectRevision: "abc1234",
    subjectContentDigest: sha256("subject-content"),
    createdAt: "2026-08-27T12:00:00Z",
    decisionSource: { path: "ai-dev/decisions/register.json", digest: sha256("decisions") },
  });

  for (const requirementId of taskPacket.requirementIds) {
    assert.equal(manifest.items.some((entry) => entry.reason.startsWith(`selected requirement ${requirementId}:`)), true);
  }
  for (const acceptanceId of taskPacket.acceptanceIds) {
    assert.equal(manifest.items.some((entry) => entry.reason.startsWith(`selected acceptance ${acceptanceId}:`)), true);
  }
  assert.equal(
    manifest.items.filter((entry) => entry.kind === "spec_excerpt").length,
    taskPacket.requirementIds.length + taskPacket.acceptanceIds.length,
  );
});

test("context manifest requires an explicit subject content digest", () => {
  const { taskPacket } = compileReadyTask();
  assert.throws(
    () => buildContextManifest({
      taskPacket,
      specIndex: compileSpec(),
      subjectRevision: "abc1234",
      createdAt: "2026-08-27T12:00:00Z",
      decisionSource: { path: "ai-dev/decisions/register.json", digest: sha256("decisions") },
    }),
    (error) => error.code === "context_input_invalid" && error.message.includes("subjectContentDigest"),
  );
});

test("context manifest rejects exclusion of required context", () => {
  const { taskPacket } = compileReadyTask();
  assert.throws(
    () => buildContextManifest({
      taskPacket,
      specIndex: compileSpec(),
      subjectRevision: "abc1234",
      subjectContentDigest: sha256("subject-content"),
      createdAt: "2026-08-27T12:00:00Z",
      decisionSource: { path: "ai-dev/decisions/register.json", digest: sha256("decisions") },
      exclusions: [{ path: "docs/product-spec.md", reason: "incorrect exclusion" }],
    }),
    (error) => error.code === "context_selection_conflict",
  );
});
