export class WorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

export function workflowError(code, message, details = {}) {
  throw new WorkflowError(code, message, details);
}
