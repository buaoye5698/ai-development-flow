import { digestJson, pathMatchesPattern } from "../core/index.mjs";

const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;

export function executionAuthorizationPayload(authorization) {
  const { authorizationDigest: ignored, ...payload } = authorization ?? {};
  return payload;
}

export function attachExecutionAuthorizationDigest(authorization) {
  const payload = executionAuthorizationPayload(authorization);
  return { ...payload, authorizationDigest: digestJson(payload) };
}

export function authorizationRequired(taskPacket, externalEffects = []) {
  return taskPacket?.taskKind === "control_plane" || externalEffects.length > 0;
}

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

export function validateExecutionAuthorization({
  authorization,
  runId,
  taskPacket,
  requestedPaths = [],
  requestedExternalEffects = [],
  now,
  consumedNonces = [],
}) {
  const errors = [];
  const expectedDigest = digestJson(executionAuthorizationPayload(authorization));
  if (authorization?.authorizationDigest !== expectedDigest) {
    errors.push(finding("AUTHORIZATION_TAMPERED", "execution authorization digest is invalid", {
      expected: expectedDigest,
      actual: authorization?.authorizationDigest ?? null,
    }));
  }
  const taskPacketDigest = digestJson(taskPacket);
  for (const [field, expected] of [
    ["runId", runId],
    ["taskId", taskPacket?.taskId],
    ["taskPacketDigest", taskPacketDigest],
    ["baseRevision", taskPacket?.baseRevision],
    ["controlDigest", taskPacket?.controlDigest],
  ]) {
    if (authorization?.[field] !== expected) {
      errors.push(finding("AUTHORIZATION_BINDING_MISMATCH", `execution authorization ${field} is stale`, {
        field,
        expected,
        actual: authorization?.[field] ?? null,
      }));
    }
  }
  const nowValue = typeof now === "string" ? now : now?.toISOString?.();
  if (!UTC.test(nowValue ?? "") || !UTC.test(authorization?.issuedAt ?? "") || !UTC.test(authorization?.expiresAt ?? "")) {
    errors.push(finding("AUTHORIZATION_TIME_INVALID", "authorization times must be explicit UTC timestamps"));
  } else {
    const nowMs = Date.parse(nowValue);
    const issuedMs = Date.parse(authorization.issuedAt);
    const expiresMs = Date.parse(authorization.expiresAt);
    if (!(issuedMs <= nowMs && nowMs < expiresMs)) {
      errors.push(finding("AUTHORIZATION_EXPIRED", "execution authorization is not currently valid"));
    }
  }
  if (new Set(consumedNonces).has(authorization?.nonce)) {
    errors.push(finding("AUTHORIZATION_NONCE_REPLAY", "execution authorization nonce has already been consumed", {
      nonce: authorization?.nonce ?? null,
    }));
  }
  for (const requestedPath of requestedPaths) {
    if (!(authorization?.allowedPaths ?? []).some((pattern) => pathMatchesPattern(requestedPath, pattern))) {
      errors.push(finding("AUTHORIZATION_PATH_FORBIDDEN", "requested path is outside the authorization", { path: requestedPath }));
    }
  }
  const allowedEffects = new Set(authorization?.allowedExternalEffects ?? []);
  for (const effect of requestedExternalEffects) {
    if (!allowedEffects.has(effect)) {
      errors.push(finding("AUTHORIZATION_EFFECT_FORBIDDEN", "requested external effect is outside the authorization", { effect }));
    }
  }
  return { ok: errors.length === 0, errors, authorizationDigest: expectedDigest };
}
