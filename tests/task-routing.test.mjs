import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTaskMode } from "../src/cli/task-routing.mjs";

function quickTask(overrides = {}) {
  const task = {
    taskKind: "implementation",
    decisionDependencies: [],
    derivation: {
      blockingDecisionIds: [],
      stageGate: { status: "authorized" },
    },
    scope: {
      allowedPaths: ["src/app.mjs"],
    },
    assets: {
      allowedWriteClasses: ["managed_implementation"],
      classifiedWrites: [{ path: "src/app.mjs", assetClass: "managed_implementation" }],
    },
    capabilities: [
      { capabilityId: "repository_read" },
      { capabilityId: "repository_write" },
    ],
    verification: {
      tier: "quick",
      requiredEvidenceLevel: "contract",
      requiredAuthorityKinds: [],
    },
    risk: {
      level: "low",
      domains: ["logic"],
      sideEffects: [],
    },
  };
  return {
    ...task,
    ...overrides,
    derivation: { ...task.derivation, ...(overrides.derivation ?? {}) },
    scope: { ...task.scope, ...(overrides.scope ?? {}) },
    assets: { ...task.assets, ...(overrides.assets ?? {}) },
    verification: { ...task.verification, ...(overrides.verification ?? {}) },
    risk: { ...task.risk, ...(overrides.risk ?? {}) },
  };
}

test("auto routes a bounded local implementation to quick mode", () => {
  assert.deepEqual(evaluateTaskMode({ requestedMode: "auto", taskPacket: quickTask() }), {
    requestedMode: "auto",
    selectedMode: "quick",
    quickEligible: true,
    fallbackFromQuick: false,
    reasons: [],
  });
});

test("an explicit full preference keeps an otherwise eligible task on the full flow", () => {
  const route = evaluateTaskMode({ requestedMode: "full", taskPacket: quickTask() });
  assert.equal(route.selectedMode, "full");
  assert.equal(route.quickEligible, true);
  assert.deepEqual(route.reasons.map((entry) => entry.code), ["FULL_MODE_REQUESTED"]);
});

test("quick preference falls back to full when any safety dimension is ineligible", () => {
  const route = evaluateTaskMode({
    requestedMode: "quick",
    taskPacket: quickTask({
      taskKind: "control_plane",
      decisionDependencies: [{ decisionId: "DEC-001", status: "unresolved" }],
      derivation: {
        blockingDecisionIds: ["DEC-001"],
        stageGate: { status: "blocked" },
      },
      scope: { allowedPaths: [] },
      assets: {
        allowedWriteClasses: ["active_control"],
        classifiedWrites: [{ path: "schemas/task.json", assetClass: "active_control" }],
      },
      capabilities: [
        { capabilityId: "repository_read" },
        { capabilityId: "network_write" },
      ],
      verification: {
        tier: "deep",
        requiredEvidenceLevel: "owner",
        requiredAuthorityKinds: ["owner_acceptance"],
      },
      risk: {
        level: "high",
        sideEffects: [{ kind: "external_service", requiresApproval: true }],
      },
    }),
  });
  assert.equal(route.selectedMode, "full");
  assert.equal(route.quickEligible, false);
  assert.equal(route.fallbackFromQuick, true);
  assert.deepEqual(new Set(route.reasons.map((entry) => entry.code)), new Set([
    "QUICK_TASK_KIND_UNSUPPORTED",
    "QUICK_ASSET_CLASS_UNSUPPORTED",
    "QUICK_SCOPE_EMPTY",
    "QUICK_STAGE_NOT_AUTHORIZED",
    "QUICK_DECISION_UNRESOLVED",
    "QUICK_RISK_UNSUPPORTED",
    "QUICK_SIDE_EFFECT_UNSUPPORTED",
    "QUICK_VERIFICATION_TIER_UNSUPPORTED",
    "QUICK_EVIDENCE_LEVEL_UNSUPPORTED",
    "QUICK_AUTHORITY_UNSUPPORTED",
    "QUICK_CAPABILITY_UNSUPPORTED",
  ]));
});

test("task-mode routing rejects unknown modes and missing task packets before selection", () => {
  assert.throws(
    () => evaluateTaskMode({ requestedMode: "turbo", taskPacket: quickTask() }),
    /unsupported task mode/u,
  );
  assert.throws(
    () => evaluateTaskMode({ requestedMode: "auto", taskPacket: null }),
    /taskPacket is required/u,
  );
});
