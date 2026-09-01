import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { sha256 } from "../core/index.mjs";
import { assertSafeDestinationPath, validateRelativePath } from "./path-safety.mjs";

function adapterError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export async function loadSpecAdapter(projectRoot, specAdapter) {
  let modulePath;
  try {
    modulePath = validateRelativePath(specAdapter?.module);
  } catch (error) {
    throw adapterError("SPEC_ADAPTER_PATH_INVALID", "configured specification adapter path is invalid", {
      detail: error.message,
    });
  }
  const exportName = specAdapter?.exportName;
  if (typeof exportName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(exportName)) {
    throw adapterError(
      "SPEC_ADAPTER_EXPORT_INVALID",
      "configured specification adapter exportName is missing or invalid",
    );
  }

  const absolutePath = await assertSafeDestinationPath(projectRoot, modulePath);
  let bytes;
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("adapter must be a regular non-link file");
    }
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw adapterError("SPEC_ADAPTER_MODULE_INVALID", "configured specification adapter cannot be read safely", {
      path: modulePath,
      detail: error.message,
    });
  }

  const moduleUrl = pathToFileURL(absolutePath);
  moduleUrl.searchParams.set("ai-flow-content", sha256(bytes));
  let namespace;
  try {
    namespace = await import(moduleUrl.href);
  } catch (error) {
    throw adapterError("SPEC_ADAPTER_IMPORT_FAILED", "configured specification adapter could not be imported", {
      path: modulePath,
      exportName,
      detail: error.message,
    });
  }
  if (typeof namespace[exportName] !== "function") {
    throw adapterError(
      "SPEC_ADAPTER_EXPORT_MISSING",
      "configured specification adapter export is not a function",
      { path: modulePath, exportName },
    );
  }
  return {
    modulePath,
    exportName,
    contentDigest: sha256(bytes),
    compile: namespace[exportName],
  };
}
