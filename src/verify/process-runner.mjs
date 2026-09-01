import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const TERMINATOR_TIMEOUT_MS = 1_500;
const TERMINATION_SETTLE_MS = 2_500;

const WINDOWS_TREE_KILL_SCRIPT = String.raw`
$rootProcessId = [int]$args[0]
try {
  $rootProcess = Get-Process -Id $rootProcessId -ErrorAction SilentlyContinue
  if ($null -eq $rootProcess) { exit 0 }
  $rootProcess.Kill($true)
  if (-not $rootProcess.WaitForExit(1000)) { exit 1 }
  exit 0
} catch {
  exit 1
}
`;

function commandName(value) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error("verifier command must be a non-empty single line");
  }
  return value === "node" ? process.execPath : value;
}

function waitForProcess(child, timeoutMs = TERMINATOR_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {
        // The helper may already have exited.
      }
      child.unref();
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => finish({ exitCode: null, error }));
    child.once("close", (exitCode) => finish({ exitCode }));
  });
}

async function runTerminator(command, args) {
  try {
    return await waitForProcess(spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    }));
  } catch (error) {
    return { exitCode: null, error };
  }
}

async function terminateProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return false;
  if (process.platform === "win32") {
    const taskkill = await runTerminator(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
    );
    let complete = taskkill.exitCode === 0;
    if (!complete) {
      const powershell = await runTerminator("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_TREE_KILL_SCRIPT,
        String(child.pid),
      ]);
      complete = powershell.exitCode === 0;
    }
    try { child.kill("SIGKILL"); } catch {
      // A successful tree terminator may already have closed the process handle.
    }
    return complete;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    try { child.kill("SIGKILL"); } catch {
      // The process may already have exited.
    }
    return false;
  }
}

export function runProcess({
  command,
  args = [],
  cwd,
  timeoutMs,
  env = process.env,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT,
  signal = null,
}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("verifier args must be strings without NUL characters");
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    let timeout = null;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let aborted = false;
    let termination = null;
    let terminationDeadline = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];

    const requestTermination = () => {
      if (!child || termination) return termination;
      termination = terminateProcessTree(child);
      terminationDeadline = setTimeout(() => {
        void finish({
          exitCode: null,
          signal: null,
          error: "verifier process did not close after termination",
        });
      }, TERMINATION_SETTLE_MS);
      return termination;
    };

    const abortListener = () => {
      aborted = true;
      requestTermination();
    };

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationDeadline) clearTimeout(terminationDeadline);
      signal?.removeEventListener("abort", abortListener);
      const treeTerminated = termination ? await termination : true;
      if (termination) {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
      }
      resolve({
        ...result,
        error: result.error ?? (treeTerminated ? null : "verifier process tree termination could not be confirmed"),
        durationMs: Math.max(0, Date.now() - started),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputExceeded,
        aborted,
      });
    };

    const append = (chunks, chunk, stream) => {
      const remaining = Math.max(0, outputLimitBytes - (stream === "stdout" ? stdoutBytes : stderrBytes));
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > outputLimitBytes || stderrBytes > outputLimitBytes) {
        outputExceeded = true;
        requestTermination();
      }
    };

    try {
      child = spawn(commandName(command), args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => append(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk) => append(stderr, chunk, "stderr"));
      child.on("error", (error) => {
        void finish({ exitCode: null, signal: null, error: error.message });
      });
      child.on("close", (exitCode, closeSignal) => {
        void finish({
          exitCode,
          signal: closeSignal,
          error: aborted ? "verifier execution was cancelled" : null,
        });
      });
      timeout = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, timeoutMs);
      if (signal?.aborted) abortListener();
      else signal?.addEventListener("abort", abortListener, { once: true });
    } catch (error) {
      void finish({ exitCode: null, signal: null, error: error.message });
    }
  });
}

export async function mapWithConcurrency(values, concurrency, worker, options = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const controller = options.controller ?? new AbortController();
  const results = new Array(values.length);
  let nextIndex = 0;
  let firstError = null;
  async function consume() {
    while (!controller.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await worker(values[index], index, controller.signal);
      } catch (error) {
        if (!firstError) firstError = error;
        controller.abort(error);
        return;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, () => consume()),
  );
  if (firstError) throw firstError;
  return results;
}
