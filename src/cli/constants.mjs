export const FRAMEWORK_NAME = "ai-development-flow";
export const DEFAULT_FRAMEWORK_VERSION = "1.0.0";
export const CONFIG_PATH = "ai-flow.config.json";
export const BASELINE_PATH = "ai-dev/baseline.json";
export const LOCK_PATH = "ai-dev/framework-lock.json";
export const PROJECT_SCHEMA_DIRECTORIES = Object.freeze(["ai-dev/schemas", "schemas"]);

export function projectSchemaPaths(schemaName) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(schemaName ?? "")) {
    throw new Error("schemaName must contain only lowercase letters, numbers, and hyphens");
  }
  return PROJECT_SCHEMA_DIRECTORIES.map(
    (directory) => `${directory}/${schemaName}.schema.json`,
  );
}

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  blocked: 2,
  usage: 64,
});

export const TEXT_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
  ".tpl",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
]);

export const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
