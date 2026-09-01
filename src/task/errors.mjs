export class TaskCompilationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TaskCompilationError";
    this.code = code;
    this.details = details;
  }
}

export function taskError(code, message, details = {}) {
  throw new TaskCompilationError(code, message, details);
}
