import path from "node:path";

import { canonicalText, sha256 as canonicalSha256 } from "../core/canonical.mjs";
import { TEXT_EXTENSIONS } from "./constants.mjs";

export const normalizeText = canonicalText;
export const sha256 = canonicalSha256;

export function digestFileContent(filePath, bytes) {
  const base = path.basename(filePath).toLowerCase();
  const extension = path.extname(base);
  if (TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(base)) {
    return sha256(Buffer.from(normalizeText(bytes.toString("utf8")), "utf8"));
  }
  return sha256(bytes);
}
