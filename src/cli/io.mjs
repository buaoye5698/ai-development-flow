import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeDestinationPath, normalizeRepoPath, resolveWithin } from "./path-safety.mjs";

export async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

export async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = normalizeRepoPath(path.posix.join(prefix, entry.name));
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      result.push(relativePath);
    } else {
      throw new Error(`template source contains a non-regular entry: ${absolutePath}`);
    }
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

export async function writeEntries(rootDir, entries) {
  for (const entry of entries) {
    await assertSafeDestinationPath(rootDir, entry.path);
    const destination = resolveWithin(rootDir, entry.path);
    await mkdir(path.dirname(destination), { recursive: true });
    const parent = path.posix.dirname(entry.path);
    if (parent !== ".") await assertSafeDestinationPath(rootDir, normalizeRepoPath(parent));
    await assertSafeDestinationPath(rootDir, entry.path);
    await writeFile(destination, entry.content, { flag: "wx" });
  }
}
