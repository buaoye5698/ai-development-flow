function millis(value, name) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid timestamp`);
  return parsed;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function deriveRunMetrics(runRecord, { verificationResults = [] } = {}) {
  const started = millis(runRecord.startedAt, "runRecord.startedAt");
  const updated = millis(runRecord.updatedAt, "runRecord.updatedAt");
  if (updated < started) throw new RangeError("runRecord.updatedAt cannot precede startedAt");
  const transitions = runRecord.stateTransitions ?? [];
  const stateDurationsMs = {};
  let cursor = started;
  for (const transition of transitions) {
    const at = millis(transition.at, "stateTransitions[].at");
    if (at < cursor) throw new RangeError("state transitions must be chronological");
    stateDurationsMs[transition.from] = (stateDurationsMs[transition.from] ?? 0) + (at - cursor);
    cursor = at;
  }
  stateDurationsMs[runRecord.state] = (stateDurationsMs[runRecord.state] ?? 0) + (updated - cursor);

  const cacheHits = verificationResults.filter((entry) => entry.cacheHit === true).length;
  const cacheMisses = verificationResults.filter((entry) => entry.cacheHit !== true).length;
  const humanInterventions = runRecord.humanInterventions ?? [];
  return {
    runId: runRecord.runId,
    taskId: runRecord.taskId,
    finalState: runRecord.state,
    acceptedEvidenceLevel: runRecord.result?.acceptedEvidenceLevel ?? null,
    durationMs: updated - started,
    timeToGreenMs: runRecord.state === "accepted" ? updated - started : null,
    verificationDurationMs: verificationResults.reduce((total, entry) => total + (entry.durationMs ?? 0), 0),
    repairRounds: (runRecord.repairHistory ?? []).length,
    cacheHits,
    cacheMisses,
    cacheHitRate: cacheHits + cacheMisses === 0 ? null : cacheHits / (cacheHits + cacheMisses),
    humanInterventionCount: humanInterventions.length,
    humanApprovalCount: humanInterventions.filter((entry) => ["approved", "resolved"].includes(entry.status)).length,
    escalated: runRecord.state === "escalated",
    stateDurationsMs
  };
}

export function attachDerivedMetrics(runRecord, options) {
  const derived = deriveRunMetrics(runRecord, options);
  return {
    ...structuredClone(runRecord),
    metrics: {
      durationMs: derived.durationMs,
      verificationDurationMs: derived.verificationDurationMs,
      repairRounds: derived.repairRounds,
      cacheHits: derived.cacheHits,
      cacheMisses: derived.cacheMisses,
      humanInterventionCount: derived.humanInterventionCount
    }
  };
}

export function aggregateRunMetrics(metrics) {
  const entries = metrics ?? [];
  const accepted = entries.filter((entry) => entry.finalState === "accepted");
  const totalCacheHits = entries.reduce((total, entry) => total + entry.cacheHits, 0);
  const totalCacheMisses = entries.reduce((total, entry) => total + entry.cacheMisses, 0);
  return {
    runCount: entries.length,
    acceptedCount: accepted.length,
    escalatedCount: entries.filter((entry) => entry.escalated).length,
    acceptanceRate: entries.length === 0 ? null : accepted.length / entries.length,
    medianDurationMs: median(entries.map((entry) => entry.durationMs)),
    medianTimeToGreenMs: median(accepted.map((entry) => entry.timeToGreenMs)),
    averageRepairRounds: entries.length === 0
      ? null
      : entries.reduce((total, entry) => total + entry.repairRounds, 0) / entries.length,
    cacheHitRate: totalCacheHits + totalCacheMisses === 0
      ? null
      : totalCacheHits / (totalCacheHits + totalCacheMisses),
    humanInterventionRate: entries.length === 0
      ? null
      : entries.filter((entry) => entry.humanInterventionCount > 0).length / entries.length
  };
}
