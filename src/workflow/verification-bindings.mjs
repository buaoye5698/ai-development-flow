import { computeVerificationResultDigest, digestJson } from "../core/index.mjs";
import { workflowError } from "./errors.mjs";

function reason(code, message, details = {}) {
  return { code, message, ...details };
}

function bindingKey(value) {
  return `${value?.resultId ?? ""}\u0000${value?.resultDigest ?? ""}`;
}

export function normalizeReferencedVerificationResults(entries = []) {
  const normalized = [];
  const refs = new Set();
  const ids = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const wrapper = entries[index];
    if (!wrapper || typeof wrapper !== "object" || typeof wrapper.reference !== "string" || wrapper.reference.length === 0) {
      workflowError("verification_reference_invalid", `verificationResults[${index}].reference is required`);
    }
    if (!wrapper.result || typeof wrapper.result !== "object" || Array.isArray(wrapper.result)) {
      workflowError("verification_result_invalid", `verificationResults[${index}].result is required`);
    }
    if (refs.has(wrapper.reference)) workflowError("verification_reference_duplicate", `Duplicate verification result reference: ${wrapper.reference}`);
    if (ids.has(wrapper.result.resultId)) workflowError("verification_result_duplicate", `Duplicate verification result ID: ${wrapper.result.resultId}`);
    refs.add(wrapper.reference);
    ids.add(wrapper.result.resultId);
    const actualDigest = computeVerificationResultDigest(wrapper.result);
    if (wrapper.result.resultDigest !== actualDigest) {
      workflowError("verification_result_digest_invalid", `Verification result digest is invalid: ${wrapper.result.resultId}`, {
        resultId: wrapper.result.resultId,
        expected: actualDigest,
        actual: wrapper.result.resultDigest ?? null
      });
    }
    normalized.push({
      reference: wrapper.reference,
      result: wrapper.result,
      binding: {
        resultId: wrapper.result.resultId,
        resultDigest: wrapper.result.resultDigest
      }
    });
  }
  return normalized.sort((left, right) => left.result.resultId.localeCompare(right.result.resultId, "en"));
}

export function verificationResultRefs(entries) {
  return entries.map((entry) => entry.reference).sort((left, right) => left.localeCompare(right, "en"));
}

export function verificationResultDigests(entries) {
  return entries.map((entry) => ({ ...entry.binding }))
    .sort((left, right) => left.resultId.localeCompare(right.resultId, "en"));
}

export function computeReviewContextDigest({
  reviewContextId,
  subjectRevision,
  subjectContentDigest,
  taskPacketDigest,
  controlDigest,
  verificationResults,
}) {
  return digestJson({
    reviewContextId,
    subjectRevision,
    subjectContentDigest,
    taskPacketDigest,
    controlDigest,
    verificationResults: verificationResults.map((entry) => ({
      resultId: entry.result.resultId,
      resultRef: entry.reference,
      resultDigest: entry.result.resultDigest
    })).sort((left, right) => left.resultId.localeCompare(right.resultId, "en"))
  });
}

export function compareVerificationBindingSet({
  expectedRefs = [],
  expectedDigests = [],
  actualEntries = [],
  contextDigest,
  reviewContextId,
  subjectRevision,
  subjectContentDigest,
  taskPacketDigest,
  controlDigest,
}) {
  const errors = [];
  const actualRefs = verificationResultRefs(actualEntries);
  const actualDigests = verificationResultDigests(actualEntries);
  if (new Set(expectedRefs).size !== expectedRefs.length
    || expectedRefs.length !== actualRefs.length
    || expectedRefs.some((reference) => !actualRefs.includes(reference))) {
    errors.push(reason("VERIFICATION_REFERENCE_SET_MISMATCH", "Verification result references do not exactly match", {
      expectedRefs,
      actualRefs
    }));
  }
  const expectedKeys = expectedDigests.map(bindingKey);
  const actualKeys = actualDigests.map(bindingKey);
  if (new Set(expectedKeys).size !== expectedKeys.length
    || expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key) => !actualKeys.includes(key))) {
    errors.push(reason("VERIFICATION_DIGEST_SET_MISMATCH", "Verification result digests do not exactly match", {
      expectedDigests,
      actualDigests
    }));
  }
  if (contextDigest !== undefined) {
    const actualContextDigest = computeReviewContextDigest({
      reviewContextId,
      subjectRevision,
      subjectContentDigest,
      taskPacketDigest,
      controlDigest,
      verificationResults: actualEntries
    });
    if (contextDigest !== actualContextDigest) {
      errors.push(reason("REVIEW_CONTEXT_DIGEST_MISMATCH", "Review context digest does not bind the exact verification result set", {
        expected: contextDigest,
        actual: actualContextDigest
      }));
    }
  }
  return { ok: errors.length === 0, errors, actualRefs, actualDigests };
}
