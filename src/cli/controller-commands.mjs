import {
  abandonRun,
  advanceRun,
  inspectRun,
  prepareRun,
  resumeRun,
} from "../controller/index.mjs";
import { guardedOperation, readProjectJson } from "./project-artifacts.mjs";
import { validateRelativePath } from "./path-safety.mjs";

export function prepareRunCommand(options) {
  return guardedOperation(() => prepareRun(options));
}

export function inspectRunCommand(options) {
  return guardedOperation(() => inspectRun(options));
}

export function resumeRunCommand(options) {
  return guardedOperation(() => resumeRun(options));
}

export function advanceRunCommand({ project, runId, expectedRunDigest, input }) {
  return guardedOperation(async () => {
    const request = await readProjectJson(project, validateRelativePath(input));
    return advanceRun({ project, runId, expectedRunDigest, request });
  });
}

export function abandonRunCommand(options) {
  return guardedOperation(() => abandonRun(options));
}
