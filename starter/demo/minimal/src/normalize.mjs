export function normalizeLabel(value) {
  if (typeof value !== "string") throw new TypeError("value must be a string");
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}
