import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { digestJson, normalizeRepoPath, sha256 } from "../core/index.mjs";
import { assertSafeDestinationPath } from "../cli/path-safety.mjs";

const INSTRUCTION_FILES = Object.freeze(["AGENTS.override.md", "AGENTS.md"]);

async function readInstruction(projectRoot, relativePath) {
  const absolutePath = await assertSafeDestinationPath(projectRoot, relativePath);
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      const error = new Error(`instruction file must be a regular non-link file: ${relativePath}`);
      error.code = "INSTRUCTION_FILE_UNSAFE";
      throw error;
    }
    const bytes = await readFile(absolutePath);
    if (bytes.length === 0 || bytes.toString("utf8").trim().length === 0) return null;
    return { path: relativePath, bytes, contentDigest: sha256(bytes) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function ancestorDirectories(relativePath) {
  const directory = path.posix.dirname(normalizeRepoPath(relativePath));
  if (directory === ".") return [""];
  const segments = directory.split("/");
  return ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}

export async function resolveCodexInstructionChain(projectRoot, targetPath, { maxBytes = 32 * 1024 } = {}) {
  const chain = [];
  let totalBytes = 0;
  for (const directory of ancestorDirectories(targetPath)) {
    let selected = null;
    for (const fileName of INSTRUCTION_FILES) {
      const relativePath = directory ? path.posix.join(directory, fileName) : fileName;
      const candidate = await readInstruction(projectRoot, relativePath);
      if (candidate) {
        selected = candidate;
        break;
      }
    }
    if (!selected) continue;
    totalBytes += selected.bytes.length;
    if (totalBytes > maxBytes) {
      const error = new Error(`effective AGENTS instructions exceed ${maxBytes} bytes`);
      error.code = "INSTRUCTION_LIMIT_EXCEEDED";
      error.totalBytes = totalBytes;
      throw error;
    }
    chain.push({ path: selected.path, contentDigest: selected.contentDigest, size: selected.bytes.length });
  }
  const value = { targetPath: normalizeRepoPath(targetPath), files: chain, totalBytes };
  return { ...value, instructionChainDigest: digestJson(chain) };
}

export async function resolveTaskInstructionBinding(projectRoot, writePaths, options = {}) {
  const chains = [];
  for (const targetPath of [...new Set(writePaths ?? [])].sort()) {
    chains.push(await resolveCodexInstructionChain(projectRoot, targetPath, options));
  }
  const digests = [...new Set(chains.map((entry) => entry.instructionChainDigest))];
  if (digests.length > 1) {
    const error = new Error("planned write paths resolve to different Codex instruction chains; split the task");
    error.code = "INSTRUCTION_CHAIN_SPLIT_REQUIRED";
    error.chains = chains;
    throw error;
  }
  return {
    instructionChainDigest: digests[0] ?? digestJson([]),
    files: chains[0]?.files ?? [],
    targetPaths: chains.map((entry) => entry.targetPath),
  };
}
