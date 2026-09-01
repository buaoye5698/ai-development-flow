import { digestJson } from "./canonical.mjs";

export const EVIDENCE_LEVELS = Object.freeze([
  "specification",
  "contract",
  "runtime_stub",
  "target_integration",
  "owner",
  "production"
]);

export const MACHINE_EVIDENCE_LEVELS = Object.freeze(EVIDENCE_LEVELS.slice(0, 4));
const MACHINE_LEVEL_SET = new Set(MACHINE_EVIDENCE_LEVELS);
const TIERS = Object.freeze(["quick", "deep"]);
const AUTHORITY_KINDS = Object.freeze(["owner_acceptance", "production_release"]);
const ACTOR_TYPES = new Set(["human", "external_system"]);

function levelIndex(level) {
  return EVIDENCE_LEVELS.indexOf(level);
}

function reason(code, message, details = {}) {
  return { code, message, ...details };
}

function identityKey(value) {
  return typeof value === "string" ? value.normalize("NFC").toLowerCase() : "";
}

export function compareEvidenceLevel(left, right) {
  const leftIndex = levelIndex(left);
  const rightIndex = levelIndex(right);
  if (leftIndex < 0) throw new RangeError(`Unknown evidence level: ${left}`);
  if (rightIndex < 0) throw new RangeError(`Unknown evidence level: ${right}`);
  return Math.sign(leftIndex - rightIndex);
}

export function summarizeEvidenceLevels(entries) {
  const errors = [];
  const statuses = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (levelIndex(entry?.level) < 0) {
      errors.push({ code: "EVIDENCE_LEVEL_UNKNOWN", level: entry?.level ?? null });
      continue;
    }
    if (statuses.has(entry.level)) {
      errors.push({ code: "EVIDENCE_LEVEL_DUPLICATE", level: entry.level });
      continue;
    }
    statuses.set(entry.level, entry.status);
  }

  let highestLevel = null;
  for (const level of EVIDENCE_LEVELS) {
    if (statuses.get(level) !== "pass") break;
    highestLevel = level;
  }
  return { highestLevel, statuses: Object.fromEntries(statuses), errors };
}

export function highestClaimableEvidenceLevel(entries) {
  return summarizeEvidenceLevels(entries).highestLevel;
}

export function computeEvidenceBundleDigest(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new TypeError("Evidence bundle must be an object");
  }
  const unsigned = { ...bundle };
  delete unsigned.bundleDigest;
  return digestJson(unsigned);
}

export function computeVerificationResultDigest(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("Verification result must be an object");
  }
  const unsigned = { ...result };
  delete unsigned.resultDigest;
  return digestJson(unsigned);
}

export function validateVerificationResultEvidence(result, expected = {}) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      valid: false,
      completePass: false,
      errors: [reason("VERIFICATION_RESULT_INVALID", "Verification result is not an object")]
    };
  }
  if (result.schemaVersion !== 2) {
    errors.push(reason("VERIFICATION_SCHEMA_VERSION_UNSUPPORTED", "Verification result must use schemaVersion 2", {
      verifierId: result.verifierId ?? null,
      expected: 2,
      actual: result.schemaVersion ?? null
    }));
  }
  if (!MACHINE_LEVEL_SET.has(result.evidenceLevel)) {
    errors.push(reason("VERIFICATION_EVIDENCE_LEVEL_FORBIDDEN", "Command verifier evidence cannot exceed target integration", {
      verifierId: result.verifierId ?? null,
      evidenceLevel: result.evidenceLevel ?? null
    }));
  }
  if (!TIERS.includes(result.requiredTier) || !TIERS.includes(result.executedTier)) {
    errors.push(reason("VERIFICATION_TIER_INVALID", "Verification result has an unknown required or executed tier", {
      verifierId: result.verifierId ?? null
    }));
  }
  if (typeof result.complete !== "boolean") {
    errors.push(reason("VERIFICATION_COMPLETENESS_MISSING", "Verification result must declare whether execution was complete", {
      verifierId: result.verifierId ?? null
    }));
  }
  if (result.status === "partial" && result.complete !== false) {
    errors.push(reason("VERIFICATION_PARTIAL_CONTRADICTION", "A partial verification result cannot be complete", {
      verifierId: result.verifierId ?? null
    }));
  }
  if (result.complete === true
    && TIERS.includes(result.requiredTier)
    && TIERS.includes(result.executedTier)
    && TIERS.indexOf(result.executedTier) < TIERS.indexOf(result.requiredTier)) {
    errors.push(reason("VERIFICATION_TIER_INCOMPLETE", "Executed verification tier does not cover the required tier", {
      verifierId: result.verifierId ?? null,
      requiredTier: result.requiredTier,
      executedTier: result.executedTier
    }));
  }
  const expectedDigest = computeVerificationResultDigest(result);
  if (result.resultDigest !== expectedDigest) {
    errors.push(reason("VERIFICATION_RESULT_DIGEST_INVALID", "Verification result digest does not match its content", {
      verifierId: result.verifierId ?? null,
      expected: expectedDigest,
      actual: result.resultDigest ?? null
    }));
  }
  for (const field of [
    "taskId",
    "baselineId",
    "specDigest",
    "taskPacketDigest",
    "controlDigest",
    "subjectContentDigest",
    "expectedTaskDigest",
    "subjectRevision",
    "worktreeDigest",
    "requiredTier"
  ]) {
    if (expected[field] !== undefined && result[field] !== expected[field]) {
      errors.push(reason("VERIFICATION_BINDING_MISMATCH", `Verification result ${field} does not match the active run`, {
        verifierId: result.verifierId ?? null,
        field,
        expected: expected[field],
        actual: result[field] ?? null
      }));
    }
  }
  const valid = errors.length === 0;
  const completePass = valid
    && result.status === "pass"
    && result.complete === true
    && TIERS.indexOf(result.executedTier) >= TIERS.indexOf(result.requiredTier);
  return { valid, completePass, errors };
}

const AUTHORITY_SCALAR_BINDINGS = Object.freeze([
  "taskId",
  "taskPacketDigest",
  "expectedTaskDigest",
  "specDigest",
  "controlDigest",
  "subjectContentDigest",
  "baselineDigest",
  "subjectRevision",
  "worktreeDigest"
]);
const VERIFICATION_BINDING_FIELDS = Object.freeze(["resultId", "resultDigest"]);
const REVIEW_BINDING_FIELDS = Object.freeze([
  "reportId",
  "reportDigest",
  "implementerContextId",
  "reviewContextId",
  "contextDigest"
]);

function selectedBinding(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value?.[field]]));
}

function bindingIdentity(value, fields) {
  return digestJson(selectedBinding(value, fields));
}

function canonicalBindingSet(values, fields) {
  return (Array.isArray(values) ? values : [])
    .map((value) => selectedBinding(value, fields))
    .sort((left, right) => bindingIdentity(left, fields).localeCompare(bindingIdentity(right, fields)));
}

function sameBindingSet(left, right, fields) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const leftKeys = left.map((entry) => bindingIdentity(entry, fields)).sort();
  const rightKeys = right.map((entry) => bindingIdentity(entry, fields)).sort();
  return leftKeys.every((entry, index) => entry === rightKeys[index]);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))].sort();
}

function authorityEntryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function computeAuthorityReceiptDigest(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("Authority receipt must be an object");
  }
  const unsigned = structuredClone(receipt);
  delete unsigned.receiptDigest;
  return digestJson(unsigned);
}

export function normalizeAuthorityReceiptEntries(entries, { requireReferences = false } = {}) {
  if (!Array.isArray(entries)) {
    throw authorityEntryError("AUTHORITY_RECEIPT_ENTRIES_INVALID", "Authority receipt entries must be an array");
  }
  const references = [];
  const receipts = [];
  const seenReferences = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const wrapped = entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.hasOwn(entry, "receipt");
    const receipt = wrapped ? entry.receipt : entry;
    const reference = wrapped ? entry.reference : null;
    if (requireReferences && (typeof reference !== "string" || reference.trim().length === 0)) {
      throw authorityEntryError("AUTHORITY_RECEIPT_REFERENCE_REQUIRED", "Authority receipt storage reference is required", { index });
    }
    if (wrapped && (typeof reference !== "string" || reference.trim().length === 0)) {
      throw authorityEntryError("AUTHORITY_RECEIPT_REFERENCE_INVALID", "Authority receipt storage reference must be a non-empty string", { index });
    }
    if (wrapped) {
      if (seenReferences.has(reference)) {
        throw authorityEntryError("AUTHORITY_RECEIPT_REFERENCE_DUPLICATE", "Authority receipt storage reference is duplicated", { reference });
      }
      seenReferences.add(reference);
      references.push(reference);
    }
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw authorityEntryError("AUTHORITY_RECEIPT_INVALID", "Authority receipt entry has no receipt object", { index });
    }
    receipts.push(receipt);
  }
  return { references, receipts };
}

export function buildAuthorityReceiptBinding(expected = {}, {
  verificationResults = [],
  reviewReports = [],
  participantContextIds = []
} = {}) {
  const verificationValues = Array.isArray(verificationResults) ? verificationResults : [];
  const reviewValues = Array.isArray(reviewReports) ? reviewReports : [];
  const verificationResultDigests = canonicalBindingSet(
    verificationValues.map((result) => ({
      resultId: result?.resultId,
      resultDigest: result?.resultDigest
    })),
    VERIFICATION_BINDING_FIELDS
  );
  const reviewReportDigests = canonicalBindingSet(
    reviewValues.map((report) => ({
      reportId: report?.reportId,
      reportDigest: digestJson(report),
      implementerContextId: report?.implementerContextId,
      reviewContextId: report?.reviewContextId,
      contextDigest: report?.contextDigest
    })),
    REVIEW_BINDING_FIELDS
  );
  const contexts = uniqueStrings([
    ...participantContextIds,
    ...reviewValues.flatMap((report) => [report?.implementerContextId, report?.reviewContextId])
  ]);
  return {
    ...expected,
    verificationResultDigests,
    reviewReportDigests,
    verificationCompletedAt: verificationValues.map((result) => ({
      resultId: result?.resultId,
      completedAt: result?.completedAt
    })),
    reviewCreatedAt: reviewValues.map((report) => ({
      reportId: report?.reportId,
      createdAt: report?.createdAt
    })),
    participantContextIds: contexts,
    forbiddenActorRefs: uniqueStrings([
      ...contexts,
      ...verificationValues.flatMap((result) => [result?.verifierId, result?.resultId]),
      ...reviewValues.map((report) => report?.reportId)
    ])
  };
}

function inspectBindingSet(receipt, field, expected, fields, errors) {
  const actual = receipt?.[field];
  if (!Array.isArray(actual)) {
    errors.push(reason("AUTHORITY_RECEIPT_BINDING_SET_INVALID", `Authority receipt ${field} must be an array`, {
      receiptId: receipt?.receiptId ?? null,
      field
    }));
    return;
  }
  const ids = new Set();
  const keys = new Set();
  for (const entry of actual) {
    const id = entry?.[fields[0]];
    if (!entry || typeof entry !== "object" || fields.some((name) => typeof entry[name] !== "string" || entry[name].length === 0)) {
      errors.push(reason("AUTHORITY_RECEIPT_BINDING_SET_INVALID", `Authority receipt ${field} contains an invalid entry`, {
        receiptId: receipt?.receiptId ?? null,
        field
      }));
      continue;
    }
    if (ids.has(id)) {
      errors.push(reason("AUTHORITY_RECEIPT_BINDING_DUPLICATE", `Authority receipt ${field} repeats an identity`, {
        receiptId: receipt?.receiptId ?? null,
        field,
        id
      }));
    }
    ids.add(id);
    const key = bindingIdentity(entry, fields);
    if (keys.has(key)) {
      errors.push(reason("AUTHORITY_RECEIPT_BINDING_DUPLICATE", `Authority receipt ${field} repeats a binding`, {
        receiptId: receipt?.receiptId ?? null,
        field,
        id
      }));
    }
    keys.add(key);
  }
  if (!Array.isArray(expected)) {
    errors.push(reason("AUTHORITY_RECEIPT_BINDING_CONTEXT_MISSING", `Current ${field} binding set is unavailable`, {
      receiptId: receipt?.receiptId ?? null,
      field
    }));
  } else if (!sameBindingSet(actual, expected, fields)) {
    errors.push(reason("AUTHORITY_RECEIPT_BINDING_SET_MISMATCH", `Authority receipt ${field} does not match the exact current set`, {
      receiptId: receipt?.receiptId ?? null,
      field
    }));
  }
}

function latestBoundEvidenceTime(expected, errors) {
  let latest = -Infinity;
  const groups = [
    ["verificationCompletedAt", "completedAt", "resultId"],
    ["reviewCreatedAt", "createdAt", "reportId"]
  ];
  for (const [field, timeField, idField] of groups) {
    if (!Array.isArray(expected[field])) {
      errors.push(reason("AUTHORITY_RECEIPT_BINDING_CONTEXT_MISSING", `Current ${field} values are unavailable`, { field }));
      continue;
    }
    for (const entry of expected[field]) {
      const value = Date.parse(entry?.[timeField]);
      if (!Number.isFinite(value)) {
        errors.push(reason("AUTHORITY_EVIDENCE_TIME_INVALID", "Bound verification or review timestamp is invalid", {
          field,
          id: entry?.[idField] ?? null
        }));
      } else {
        latest = Math.max(latest, value);
      }
    }
  }
  return latest;
}

export function validateAuthorityReceipts(receipts, expected = {}) {
  if (!Array.isArray(receipts)) {
    return {
      valid: false,
      errors: [reason("AUTHORITY_RECEIPTS_INVALID", "Authority receipts must be an array")]
    };
  }
  const values = receipts;
  const errors = [];
  const receiptIds = new Set();
  const kinds = new Set();
  const forbiddenActors = new Set(uniqueStrings([
    ...(expected.participantContextIds ?? []),
    ...(expected.forbiddenActorRefs ?? [])
  ]).map(identityKey));
  const latestEvidenceTime = values.length > 0 ? latestBoundEvidenceTime(expected, errors) : -Infinity;
  let previousTime = -Infinity;

  if (values.length > AUTHORITY_KINDS.length) {
    errors.push(reason("AUTHORITY_RECEIPT_COUNT_INVALID", "At most one Owner and one production receipt are allowed"));
  }

  for (let index = 0; index < values.length; index += 1) {
    const receipt = values[index];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      errors.push(reason("AUTHORITY_RECEIPT_INVALID", "Authority receipt is not an object", { index }));
      continue;
    }
    if (!AUTHORITY_KINDS.includes(receipt.kind)) {
      errors.push(reason("AUTHORITY_RECEIPT_KIND_INVALID", "Authority receipt kind is invalid", { index, kind: receipt.kind ?? null }));
    }
    if (receipt.schemaVersion !== 2) {
      errors.push(reason("AUTHORITY_RECEIPT_SCHEMA_VERSION_UNSUPPORTED", "Authority receipt must use schemaVersion 2", {
        index,
        receiptId: receipt.receiptId ?? null,
        expected: 2,
        actual: receipt.schemaVersion ?? null
      }));
    }
    if (!ACTOR_TYPES.has(receipt.actorType)) {
      errors.push(reason("AUTHORITY_RECEIPT_ACTOR_TYPE_INVALID", "Authority receipt actor type must be human or external_system", {
        index,
        actorType: receipt.actorType ?? null
      }));
    }
    for (const field of ["receiptId", "actorRef", "issuedAt", "reference", "receiptDigest"]) {
      if (typeof receipt[field] !== "string" || receipt[field].trim().length === 0) {
        errors.push(reason("AUTHORITY_RECEIPT_FIELD_MISSING", `Authority receipt ${field} is required`, { index, field }));
      }
    }
    if (receiptIds.has(receipt.receiptId)) {
      errors.push(reason("AUTHORITY_RECEIPT_DUPLICATE", "Authority receipt ID is duplicated", { receiptId: receipt.receiptId }));
    }
    receiptIds.add(receipt.receiptId);
    if (kinds.has(receipt.kind)) {
      errors.push(reason("AUTHORITY_RECEIPT_KIND_DUPLICATE", "Authority receipt kind is duplicated", { kind: receipt.kind }));
    }
    kinds.add(receipt.kind);

    for (const field of AUTHORITY_SCALAR_BINDINGS) {
      if (typeof receipt[field] !== "string" || receipt[field].length === 0) {
        errors.push(reason("AUTHORITY_RECEIPT_FIELD_MISSING", `Authority receipt ${field} is required`, {
          receiptId: receipt.receiptId ?? null,
          field
        }));
      }
      if (expected[field] === undefined) {
        errors.push(reason("AUTHORITY_RECEIPT_BINDING_CONTEXT_MISSING", `Current ${field} binding is unavailable`, {
          receiptId: receipt.receiptId ?? null,
          field
        }));
      } else if (receipt[field] !== expected[field]) {
        errors.push(reason("AUTHORITY_RECEIPT_BINDING_MISMATCH", `Authority receipt ${field} is stale or belongs to another task`, {
          receiptId: receipt.receiptId ?? null,
          field,
          expected: expected[field],
          actual: receipt[field] ?? null
        }));
      }
    }
    if (receipt.taskPacketDigest !== receipt.expectedTaskDigest) {
      errors.push(reason("AUTHORITY_RECEIPT_TASK_DIGEST_INCONSISTENT", "Task packet and expected task digests must be identical", {
        receiptId: receipt.receiptId ?? null
      }));
    }
    inspectBindingSet(receipt, "verificationResultDigests", expected.verificationResultDigests, VERIFICATION_BINDING_FIELDS, errors);
    inspectBindingSet(receipt, "reviewReportDigests", expected.reviewReportDigests, REVIEW_BINDING_FIELDS, errors);

    let computedDigest = null;
    try {
      computedDigest = computeAuthorityReceiptDigest(receipt);
    } catch {
      errors.push(reason("AUTHORITY_RECEIPT_DIGEST_INVALID", "Authority receipt digest could not be computed", {
        receiptId: receipt.receiptId ?? null
      }));
    }
    if (computedDigest !== null && receipt.receiptDigest !== computedDigest) {
      errors.push(reason("AUTHORITY_RECEIPT_DIGEST_INVALID", "Authority receipt digest does not match its canonical content", {
        receiptId: receipt.receiptId ?? null,
        expected: computedDigest,
        actual: receipt.receiptDigest ?? null
      }));
    }

    if (forbiddenActors.has(identityKey(receipt.actorRef))) {
      errors.push(reason("AUTHORITY_RECEIPT_ROLE_CONFLICT", "Implementer, reviewer, or ordinary verifier identity cannot issue authority", {
        receiptId: receipt.receiptId ?? null,
        actorRef: receipt.actorRef ?? null
      }));
    }
    const issuedAt = Date.parse(receipt.issuedAt);
    if (!Number.isFinite(issuedAt)) {
      errors.push(reason("AUTHORITY_RECEIPT_TIME_INVALID", "Authority receipt time is invalid", { receiptId: receipt.receiptId ?? null }));
    } else {
      if (issuedAt < previousTime) {
        errors.push(reason("AUTHORITY_RECEIPT_ORDER_INVALID", "Authority receipts must be ordered by issuance time", {
          receiptId: receipt.receiptId ?? null
        }));
      }
      previousTime = issuedAt;
      if (receipt.kind === "owner_acceptance" && Number.isFinite(latestEvidenceTime) && issuedAt <= latestEvidenceTime) {
        errors.push(reason("OWNER_RECEIPT_PREMATURE", "Owner acceptance must be issued after every bound verification and review", {
          receiptId: receipt.receiptId ?? null
        }));
      }
    }
    if (receipt.kind !== AUTHORITY_KINDS[index]) {
      errors.push(reason("AUTHORITY_RECEIPT_ORDER_INVALID", "Authority receipts must be owner_acceptance then production_release", {
        index,
        expectedKind: AUTHORITY_KINDS[index] ?? null,
        actualKind: receipt.kind ?? null
      }));
    }
    if (receipt.kind === "owner_acceptance" && Object.hasOwn(receipt, "priorOwnerReceiptDigest")) {
      errors.push(reason("OWNER_PRIOR_RECEIPT_FORBIDDEN", "Owner acceptance cannot reference a prior Owner receipt", {
        receiptId: receipt.receiptId ?? null
      }));
    }
    if (receipt.kind === "production_release"
      && (typeof receipt.priorOwnerReceiptDigest !== "string" || receipt.priorOwnerReceiptDigest.length === 0)) {
      errors.push(reason("PRODUCTION_OWNER_RECEIPT_MISSING", "Production release requires the exact prior Owner receipt digest"));
    }
  }

  const owner = values.find((receipt) => receipt?.kind === "owner_acceptance");
  const production = values.find((receipt) => receipt?.kind === "production_release");
  if (production && !owner) {
    errors.push(reason("PRODUCTION_OWNER_RECEIPT_MISSING", "Production release requires prior Owner acceptance"));
  }
  if (production && owner) {
    let canonicalOwnerDigest = null;
    try {
      canonicalOwnerDigest = computeAuthorityReceiptDigest(owner);
    } catch {
      // The Owner receipt already reports its own digest error above.
    }
    if (production.priorOwnerReceiptDigest !== canonicalOwnerDigest) {
      errors.push(reason("PRODUCTION_OWNER_RECEIPT_MISMATCH", "Production release does not bind the canonical prior Owner receipt", {
        receiptId: production.receiptId ?? null
      }));
    }
    for (const field of AUTHORITY_SCALAR_BINDINGS) {
      if (production[field] !== owner[field]) {
        errors.push(reason("PRODUCTION_BINDING_MISMATCH", "Production release and Owner acceptance bind different evidence", {
          field
        }));
      }
    }
    if (!sameBindingSet(production.verificationResultDigests, owner.verificationResultDigests, VERIFICATION_BINDING_FIELDS)
      || !sameBindingSet(production.reviewReportDigests, owner.reviewReportDigests, REVIEW_BINDING_FIELDS)) {
      errors.push(reason("PRODUCTION_BINDING_MISMATCH", "Production release and Owner acceptance bind different result or review sets"));
    }
    const ownerTime = Date.parse(owner.issuedAt);
    const productionTime = Date.parse(production.issuedAt);
    if (Number.isFinite(ownerTime) && Number.isFinite(productionTime) && productionTime <= ownerTime) {
      errors.push(reason("PRODUCTION_RECEIPT_PREMATURE", "Production release must be issued after Owner acceptance", {
        receiptId: production.receiptId ?? null
      }));
    }
  }
  if (values.length > 0 && expected.lowerEvidenceComplete !== true) {
    errors.push(reason("AUTHORITY_LOWER_EVIDENCE_INCOMPLETE", "Authority receipts cannot promote incomplete machine evidence"));
  }
  return { valid: errors.length === 0, errors };
}

export function deriveEvidenceLevels({
  verificationResults = [],
  authorityReceipts = [],
  expected = {},
  participantContextIds = [],
  specificationReference = "task/spec binding"
} = {}) {
  const references = new Map(EVIDENCE_LEVELS.map((level) => [level, []]));
  const errors = [];
  references.get("specification").push(specificationReference);

  for (const result of verificationResults) {
    const inspection = validateVerificationResultEvidence(result, expected);
    errors.push(...inspection.errors);
    if (inspection.completePass) references.get(result.evidenceLevel).push(result.resultId);
  }

  const machineLevels = MACHINE_EVIDENCE_LEVELS.map((level) => ({
    level,
    status: references.get(level).length > 0 ? "pass" : "not_run",
    reference: [...new Set(references.get(level))].sort().join(", ") || "not run"
  }));
  const lowerEvidenceComplete = machineLevels.every((entry) => entry.status === "pass");
  const receiptValidation = validateAuthorityReceipts(authorityReceipts, {
    ...expected,
    participantContextIds: uniqueStrings([
      ...(expected.participantContextIds ?? []),
      ...participantContextIds
    ]),
    lowerEvidenceComplete
  });
  errors.push(...receiptValidation.errors);
  if (receiptValidation.valid) {
    if (authorityReceipts.some((receipt) => receipt.kind === "owner_acceptance")) {
      references.get("owner").push(authorityReceipts.find((receipt) => receipt.kind === "owner_acceptance").reference);
    }
    if (authorityReceipts.some((receipt) => receipt.kind === "production_release")) {
      references.get("production").push(authorityReceipts.find((receipt) => receipt.kind === "production_release").reference);
    }
  }

  const levels = EVIDENCE_LEVELS.map((level) => ({
    level,
    status: references.get(level).length > 0 ? "pass" : "not_run",
    reference: [...new Set(references.get(level))].sort().join(", ") || "not run"
  }));
  return {
    levels,
    highestLevel: errors.length === 0 ? highestClaimableEvidenceLevel(levels) : null,
    errors
  };
}

function entriesByVerifier(bundle) {
  return new Map((Array.isArray(bundle?.verifierEvidence) ? bundle.verifierEvidence : [])
    .map((entry) => [entry.verifierId, entry]));
}

function bindingKey(entry) {
  return `${entry?.resultId ?? ""}\u0000${entry?.resultDigest ?? ""}`;
}

export function evaluateEvidenceFreshness(bundle, current = {}) {
  const reasons = [];
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return { fresh: false, reasons: [reason("EVIDENCE_BUNDLE_INVALID", "Evidence bundle is not an object")] };
  }

  if (bundle.schemaVersion !== 2) {
    reasons.push(reason("EVIDENCE_BUNDLE_SCHEMA_VERSION_UNSUPPORTED", "Evidence bundle must use schemaVersion 2", {
      expected: 2,
      actual: bundle.schemaVersion ?? null
    }));
  }
  try {
    if (typeof bundle.bundleDigest !== "string" || bundle.bundleDigest !== computeEvidenceBundleDigest(bundle)) {
      reasons.push(reason("EVIDENCE_BUNDLE_DIGEST_INVALID", "Evidence bundle digest does not match its content"));
    }
  } catch {
    reasons.push(reason("EVIDENCE_BUNDLE_DIGEST_INVALID", "Evidence bundle digest could not be computed"));
  }

  const currentValue = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const requiredScalarBindings = [
    "baselineId",
    "specDigest",
    "expectedTaskDigest",
    "taskPacketDigest",
    "controlDigest",
    "subjectContentDigest",
    "contextManifestDigest"
  ];
  for (const field of requiredScalarBindings) {
    if (!Object.hasOwn(currentValue, field)
      || typeof currentValue[field] !== "string"
      || currentValue[field].length === 0) {
      reasons.push(reason("EVIDENCE_CURRENT_BINDING_MISSING", `Current ${field} binding is required`, { field }));
    }
  }
  for (const field of ["verifierDefinitionDigests", "verifierInputDigests"]) {
    if (!Object.hasOwn(currentValue, field)
      || !currentValue[field]
      || typeof currentValue[field] !== "object"
      || Array.isArray(currentValue[field])) {
      reasons.push(reason("EVIDENCE_CURRENT_BINDING_MISSING", `Current ${field} bindings are required`, { field }));
    }
  }

  if (typeof currentValue.baselineId === "string" && bundle.baselineId !== currentValue.baselineId) {
    reasons.push(reason("EVIDENCE_BASELINE_STALE", "Baseline ID changed", { expected: currentValue.baselineId, actual: bundle.baselineId }));
  }
  if (typeof currentValue.specDigest === "string" && bundle.specDigest !== currentValue.specDigest) {
    reasons.push(reason("EVIDENCE_SPEC_STALE", "Specification digest changed", { expected: currentValue.specDigest, actual: bundle.specDigest }));
  }
  if (typeof currentValue.expectedTaskDigest === "string" && bundle.expectedTaskDigest !== currentValue.expectedTaskDigest) {
    reasons.push(reason("EVIDENCE_TASK_BINDING_STALE", "Expected task digest changed", {
      expected: currentValue.expectedTaskDigest,
      actual: bundle.expectedTaskDigest
    }));
  }
  if (typeof currentValue.taskPacketDigest === "string" && bundle.taskPacketDigest !== currentValue.taskPacketDigest) {
    reasons.push(reason("EVIDENCE_TASK_PACKET_STALE", "TaskPacket digest changed", { expected: currentValue.taskPacketDigest, actual: bundle.taskPacketDigest }));
  }
  if (typeof currentValue.controlDigest === "string" && bundle.controlDigest !== currentValue.controlDigest) {
    reasons.push(reason("EVIDENCE_CONTROL_STALE", "Active Control digest changed", { expected: currentValue.controlDigest, actual: bundle.controlDigest }));
  }
  if (typeof currentValue.subjectContentDigest === "string" && bundle.subjectContentDigest !== currentValue.subjectContentDigest) {
    reasons.push(reason("EVIDENCE_SUBJECT_CONTENT_STALE", "subject content digest changed", { expected: currentValue.subjectContentDigest, actual: bundle.subjectContentDigest }));
  }
  if (typeof currentValue.contextManifestDigest === "string" && bundle.contextManifestDigest !== currentValue.contextManifestDigest) {
    reasons.push(reason("EVIDENCE_CONTEXT_STALE", "Context manifest changed", {
      expected: currentValue.contextManifestDigest,
      actual: bundle.contextManifestDigest
    }));
  }

  const byVerifier = entriesByVerifier(bundle);
  const currentDefinitionDigests = currentValue.verifierDefinitionDigests
    && typeof currentValue.verifierDefinitionDigests === "object"
    && !Array.isArray(currentValue.verifierDefinitionDigests)
    ? currentValue.verifierDefinitionDigests
    : {};
  const currentInputDigests = currentValue.verifierInputDigests
    && typeof currentValue.verifierInputDigests === "object"
    && !Array.isArray(currentValue.verifierInputDigests)
    ? currentValue.verifierInputDigests
    : {};
  for (const verifierId of byVerifier.keys()) {
    if (!Object.hasOwn(currentDefinitionDigests, verifierId)) {
      reasons.push(reason("EVIDENCE_VERIFIER_DEFINITION_CURRENT_MISSING", "Current verifier definition digest is missing", { verifierId }));
    }
    if (!Object.hasOwn(currentInputDigests, verifierId)) {
      reasons.push(reason("EVIDENCE_VERIFIER_INPUT_CURRENT_MISSING", "Current verifier input digest is missing", { verifierId }));
    }
  }
  for (const [verifierId, expectedDigest] of Object.entries(currentDefinitionDigests)) {
    const evidence = byVerifier.get(verifierId);
    if (!evidence) {
      reasons.push(reason("EVIDENCE_VERIFIER_MISSING", "Verifier evidence is missing", { verifierId }));
    } else if (evidence.definitionDigest !== expectedDigest) {
      reasons.push(reason("EVIDENCE_VERIFIER_STALE", "Verifier definition changed", {
        verifierId,
        expected: expectedDigest,
        actual: evidence.definitionDigest
      }));
    }
  }
  for (const [verifierId, expectedDigest] of Object.entries(currentInputDigests)) {
    const evidence = byVerifier.get(verifierId);
    if (!evidence) {
      if (!reasons.some((entry) => entry.code === "EVIDENCE_VERIFIER_MISSING" && entry.verifierId === verifierId)) {
        reasons.push(reason("EVIDENCE_VERIFIER_MISSING", "Verifier evidence is missing", { verifierId }));
      }
    } else if (evidence.inputDigest !== expectedDigest) {
      reasons.push(reason("EVIDENCE_INPUT_STALE", "Verifier input changed", {
        verifierId,
        expected: expectedDigest,
        actual: evidence.inputDigest
      }));
    }
  }

  const verifierBindings = (bundle.verifierEvidence ?? []).map((entry) => ({
    resultId: entry.resultId,
    resultDigest: entry.resultDigest
  }));
  const declaredBindings = bundle.verificationResultDigests ?? [];
  if (verifierBindings.length !== declaredBindings.length
    || new Set(verifierBindings.map(bindingKey)).size !== verifierBindings.length
    || new Set(declaredBindings.map(bindingKey)).size !== declaredBindings.length
    || verifierBindings.some((entry) => !declaredBindings.some((candidate) => bindingKey(candidate) === bindingKey(entry)))) {
    reasons.push(reason("EVIDENCE_VERIFICATION_SET_INVALID", "Evidence bundle verification result set is inconsistent"));
  }

  const derivedReferences = new Map(EVIDENCE_LEVELS.map((level) => [level, []]));
  derivedReferences.get("specification").push(bundle.specDigest);
  for (const entry of bundle.verifierEvidence ?? []) {
    if (!MACHINE_LEVEL_SET.has(entry.level)) {
      reasons.push(reason("EVIDENCE_VERIFIER_LEVEL_FORBIDDEN", "Verifier evidence exceeds target integration", {
        verifierId: entry.verifierId,
        level: entry.level
      }));
    } else if (entry.status === "pass" && entry.complete === true) {
      if (!TIERS.includes(entry.requiredTier)
        || !TIERS.includes(entry.executedTier)
        || TIERS.indexOf(entry.executedTier) < TIERS.indexOf(entry.requiredTier)) {
        reasons.push(reason("EVIDENCE_VERIFIER_TIER_INCOMPLETE", "Verifier evidence did not execute the required tier", {
          verifierId: entry.verifierId,
          requiredTier: entry.requiredTier ?? null,
          executedTier: entry.executedTier ?? null
        }));
      } else {
        derivedReferences.get(entry.level).push(entry.resultRef);
      }
    }
  }
  const lowerEvidenceComplete = MACHINE_EVIDENCE_LEVELS.every((level) => derivedReferences.get(level).length > 0);
  const participants = (bundle.reviewEvidence ?? []).flatMap((entry) => [
    entry.reviewContextId,
    entry.implementerContextId
  ]).filter(Boolean);
  const authorityReceiptRefs = bundle.authorityReceiptRefs;
  if (!Array.isArray(authorityReceiptRefs)
    || authorityReceiptRefs.length !== (bundle.authorityReceipts ?? []).length
    || new Set(authorityReceiptRefs).size !== authorityReceiptRefs.length) {
    reasons.push(reason("EVIDENCE_AUTHORITY_REFERENCE_SET_INVALID", "Authority receipt references are missing, duplicated, or inconsistent"));
  }
  const authority = validateAuthorityReceipts(bundle.authorityReceipts ?? [], {
    taskId: bundle.taskId,
    taskPacketDigest: bundle.taskPacketDigest,
    expectedTaskDigest: bundle.expectedTaskDigest,
    specDigest: bundle.specDigest,
    controlDigest: bundle.controlDigest,
    subjectContentDigest: bundle.subjectContentDigest,
    baselineDigest: bundle.baselineDigest,
    subjectRevision: bundle.subjectRevision,
    worktreeDigest: bundle.worktreeDigest,
    verificationResultDigests: bundle.verificationResultDigests,
    reviewReportDigests: (bundle.reviewEvidence ?? []).map((entry) => ({
      reportId: entry.reportId,
      reportDigest: entry.reportDigest,
      implementerContextId: entry.implementerContextId,
      reviewContextId: entry.reviewContextId,
      contextDigest: entry.contextDigest
    })),
    verificationCompletedAt: (bundle.verifierEvidence ?? []).map((entry) => ({
      resultId: entry.resultId,
      completedAt: entry.completedAt
    })),
    reviewCreatedAt: (bundle.reviewEvidence ?? []).map((entry) => ({
      reportId: entry.reportId,
      createdAt: entry.createdAt
    })),
    participantContextIds: participants,
    forbiddenActorRefs: [
      ...(bundle.verifierEvidence ?? []).flatMap((entry) => [entry.verifierId, entry.resultId]),
      ...(bundle.reviewEvidence ?? []).map((entry) => entry.reportId)
    ],
    lowerEvidenceComplete
  });
  reasons.push(...authority.errors);
  if (authority.valid) {
    for (const receipt of bundle.authorityReceipts ?? []) {
      derivedReferences.get(receipt.kind === "owner_acceptance" ? "owner" : "production").push(receipt.reference);
    }
  }
  const derivedLevels = EVIDENCE_LEVELS.map((level) => ({
    level,
    status: derivedReferences.get(level).length > 0 ? "pass" : "not_run"
  }));
  const summary = summarizeEvidenceLevels(bundle.levels);
  reasons.push(...summary.errors.map((entry) => reason(entry.code, "Evidence level set is invalid", entry)));
  for (const entry of bundle.levels ?? []) {
    const derived = derivedLevels.find((candidate) => candidate.level === entry.level);
    if (entry.status === "pass" && derived?.status !== "pass") {
      reasons.push(reason("EVIDENCE_LEVEL_UNBACKED", "Passing evidence level lacks an authorized source", { level: entry.level }));
    }
  }
  const derivedHighest = highestClaimableEvidenceLevel(derivedLevels);
  if (levelIndex(bundle.declaredMaximumLevel) < 0) {
    reasons.push(reason("EVIDENCE_DECLARATION_UNKNOWN", "Declared maximum evidence level is unknown"));
  } else if (derivedHighest === null || compareEvidenceLevel(bundle.declaredMaximumLevel, derivedHighest) > 0) {
    reasons.push(reason("EVIDENCE_LEVEL_ELEVATED", "Declared evidence level exceeds backed contiguous evidence", {
      declared: bundle.declaredMaximumLevel,
      highestClaimable: derivedHighest
    }));
  }

  return { fresh: reasons.length === 0, reasons, highestClaimableLevel: derivedHighest };
}
