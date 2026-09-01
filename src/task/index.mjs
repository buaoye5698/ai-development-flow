export { TaskCompilationError } from "./errors.mjs";
export {
  analyzeImpact,
  normalizeChangedPath,
  normalizeScopePattern,
  pathMatchesPattern,
  scopePatternsOverlap,
} from "./impact-analysis.mjs";
export {
  compileTask,
  requiredAuthorityKindsForEvidenceLevel,
  requiredMachineEvidenceLevelsForEvidenceLevel,
  snapshotDecisionDependency,
  snapshotStageGate,
  validateTaskAuthorizationSnapshot,
} from "./task-compiler.mjs";
export { buildContextManifest } from "./context-manifest.mjs";
export { renderContextBrief } from "./context-renderer.mjs";
