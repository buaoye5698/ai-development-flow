{
  "schemaVersion": 2,
  "frameworkVersion": __FRAMEWORK_VERSION_JSON__,
  "projectId": __PROJECT_ID_JSON__,
  "baselinePath": "ai-dev/baseline.json",
  "specAdapter": {
    "module": "tools/ai-flow/src/spec/structured-markdown.mjs",
    "exportName": "compileStructuredMarkdown"
  },
  "paths": {
    "decisions": "ai-dev/decisions",
    "tasks": "ai-dev/tasks",
    "reviews": "ai-dev/reviews",
    "runs": "ai-dev/runs",
    "evidence": "ai-dev/evidence",
    "authorizations": "ai-dev/authorizations",
    "generated": ".ai-flow/generated",
    "cache": ".ai-flow/cache",
    "controller": ".ai-flow/controller"
  },
  "automationPolicy": {
    "maxRepairRounds": 3,
    "stopAfterSameFindingFingerprint": 2,
    "freshReviewContextRequired": true,
    "implementerCannotReviewOwnTask": true,
    "repairWithinTaskAllowedPathsOnly": true,
    "maxParallelVerifiers": 3,
    "controlPaths": [
      "AGENTS.md",
      "ai-flow.config.json",
      "ai-dev/framework-lock.json",
      "ai-dev/impact-map.json",
      "ai-dev/verifiers/**",
      "ai-dev/schemas/**",
      "tools/ai-flow/**"
    ],
    "sensitivePaths": [
      ".env",
      ".env.local",
      "credentials/**",
      "secrets/**"
    ],
    "reviewProfile": {
      "profileId": "default",
      "mandatoryLensIds": [
        "spec_conformance",
        "scope",
        "evidence"
      ]
    },
    "stopConditions": [
      "unresolved_decision",
      "truth_source_conflict",
      "same_finding_repeated",
      "repair_oscillation",
      "scope_expansion",
      "side_effect_requires_approval",
      "repair_round_limit"
    ]
  },
  "evidencePolicy": {
    "levels": [
      "specification",
      "contract",
      "runtime_stub",
      "target_integration",
      "owner",
      "production"
    ],
    "preventElevation": true
  }
}
