import { digestJson } from "../core/canonical.mjs";
import { validateSchema } from "../core/schema-validator.mjs";
import {
  digestDeclaredInputs,
  environmentFingerprint,
  readVerificationCache,
  verificationCacheKey,
  writeVerificationCache,
} from "./cache.mjs";
import { mapWithConcurrency, runProcess } from "./process-runner.mjs";
import { resolveSafeDirectory } from "./safe-path.mjs";
import { frameworkProcessArtifactPrefixes, readProjectSchemaAtRevision } from "./git-scope.mjs";

function verifierEnvironment(environmentKeys = []) {
  const baseKeys = process.platform === "win32"
    ? ["Path", "PATH", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  const sourceKeys = Object.keys(process.env);
  const result = {};
  for (const requested of [...baseKeys, ...environmentKeys]) {
    const actual = process.platform === "win32"
      ? sourceKeys.find((key) => key.toLowerCase() === requested.toLowerCase())
      : requested;
    if (actual && Object.hasOwn(process.env, actual)) result[actual] = process.env[actual];
  }
  return result;
}

function resultStatus(processResult) {
  if (processResult.timedOut) return "timeout";
  if (processResult.outputExceeded || processResult.error || processResult.aborted) return "error";
  return processResult.exitCode === 0 ? "pass" : "fail";
}

function resultSummary(verifierId, status, processResult) {
  if (status === "pass") return `${verifierId} passed`;
  if (status === "partial") return `${verifierId} passed, but the required deep tier was not executed`;
  if (status === "timeout") return `${verifierId} timed out after its registered limit`;
  if (processResult.outputExceeded) return `${verifierId} exceeded the output limit`;
  if (processResult.error) return `${verifierId} could not be started`;
  return `${verifierId} failed with exit code ${processResult.exitCode}`;
}

function tierCovers(requiredTier, executedTier) {
  return requiredTier === "quick" || executedTier === "deep";
}

function attachResultDigest(result) {
  const { resultDigest: ignored, ...unsigned } = result;
  return { ...unsigned, resultDigest: digestJson(unsigned) };
}

function assertResult(result, resultSchema) {
  const validationErrors = validateSchema(result, resultSchema);
  if (validationErrors.length > 0) {
    const error = new Error("verification result does not satisfy its schema");
    error.code = "VERIFICATION_RESULT_INVALID";
    error.errors = validationErrors;
    throw error;
  }
  return result;
}

async function executeOne({
  projectRoot,
  plan,
  verifier,
  resultSchema,
  baselineDigest,
  subjectRevision,
  worktreeDigest,
  subjectContentDigest,
  controlDigest,
  expectedTaskDigest,
  taskId,
  signal,
}) {
  const { authorization, ...definition } = verifier;
  const definitionDigest = digestJson(definition);
  const declaredInputs = await digestDeclaredInputs({
    projectRoot,
    verifier,
    excludedPaths: frameworkProcessArtifactPrefixes(plan.config),
  });
  const environment = verifierEnvironment(verifier.environmentKeys);
  const environmentDigest = environmentFingerprint(environment);
  const cacheKey = verificationCacheKey({
    baselineDigest,
    definitionDigest,
    declaredInputDigest: declaredInputs.digest,
    environmentDigest,
  });
  const cacheable = verifier.sideEffect.kind === "none";
  if (cacheable) {
    const cached = await readVerificationCache({
      projectRoot,
      config: plan.config,
      cacheKey,
      resultSchema,
    });
    if (cached) {
      return assertResult(attachResultDigest({
        ...cached,
        taskId,
        subjectRevision,
        worktreeDigest,
        subjectContentDigest,
        controlDigest,
        taskPacketDigest: expectedTaskDigest,
        expectedTaskDigest,
        requiredTier: plan.requiredTier,
        executedTier: plan.executedTier,
        complete: tierCovers(plan.requiredTier, plan.executedTier),
        status: tierCovers(plan.requiredTier, plan.executedTier) ? cached.status : "partial",
        cacheHit: true,
      }), resultSchema);
    }
  }

  const workingDirectory = await resolveSafeDirectory(projectRoot, verifier.workingDirectory);
  const startedAt = new Date().toISOString();
  const processResult = await runProcess({
    command: verifier.command,
    args: verifier.args,
    cwd: workingDirectory,
    timeoutMs: verifier.timeoutMs,
    env: environment,
    signal,
  });
  const completedAt = new Date().toISOString();
  const processStatus = resultStatus(processResult);
  const tierComplete = tierCovers(plan.requiredTier, plan.executedTier);
  const status = !tierComplete && processStatus === "pass" ? "partial" : processStatus;
  const outputDigest = digestJson({
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    status,
  });
  const result = {
    schemaVersion: 2,
    resultId: `VR:${cacheKey.slice("sha256:".length, "sha256:".length + 24)}`,
    verifierId: verifier.verifierId,
    taskId,
    baselineId: plan.baseline.baselineId,
    specDigest: plan.specDigest,
    subjectRevision,
    taskPacketDigest: expectedTaskDigest,
    controlDigest,
    subjectContentDigest,
    expectedTaskDigest,
    worktreeDigest,
    complete: tierComplete,
    requiredTier: plan.requiredTier,
    executedTier: plan.executedTier,
    definitionDigest,
    inputDigest: declaredInputs.digest,
    startedAt,
    completedAt,
    durationMs: processResult.durationMs,
    status,
    exitCode: processResult.timedOut || processResult.aborted
      ? null
      : Number.isInteger(processResult.exitCode) ? processResult.exitCode : null,
    cacheHit: false,
    evidenceLevel: verifier.evidenceLevel,
    outputDigest,
    summary: resultSummary(verifier.verifierId, status, processResult),
    artifactRefs: [],
    sideEffect: {
      occurred: verifier.sideEffect.kind !== "none" && !processResult.error,
      authorized: authorization.authorized,
      ...(authorization.authorizationRef ? { authorizationRef: authorization.authorizationRef } : {}),
    },
  };
  const signedResult = assertResult(attachResultDigest(result), resultSchema);
  if (cacheable && status === "pass" && tierComplete) {
    await writeVerificationCache({
      projectRoot,
      config: plan.config,
      cacheKey,
      result: signedResult,
    });
  }
  return signedResult;
}

export async function executeVerificationPlan({
  projectRoot,
  plan,
  subjectRevision,
  worktreeDigest,
  subjectContentDigest,
  controlDigest,
  expectedTaskDigest,
}) {
  const resultSchema = (await readProjectSchemaAtRevision(
    projectRoot,
    plan.activeControlRevision,
    "verification-result",
  )).value;
  const baselineDigest = digestJson(plan.baseline);
  const taskId = plan.task?.taskId ?? "PROJECT-VERIFY";
  const concurrency = Math.min(
    plan.config.automationPolicy.maxParallelVerifiers,
    Math.max(1, plan.selected.length),
  );
  const results = await mapWithConcurrency(plan.selected, concurrency, (verifier, _index, signal) =>
    executeOne({
      projectRoot,
      plan,
      verifier,
      resultSchema,
      baselineDigest,
      subjectRevision,
      worktreeDigest,
      subjectContentDigest,
      controlDigest,
      expectedTaskDigest,
      taskId,
      signal,
    }),
  );
  const failed = results.filter((result) => !["pass", "partial"].includes(result.status));
  const complete = tierCovers(plan.requiredTier, plan.executedTier);
  return {
    status: failed.length > 0 ? "fail" : complete ? "pass" : "partial",
    complete,
    requiredTier: plan.requiredTier,
    executedTier: plan.executedTier,
    baselineDigest,
    taskId,
    subjectRevision,
    worktreeDigest,
    subjectContentDigest,
    controlDigest,
    taskPacketDigest: expectedTaskDigest,
    expectedTaskDigest,
    concurrency,
    cacheHits: results.filter((result) => result.cacheHit).length,
    results,
  };
}
