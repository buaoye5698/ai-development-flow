import { digestJson } from "../core/index.mjs";

function lineList(values, empty = "none") {
  return values?.length ? values.join(", ") : empty;
}

function bulletList(values) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
}

function renderAgent(task, context) {
  const items = (context.items ?? []).map((entry) =>
    `- ${entry.kind}: ${entry.path} (${entry.digest}) — ${entry.reason}`).join("\n");
  const exclusions = (context.exclusions ?? []).map((entry) => `- ${entry.path} — ${entry.reason}`).join("\n");
  return `# Agent Brief: ${task.taskId}

Goal: ${task.goal}
Task kind: ${task.taskKind}
Base commit: ${task.baseRevision}
TaskPacket digest: ${context.taskPacketDigest}
Active control digest: ${context.controlDigest}
Subject content digest: ${context.subjectContentDigest}

## Requirements and acceptance

Requirements: ${lineList(task.requirementIds)}
Acceptance: ${lineList(task.acceptanceIds)}

## Task constraints

${bulletList(task.constraints)}

## Write boundary

Allowed paths: ${lineList(task.scope.allowedPaths)}
Subject paths: ${lineList(task.scope.subjectPaths)}
Allowed asset classes: ${lineList(task.assets.allowedWriteClasses)}
Forbidden paths: ${lineList(task.scope.forbiddenPaths)}

## Verification and review

Verifiers: ${lineList(task.verification.verifierIds)}
Evidence target: ${task.verification.requiredEvidenceLevel}
Mandatory review lenses: ${lineList(task.review.mandatoryLensIds)}
Required review lenses: ${lineList(task.review.requestedLensIds)}
Declared capabilities: ${lineList(task.capabilities.map((entry) => entry.capabilityId))}

## Context references

${items || "- none"}

## Exclusions

${exclusions || "- none"}
`;
}

function renderHuman(task, context) {
  return `# Human Brief: ${task.taskId}

Goal: ${task.goal}
Kind: ${task.taskKind}
Scope: ${lineList(task.scope.allowedPaths, "read-only evidence collection")}
Risk: ${task.risk.level} (${lineList(task.risk.domains)})
Verification: ${lineList(task.verification.verifierIds)}
Review: ${lineList(task.review.requestedLensIds)}
Base: ${task.baseRevision}
Content: ${context.subjectContentDigest}
`;
}

export function renderContextBrief({ taskPacket, contextManifest, audience }) {
  if (!new Set(["agent", "human"]).has(audience)) throw new TypeError("audience must be agent or human");
  if (contextManifest.taskPacketDigest !== digestJson(taskPacket)) {
    const error = new Error("context manifest is not bound to the supplied TaskPacket");
    error.code = "CONTEXT_TASK_BINDING_MISMATCH";
    throw error;
  }
  const content = audience === "agent"
    ? renderAgent(taskPacket, contextManifest)
    : renderHuman(taskPacket, contextManifest);
  return { audience, content, briefDigest: digestJson({ audience, content }) };
}
