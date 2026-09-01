import { createHash } from "node:crypto";

function normalizeJsonValue(value, stack) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
    stack.add(value);
    const result = value.map((entry) => normalizeJsonValue(entry, stack));
    stack.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (stack.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
    stack.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) result[key] = normalizeJsonValue(entry, stack);
    }
    stack.delete(value);
    return result;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function stableStringify(value) {
  return JSON.stringify(normalizeJsonValue(value, new Set()));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(String(value), "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalText(value) {
  return String(value).replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

export function canonicalTextDigest(value) {
  return sha256(canonicalText(value));
}

export function digestJson(value) {
  return sha256(stableStringify(value));
}
