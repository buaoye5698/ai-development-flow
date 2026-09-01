import {
  adoptProject,
  doctorProject,
  initProject,
  runVerification,
  selfCheck,
  upgradeCheck,
  versionInfo,
} from "./commands.mjs";
import { EXIT } from "./constants.mjs";
import {
  buildContextCommand,
  checkProjectCommand,
  compileSpecCommand,
  compileTaskCommand,
  renderContextCommand,
  validateTaskCommand,
} from "./static-commands.mjs";
import {
  evidenceStatusCommand,
  evaluateCycleCommand,
  finalizeRunCommand,
  metricsReportCommand,
  sealEvidenceCommand,
  validateReviewCommand,
} from "./workflow-commands.mjs";
import {
  abandonRunCommand,
  advanceRunCommand,
  inspectRunCommand,
  prepareRunCommand,
  resumeRunCommand,
} from "./controller-commands.mjs";
import { startTaskCommand } from "./start-command.mjs";

const HELP = `Usage:
  ai-flow version [--json]
  ai-flow self-check [--json]
  ai-flow init <directory> --id <project-id> [--name <display-name>] [--spec <file> | --demo minimal] [--dry-run] [--json]
  ai-flow adopt <directory> [--id <project-id>] [--name <display-name>] [--apply] [--dry-run] [--json]
  ai-flow doctor <directory> [--json]
  ai-flow upgrade-check <directory> [--json]
  ai-flow check --project <directory> [--json]
  ai-flow start --project <directory> --input <path> [--mode <auto|quick|full>] [--worktree <absolute-path>] [--authorization <path>] [--json]
  ai-flow spec compile --project <directory> [--out <path>] [--dry-run] [--json]
  ai-flow task compile --project <directory> --input <path> [--out <path>] [--dry-run] [--json]
  ai-flow task validate --project <directory> --task <id-or-path> [--json]
  ai-flow context build --project <directory> --input <path> [--out <path>] [--dry-run] [--json]
  ai-flow context render --project <directory> --task <id-or-path> --context <path> --audience <agent|human> [--out <path>] [--dry-run] [--json]
  ai-flow run prepare --project <directory> --task <id-or-path> --run <id> --worktree <absolute-path> --at <UTC-time> [--authorization <path>] [--json]
  ai-flow run inspect --project <directory> --run <id> [--json]
  ai-flow run resume --project <directory> --run <id> [--json]
  ai-flow run advance --project <directory> --run <id> --expected-run-digest <sha256:...> --input <path> [--json]
  ai-flow run finalize --project <directory> --run <id> --expected-run-digest <sha256:...> --input <path> [--json]
  ai-flow run abandon --project <directory> --run <id> --expected-run-digest <sha256:...> --at <UTC-time> --reason <text> [--json]
  ai-flow review validate --project <directory> --review <id-or-path> [--json]
  ai-flow verify --project <directory> --tier <quick|deep> [--run <id> | --task <id-or-path> --expected-task-digest <sha256:...>] [--json]
  ai-flow cycle evaluate --project <directory> --input <path> [--json]
  ai-flow evidence seal --project <directory> --input <path> [--out <path>] [--dry-run] [--json]
  ai-flow evidence status --project <directory> --bundle <path> [--json]
  ai-flow metrics report --project <directory> [--out <path>] [--dry-run] [--json]`;

function usageError(message) {
  const error = new Error(message);
  error.code = "USAGE_ERROR";
  return error;
}

function parse(args, { values = [], flags = [], positionals = 0 } = {}) {
  const valueOptions = new Set(values);
  const flagOptions = new Set(flags);
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (valueOptions.has(argument)) {
      if (Object.hasOwn(options, argument)) throw usageError(`${argument} may be supplied once`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw usageError(`${argument} requires a value`);
      options[argument] = value;
      index += 1;
    } else if (flagOptions.has(argument)) {
      if (Object.hasOwn(options, argument)) throw usageError(`${argument} may be supplied once`);
      options[argument] = true;
    } else {
      throw usageError(`unknown option: ${argument}`);
    }
  }
  if (positional.length !== positionals) {
    throw usageError(`expected ${positionals} positional argument(s); received ${positional.length}`);
  }
  return { positional, options };
}

function printHuman(command, result) {
  if (command === "version") {
    process.stdout.write(`${result.name} ${result.version} (Node ${result.node})\n`);
    return;
  }
  const status = String(result.status ?? "unknown").toUpperCase();
  const suffix = result.target ? ` ${result.target}` : "";
  process.stdout.write(`${status} ${command}${suffix}\n`);
  for (const entry of result.errors ?? []) {
    process.stdout.write(`ERROR ${entry.code}: ${entry.message}\n`);
  }
  for (const entry of result.warnings ?? []) {
    process.stdout.write(`WARN ${entry.code}: ${entry.message}\n`);
  }
  if (Array.isArray(result.changes) && result.changes.length > 0) {
    process.stdout.write(`CHANGES ${result.changes.length}\n`);
  }
  if (Array.isArray(result.conflicts) && result.conflicts.length > 0) {
    process.stdout.write(`CONFLICTS ${result.conflicts.length}\n`);
  }
}

function print(command, result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(command, result);
}

function resultExitCode(result) {
  if (result.status === "fail") return EXIT.failed;
  return ["blocked", "error", "partial"].includes(result.status) ? EXIT.blocked : EXIT.ok;
}

function defineCommand(pathValue, options, run) {
  return Object.freeze({ path: pathValue.split(" "), ...options, run });
}

const COMMANDS = Object.freeze([
  defineCommand("version", { flags: ["--json"] }, () => versionInfo()),
  defineCommand("self-check", { flags: ["--json"] }, () => selfCheck()),
  defineCommand("init", {
    values: ["--id", "--name", "--spec", "--demo"],
    flags: ["--dry-run", "--json"],
    positionals: 1,
    required: ["--id"],
    requiredMessage: "init requires --id",
    validate: ({ options }) => {
      if (options["--spec"] && options["--demo"]) {
        throw usageError("init accepts either --spec or --demo, not both");
      }
      if (options["--demo"] && options["--demo"] !== "minimal") {
        throw usageError("init currently supports only --demo minimal");
      }
    },
  }, ({ positional, options }) => initProject({
    target: positional[0],
    projectId: options["--id"],
    projectName: options["--name"] ?? options["--id"],
    specPath: options["--spec"] ?? null,
    demo: options["--demo"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("adopt", {
    values: ["--id", "--name"],
    flags: ["--apply", "--dry-run", "--json"],
    positionals: 1,
  }, ({ positional, options }) => adoptProject({
    target: positional[0],
    projectId: options["--id"] ?? null,
    projectName: options["--name"] ?? null,
    apply: options["--apply"] === true,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("doctor", { flags: ["--json"], positionals: 1 }, ({ positional }) =>
    doctorProject({ target: positional[0] })),
  defineCommand("upgrade-check", { flags: ["--json"], positionals: 1 }, ({ positional }) =>
    upgradeCheck({ target: positional[0] })),
  defineCommand("check", {
    values: ["--project"],
    flags: ["--json"],
    required: ["--project"],
    requiredMessage: "check requires --project",
  }, ({ options }) => checkProjectCommand({ project: options["--project"] })),
  defineCommand("start", {
    values: ["--project", "--input", "--mode", "--worktree", "--authorization"],
    flags: ["--json"],
    required: ["--project", "--input"],
    requiredMessage: "start requires --project and --input",
    validate: ({ options }) => {
      if (!new Set(["auto", "quick", "full"]).has(options["--mode"] ?? "auto")) {
        throw usageError("start requires --mode auto, quick, or full");
      }
    },
  }, ({ options }) => startTaskCommand({
    project: options["--project"],
    input: options["--input"],
    mode: options["--mode"] ?? "auto",
    worktreePath: options["--worktree"] ?? null,
    authorizationPath: options["--authorization"] ?? null,
  })),
  defineCommand("spec compile", {
    values: ["--project", "--out"],
    flags: ["--dry-run", "--json"],
    required: ["--project"],
    requiredMessage: "spec compile requires --project",
  }, ({ options }) => compileSpecCommand({
    project: options["--project"],
    output: options["--out"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("task compile", {
    values: ["--project", "--input", "--out"],
    flags: ["--dry-run", "--json"],
    required: ["--project", "--input"],
    requiredMessage: "task compile requires --project and --input",
  }, ({ options }) => compileTaskCommand({
    project: options["--project"],
    input: options["--input"],
    output: options["--out"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("task validate", {
    values: ["--project", "--task"],
    flags: ["--json"],
    required: ["--project", "--task"],
    requiredMessage: "task validate requires --project and --task",
  }, ({ options }) => validateTaskCommand({
    project: options["--project"],
    task: options["--task"],
  })),
  defineCommand("context build", {
    values: ["--project", "--input", "--out"],
    flags: ["--dry-run", "--json"],
    required: ["--project", "--input"],
    requiredMessage: "context build requires --project and --input",
  }, ({ options }) => buildContextCommand({
    project: options["--project"],
    input: options["--input"],
    output: options["--out"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("context render", {
    values: ["--project", "--task", "--context", "--audience", "--out"],
    flags: ["--dry-run", "--json"],
    required: ["--project", "--task", "--context", "--audience"],
    requiredMessage: "context render requires --project, --task, --context, and --audience",
    validate: ({ options }) => {
      if (!new Set(["agent", "human"]).has(options["--audience"])) throw usageError("context render requires --audience agent or human");
    },
  }, ({ options }) => renderContextCommand({
    project: options["--project"],
    task: options["--task"],
    context: options["--context"],
    audience: options["--audience"],
    output: options["--out"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("run prepare", {
    values: ["--project", "--task", "--run", "--worktree", "--at", "--authorization"],
    flags: ["--json"],
    required: ["--project", "--task", "--run", "--worktree", "--at"],
    requiredMessage: "run prepare requires --project, --task, --run, --worktree, and --at",
  }, ({ options }) => prepareRunCommand({
    project: options["--project"],
    task: options["--task"],
    runId: options["--run"],
    worktreePath: options["--worktree"],
    at: options["--at"],
    authorizationPath: options["--authorization"] ?? null,
  })),
  defineCommand("run inspect", {
    values: ["--project", "--run"], flags: ["--json"],
    required: ["--project", "--run"], requiredMessage: "run inspect requires --project and --run",
  }, ({ options }) => inspectRunCommand({ project: options["--project"], runId: options["--run"] })),
  defineCommand("run resume", {
    values: ["--project", "--run"], flags: ["--json"],
    required: ["--project", "--run"], requiredMessage: "run resume requires --project and --run",
  }, ({ options }) => resumeRunCommand({ project: options["--project"], runId: options["--run"] })),
  defineCommand("run advance", {
    values: ["--project", "--run", "--expected-run-digest", "--input"], flags: ["--json"],
    required: ["--project", "--run", "--expected-run-digest", "--input"],
    requiredMessage: "run advance requires --project, --run, --expected-run-digest, and --input",
  }, ({ options }) => advanceRunCommand({
    project: options["--project"], runId: options["--run"],
    expectedRunDigest: options["--expected-run-digest"], input: options["--input"],
  })),
  defineCommand("run finalize", {
    values: ["--project", "--run", "--expected-run-digest", "--input"], flags: ["--json"],
    required: ["--project", "--run", "--expected-run-digest", "--input"],
    requiredMessage: "run finalize requires --project, --run, --expected-run-digest, and --input",
  }, ({ options }) => finalizeRunCommand({
    project: options["--project"], runId: options["--run"],
    expectedRunDigest: options["--expected-run-digest"], input: options["--input"],
  })),
  defineCommand("run abandon", {
    values: ["--project", "--run", "--expected-run-digest", "--at", "--reason"], flags: ["--json"],
    required: ["--project", "--run", "--expected-run-digest", "--at", "--reason"],
    requiredMessage: "run abandon requires --project, --run, --expected-run-digest, --at, and --reason",
  }, ({ options }) => abandonRunCommand({
    project: options["--project"], runId: options["--run"], expectedRunDigest: options["--expected-run-digest"],
    at: options["--at"], reason: options["--reason"],
  })),
  defineCommand("review validate", {
    values: ["--project", "--review"],
    flags: ["--json"],
    required: ["--project", "--review"],
    requiredMessage: "review validate requires --project and --review",
  }, ({ options }) => validateReviewCommand({
    project: options["--project"],
    review: options["--review"],
  })),
  defineCommand("verify", {
    values: ["--project", "--tier", "--run", "--task", "--expected-task-digest"],
    flags: ["--json"],
    required: ["--project"],
    requiredMessage: "verify requires --project",
    validate: ({ options }) => {
      if (!new Set(["quick", "deep"]).has(options["--tier"])) {
        throw usageError("verify requires --tier quick or --tier deep");
      }
      if (options["--run"] && (options["--task"] || options["--expected-task-digest"])) {
        throw usageError("verify --run cannot be combined with --task or --expected-task-digest");
      }
    },
  }, ({ options }) => runVerification({
    project: options["--project"],
    tier: options["--tier"],
    runId: options["--run"] ?? null,
    task: options["--task"] ?? null,
    expectedTaskDigest: options["--expected-task-digest"] ?? null,
  })),
  defineCommand("cycle evaluate", {
    values: ["--project", "--input"],
    flags: ["--json"],
    required: ["--project", "--input"],
    requiredMessage: "cycle evaluate requires --project and --input",
  }, ({ options }) => evaluateCycleCommand({
    project: options["--project"],
    input: options["--input"],
  })),
  defineCommand("evidence seal", {
    values: ["--project", "--input", "--out"],
    flags: ["--dry-run", "--json"],
    required: ["--project", "--input"],
    requiredMessage: "evidence seal requires --project and --input",
  }, ({ options }) => sealEvidenceCommand({
    project: options["--project"],
    input: options["--input"],
    output: options["--out"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
  defineCommand("evidence status", {
    values: ["--project", "--bundle"],
    flags: ["--json"],
    required: ["--project", "--bundle"],
    requiredMessage: "evidence status requires --project and --bundle",
  }, ({ options }) => evidenceStatusCommand({
    project: options["--project"],
    bundle: options["--bundle"],
  })),
  defineCommand("metrics report", {
    values: ["--project", "--out"],
    flags: ["--dry-run", "--json"],
    required: ["--project"],
    requiredMessage: "metrics report requires --project",
  }, ({ options }) => metricsReportCommand({
    project: options["--project"],
    output: options["--out"] ?? null,
    dryRun: options["--dry-run"] === true,
  })),
]);

const SUBCOMMAND_USAGE = Object.freeze({
  spec: "spec requires the compile action",
  task: "task requires compile or validate",
  context: "context requires the build or render action",
  run: "run requires prepare, inspect, resume, advance, or abandon",
  review: "review requires the validate action",
  cycle: "cycle requires the evaluate action",
  evidence: "evidence requires seal or status",
  metrics: "metrics requires the report action",
});

function resolveCommand(argv) {
  const definition = COMMANDS
    .filter((candidate) => candidate.path.every((segment, index) => argv[index] === segment))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (definition) return definition;
  const [command] = argv;
  if (SUBCOMMAND_USAGE[command]) throw usageError(SUBCOMMAND_USAGE[command]);
  throw usageError(`unknown command: ${command}`);
}

export async function main(argv) {
  const [command] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  try {
    const definition = resolveCommand(argv);
    const parsed = parse(argv.slice(definition.path.length), definition);
    if ((definition.required ?? []).some((option) => !parsed.options[option])) {
      throw usageError(definition.requiredMessage);
    }
    definition.validate?.(parsed);
    const result = await definition.run(parsed);
    const json = parsed.options["--json"] === true;
    print(command, result, json);
    process.exitCode = resultExitCode(result);
  } catch (error) {
    if (error.code !== "USAGE_ERROR") throw error;
    const result = { status: "error", code: error.code, message: error.message, usage: HELP };
    const json = argv.includes("--json");
    print(command, result, json);
    process.exitCode = EXIT.usage;
  }
}
