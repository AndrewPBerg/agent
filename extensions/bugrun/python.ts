import { type ChildProcessWithoutNullStreams, execFile as execFileCallback, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { connectDap, type DapClient } from "./dap";

const execFile = promisify(execFileCallback);
const MAX_LOCAL_VARIABLES = 12;
const MAX_VARIABLE_VALUE_CHARS = 500;
const MAX_SUMMARY_VARIABLES = 4;
const MAX_SUMMARY_VALUE_CHARS = 180;
export const MAX_INTERACTIVE_BREAKPOINTS = 5;

const NOISY_LOCAL_NAMES = new Set(["self", "ctx", "state", "deps", "compiled", "graph", "function variables"]);
const IMPORTANT_LOCAL_NAMES = new Set([
  "answer",
  "command",
  "contact",
  "contact_info_descriptor",
  "cursor",
  "executor",
  "executor_result",
  "idempotency_key",
  "intent",
  "intent_session_id",
  "node_turn",
  "payload",
  "request",
  "result",
  "route",
  "staged_fields",
  "user_message",
]);

export type PythonRunner = "auto" | "direct" | "uv";

export type PythonBreakpoint = {
  path: string;
  line: number;
};

export type VariableSnapshot = {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  variablesReference?: number;
};

export type StackFrameSnapshot = {
  id: number;
  name: string;
  path?: string;
  line: number;
  column?: number;
};

export type BreakpointHit = {
  reason: string;
  threadId: number;
  frame: StackFrameSnapshot;
  stack: StackFrameSnapshot[];
  locals: VariableSnapshot[];
};

export type PythonDebugState = "starting" | "running" | "stopped" | "exited" | "error" | "terminated";

export type PythonDebugResult = {
  cwd: string;
  test: string;
  command: string;
  args: string[];
  breakpoints: PythonBreakpoint[];
  hits: BreakpointHit[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type PythonDebugSessionStatus = {
  id: string;
  state: PythonDebugState;
  cwd: string;
  test: string;
  command: string;
  args: string[];
  breakpoints: PythonBreakpoint[];
  hits: BreakpointHit[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutSummary?: string;
  stderrSummary?: string;
  durationMs: number;
  currentHit?: BreakpointHit;
  error?: string;
};

export type PythonDebugOptions = {
  cwd: string;
  test: string;
  breakpoints: PythonBreakpoint[];
  python?: string;
  runner?: PythonRunner;
  uvPackages?: string[];
  uvNoProject?: boolean;
  pytestArgs?: string[];
  maxHits?: number;
  timeoutMs?: number;
  justMyCode?: boolean;
};

type DapStackFrame = {
  id: number;
  name: string;
  line: number;
  column?: number;
  source?: { path?: string };
};

type DapScope = {
  name: string;
  variablesReference: number;
};

type DapVariable = {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  variablesReference?: number;
};

type RunnerCommand = {
  command: string;
  args: string[];
};

function earlyProcessExitError(
  runner: RunnerCommand,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
  spawnError: Error | undefined,
  stdout: string,
  stderr: string,
): Error {
  if (spawnError) return new Error(`Failed to start debug process ${runner.command}: ${spawnError.message}`);

  const output = limitText([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), 4_000, "tail");
  const suffix = output ? `\n${output}` : "";
  return new Error(
    `Debug process exited before DAP connection (code ${exitCode ?? "unknown"}${exitSignal ? `, signal ${exitSignal}` : ""}).${suffix}`,
  );
}

export function parseBreakpointSpec(spec: string, cwd: string): PythonBreakpoint {
  const cleaned = spec.trim().replace(/^@/, "");
  const match = /^(.*):(\d+)$/.exec(cleaned);
  if (!match) throw new Error(`Breakpoint must look like path.py:line, got ${spec}`);

  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid breakpoint line in ${spec}`);

  return { path: resolve(cwd, match[1]), line };
}

export function parseBugrunArgs(args: string, cwd: string): { test?: string; breakpoints: PythonBreakpoint[]; command?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { breakpoints: [] };

  const [first, ...rest] = tokens;
  if (["status", "stop", "fixture", "help"].includes(first))
    return { command: first, test: rest[0], breakpoints: rest.slice(1).map((item) => parseBreakpointSpec(item, cwd)) };
  return { test: first, breakpoints: rest.map((item) => parseBreakpointSpec(item, cwd)) };
}

export class PythonDebugSession {
  readonly id: string;
  readonly cwd: string;
  readonly test: string;
  readonly command: string;
  readonly args: string[];
  readonly breakpoints: PythonBreakpoint[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly childExit: Promise<void>;
  private readonly startedAt = Date.now();
  private readonly timeoutMs: number;
  private dap?: DapClient;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private spawnError?: Error;
  private stdout = "";
  private stderr = "";
  private hits: BreakpointHit[] = [];
  private state: PythonDebugState = "starting";
  private lastThreadId?: number;
  private error?: string;
  private pending = Promise.resolve();

  private constructor(id: string, cwd: string, test: string, runner: RunnerCommand, breakpoints: PythonBreakpoint[], timeoutMs: number) {
    this.id = id;
    this.cwd = cwd;
    this.test = test;
    this.command = runner.command;
    this.args = runner.args;
    this.breakpoints = breakpoints;
    this.timeoutMs = timeoutMs;

    this.child = spawn(runner.command, runner.args, {
      cwd,
      env: {
        ...process.env,
        PYDEVD_DISABLE_FILE_VALIDATION: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on("data", (chunk) => {
      this.stdout = limitText(this.stdout + chunk.toString("utf8"), 100_000, "head");
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = limitText(this.stderr + chunk.toString("utf8"), 100_000, "head");
    });

    this.childExit = new Promise<void>((resolveExit) => {
      this.child.once("error", (error) => {
        this.spawnError = error;
        this.state = "error";
        this.error = error.message;
        resolveExit();
      });
      this.child.once("exit", (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        if (this.state !== "terminated" && this.state !== "error") this.state = "exited";
        resolveExit();
      });
    });
  }

  static async start(id: string, options: PythonDebugOptions, signal?: AbortSignal): Promise<PythonDebugSession> {
    const cwd = await realpath(options.cwd);
    const breakpoints = await normalizeBreakpoints(cwd, options.breakpoints);
    if (!breakpoints.length) throw new Error("bugrun Python requires at least one breakpoint (path.py:line).");
    if (breakpoints.length > MAX_INTERACTIVE_BREAKPOINTS)
      throw new Error(`bugrun interactive mode supports at most ${MAX_INTERACTIVE_BREAKPOINTS} breakpoints, got ${breakpoints.length}.`);

    const timeoutMs = options.timeoutMs ?? 60_000;
    const port = await getFreePort();
    const runner = await buildRunnerCommand({ ...options, cwd }, port);
    const session = new PythonDebugSession(id, cwd, options.test, runner, breakpoints, timeoutMs);
    try {
      await session.attach(port, options, signal);
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    }
  }

  async continueToStop(signal?: AbortSignal): Promise<PythonDebugSessionStatus> {
    return this.enqueue(async () => {
      if (!this.dap || this.state === "exited" || this.state === "terminated" || this.state === "error") return this.status();
      const timeoutMs = this.timeLeft();
      if (this.state === "stopped" && this.lastThreadId !== undefined) {
        this.state = "running";
        await this.dap.request("continue", { threadId: this.lastThreadId }, timeoutMs);
      } else {
        this.state = "running";
      }

      let event: Awaited<ReturnType<DapClient["waitForEvent"]>> | undefined;
      try {
        event = await Promise.race([
          this.dap.waitForEvent<{ reason?: string; threadId?: number }>(
            (candidate) => candidate.event === "stopped" || candidate.event === "terminated" || candidate.event === "exited",
            timeoutMs,
          ),
          this.childExit.then(() => undefined),
        ]);
      } catch (error) {
        this.state = "error";
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      if (signal?.aborted) throw new Error("bugrun session aborted");

      if (!event || event.event === "terminated" || event.event === "exited") {
        this.state = this.state === "terminated" ? "terminated" : "exited";
        return this.status();
      }

      const threadId = event.body?.threadId;
      if (typeof threadId !== "number") {
        this.state = "error";
        this.error = "debugpy stopped without threadId";
        return this.status();
      }

      this.lastThreadId = threadId;
      const hit = await captureHit(this.dap, this.cwd, threadId, event.body?.reason ?? "stopped", timeoutMs);
      this.hits.push(hit);
      this.state = "stopped";
      return this.status();
    });
  }

  status(): PythonDebugSessionStatus {
    return {
      id: this.id,
      state: this.state,
      cwd: this.cwd,
      test: this.test,
      command: this.command,
      args: this.args,
      breakpoints: this.breakpoints,
      hits: this.hits,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      stdoutSummary: this.stdout.trim() ? limitText(this.stdout.trim(), 2_000, "tail") : undefined,
      stderrSummary: this.stderr.trim() ? limitText(this.stderr.trim(), 2_000, "tail") : undefined,
      durationMs: Date.now() - this.startedAt,
      currentHit: this.hits.at(-1),
      error: this.error,
    };
  }

  result(): PythonDebugResult {
    return {
      cwd: this.cwd,
      test: this.test,
      command: this.command,
      args: this.args,
      breakpoints: this.breakpoints,
      hits: this.hits,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      stdout: this.stdout,
      stderr: this.stderr,
      durationMs: Date.now() - this.startedAt,
    };
  }

  async stop(): Promise<PythonDebugSessionStatus> {
    await this.enqueue(async () => {
      this.state = "terminated";
      this.dap?.dispose();
      if (this.exitCode === null && !this.spawnError) {
        this.child.kill("SIGTERM");
        await Promise.race([this.childExit, delay(1_000)]);
        if (this.exitCode === null && !this.spawnError) this.child.kill("SIGKILL");
      }
    });
    return this.status();
  }

  private async attach(port: number, options: PythonDebugOptions, signal?: AbortSignal): Promise<void> {
    const startFailure = this.childExit.then(() => {
      throw earlyProcessExitError(
        { command: this.command, args: this.args },
        this.exitCode,
        this.exitSignal,
        this.spawnError,
        this.stdout,
        this.stderr,
      );
    });
    this.dap = await Promise.race([connectDap("127.0.0.1", port, Math.min(15_000, this.timeLeft()), signal), startFailure]);
    await this.dap.request("initialize", {
      adapterID: "debugpy",
      clientID: "pi-bugrun",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
    });
    const attach = this.dap.request(
      "attach",
      {
        name: "bugrun pytest",
        type: "python",
        request: "attach",
        justMyCode: options.justMyCode ?? false,
        subProcess: false,
      },
      this.timeLeft(),
    );
    await this.dap.waitForEvent((event) => event.event === "initialized", this.timeLeft());
    for (const [path, lines] of groupBreakpointLines(this.breakpoints)) {
      await this.dap.request(
        "setBreakpoints",
        { source: { path }, breakpoints: lines.map((line) => ({ line })), lines, sourceModified: false },
        this.timeLeft(),
      );
    }
    await this.dap.request("setExceptionBreakpoints", { filters: [] }, this.timeLeft());
    await this.dap.request("configurationDone", {}, this.timeLeft());
    await attach;
    this.state = "running";
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work, work);
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private timeLeft(): number {
    return Math.max(1_000, this.startedAt + this.timeoutMs - Date.now());
  }
}

export async function runPythonPytestDebug(options: PythonDebugOptions, signal?: AbortSignal): Promise<PythonDebugResult> {
  const startedAt = Date.now();
  const cwd = await realpath(options.cwd);
  const breakpoints = await normalizeBreakpoints(cwd, options.breakpoints);
  if (!breakpoints.length) throw new Error("bugrun Python MVP requires at least one breakpoint (path.py:line).");

  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxHits = options.maxHits ?? 5;
  const port = await getFreePort();
  const runner = await buildRunnerCommand({ ...options, cwd }, port);

  const child = spawn(runner.command, runner.args, {
    cwd,
    env: {
      ...process.env,
      PYDEVD_DISABLE_FILE_VALIDATION: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  }) as ChildProcessWithoutNullStreams;

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = limitText(stdout + chunk.toString("utf8"), 100_000, "head");
  });
  child.stderr.on("data", (chunk) => {
    stderr = limitText(stderr + chunk.toString("utf8"), 100_000, "head");
  });

  let dap: DapClient | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | undefined;
  const childExit = new Promise<void>((resolveExit) => {
    child.once("error", (error) => {
      spawnError = error;
      resolveExit();
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolveExit();
    });
  });

  const hits: BreakpointHit[] = [];
  const deadline = Date.now() + timeoutMs;
  const timeLeft = () => Math.max(1_000, deadline - Date.now());

  try {
    const startFailure = childExit.then(() => {
      throw earlyProcessExitError(runner, exitCode, exitSignal, spawnError, stdout, stderr);
    });

    dap = await Promise.race([connectDap("127.0.0.1", port, Math.min(15_000, timeLeft()), signal), startFailure]);
    await dap.request("initialize", {
      adapterID: "debugpy",
      clientID: "pi-bugrun",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
    });

    const attach = dap.request(
      "attach",
      {
        name: "bugrun pytest",
        type: "python",
        request: "attach",
        justMyCode: options.justMyCode ?? false,
        subProcess: false,
      },
      timeLeft(),
    );

    await dap.waitForEvent((event) => event.event === "initialized", timeLeft());
    for (const [path, lines] of groupBreakpointLines(breakpoints)) {
      await dap.request(
        "setBreakpoints",
        {
          source: { path },
          breakpoints: lines.map((line) => ({ line })),
          lines,
          sourceModified: false,
        },
        timeLeft(),
      );
    }
    await dap.request("setExceptionBreakpoints", { filters: [] }, timeLeft());
    await dap.request("configurationDone", {}, timeLeft());
    await attach;

    while (Date.now() < deadline) {
      const event = await Promise.race([
        dap.waitForEvent<{ reason?: string; threadId?: number; allThreadsStopped?: boolean }>(
          (candidate) => candidate.event === "stopped" || candidate.event === "terminated" || candidate.event === "exited",
          timeLeft(),
        ),
        childExit.then(() => {
          if (spawnError) throw earlyProcessExitError(runner, exitCode, exitSignal, spawnError, stdout, stderr);
          return undefined;
        }),
      ]);

      if (!event || event.event === "terminated" || event.event === "exited") break;
      if (event.event !== "stopped") continue;

      const threadId = event.body?.threadId;
      if (typeof threadId !== "number") break;

      if (hits.length < maxHits) hits.push(await captureHit(dap, cwd, threadId, event.body?.reason ?? "stopped", timeLeft()));
      await dap.request("continue", { threadId }, timeLeft());
    }

    await Promise.race([childExit, delay(Math.min(5_000, timeLeft()))]);
  } finally {
    dap?.dispose();
    if (exitCode === null && !spawnError) {
      child.kill("SIGTERM");
      await Promise.race([childExit, delay(1_000)]);
      if (exitCode === null && !spawnError) child.kill("SIGKILL");
    }
  }

  if (spawnError) throw earlyProcessExitError(runner, exitCode, exitSignal, spawnError, stdout, stderr);

  return {
    cwd,
    test: options.test,
    command: runner.command,
    args: runner.args,
    breakpoints,
    hits,
    exitCode,
    signal: exitSignal,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  };
}

export function formatPythonDebugResult(result: PythonDebugResult, question?: string): string {
  const lines: string[] = ["Bugrun Python/debugpy summary"];
  if (question?.trim()) lines.push(`Question: ${question.trim()}`);
  lines.push(`Pytest target: ${result.test}`);
  lines.push(
    `Exit: ${result.exitCode ?? "signal"}${result.signal ? ` (${result.signal})` : ""}; hits: ${result.hits.length}; duration: ${result.durationMs}ms`,
  );
  lines.push(`Command: ${shellish([result.command, ...result.args])}`);
  lines.push("Full traversal, stack, and captured locals are in tool details / the Bugrun TUI panel; LLM context is compact by design.");

  lines.push("");
  lines.push("Breakpoint traversal:");
  const collapsed = collapseConsecutiveHits(result.hits);
  if (!collapsed.length) lines.push("- none");
  for (const item of collapsed) {
    const label = item.count === 1 ? `#${item.start}` : `#${item.start}-${item.end} ×${item.count}`;
    const hit = item.hit;
    lines.push(`- ${label} ${hit.frame.name} at ${relativePath(result.cwd, hit.frame.path ?? "")}:${hit.frame.line}`);
    const selected = selectSummaryLocals(hit);
    if (selected.length)
      lines.push(`  locals: ${selected.map((variable) => `${variable.name}=${compactSummaryValue(variable.value)}`).join("; ")}`);
    const caller = hit.stack[1];
    if (caller) lines.push(`  caller: ${caller.name} ${relativePath(result.cwd, caller.path ?? "")}:${caller.line}`);
  }

  const outputSummary = summarizeProcessOutput(result);
  if (outputSummary) {
    lines.push("");
    lines.push(outputSummary);
  }

  return lines.join("\n");
}

export function formatPythonDebugFullResult(result: PythonDebugResult, question?: string): string {
  const lines: string[] = ["Bugrun Python/debugpy evidence (full)"];
  if (question?.trim()) lines.push(`Question: ${question.trim()}`);
  lines.push(`Pytest target: ${result.test}`);
  lines.push(`Exit: ${result.exitCode ?? "signal"}${result.signal ? ` (${result.signal})` : ""}`);
  lines.push(`Command: ${shellish([result.command, ...result.args])}`);
  lines.push("");
  lines.push("Breakpoints:");
  for (const breakpoint of result.breakpoints) lines.push(`- ${relativePath(result.cwd, breakpoint.path)}:${breakpoint.line}`);

  lines.push("");
  lines.push(result.hits.length ? "Hits:" : "Hits: none");
  for (const [index, hit] of result.hits.entries()) {
    lines.push(`- #${index + 1} ${hit.reason}: ${hit.frame.name} at ${relativePath(result.cwd, hit.frame.path ?? "")}:${hit.frame.line}`);
    if (hit.locals.length) {
      lines.push(`  locals (values capped at ${MAX_VARIABLE_VALUE_CHARS} chars):`);
      for (const variable of hit.locals.slice(0, MAX_LOCAL_VARIABLES)) {
        const type = variable.type ? ` (${variable.type})` : "";
        lines.push(`    ${variable.name} = ${compactVariableValue(variable.value)}${type}`);
      }
      if (hit.locals.length > MAX_LOCAL_VARIABLES) lines.push(`    ... ${hit.locals.length - MAX_LOCAL_VARIABLES} more locals omitted`);
    }
    const callers = hit.stack.slice(1, 5).map((frame) => `${frame.name} ${relativePath(result.cwd, frame.path ?? "")}:${frame.line}`);
    if (callers.length) lines.push(`  callers: ${callers.join(" <- ")}`);
  }

  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (output) {
    lines.push("");
    lines.push("Pytest/debugpy output:");
    lines.push(limitText(output, 12_000, "tail"));
  }

  return lines.join("\n");
}

export function formatPythonDebugPanel(result: PythonDebugResult): string {
  const lines: string[] = [
    `Bugrun ${result.exitCode === 0 ? "passed" : "exit " + (result.exitCode ?? "signal")} • ${result.hits.length} hit(s) • ${result.durationMs}ms`,
    result.test,
    "",
    "Traversal",
  ];

  for (const item of collapseConsecutiveHits(result.hits)) {
    const hit = item.hit;
    const label = item.count === 1 ? `#${item.start}` : `#${item.start}-${item.end} ×${item.count}`;
    lines.push(`${label} ${hit.frame.name}  ${relativePath(result.cwd, hit.frame.path ?? "")}:${hit.frame.line}`);
    for (const variable of selectSummaryLocals(hit).slice(0, 6)) {
      lines.push(`  ${variable.name} = ${compactSummaryValue(variable.value, 240)}`);
    }
  }

  const outputSummary = summarizeProcessOutput(result);
  if (outputSummary) lines.push("", outputSummary);
  return lines.join("\n");
}

async function captureHit(dap: DapClient, _cwd: string, threadId: number, reason: string, timeoutMs: number): Promise<BreakpointHit> {
  const stackResponse = await dap.request<{ stackFrames?: DapStackFrame[] }>(
    "stackTrace",
    { threadId, startFrame: 0, levels: 12 },
    timeoutMs,
  );
  const stack = (stackResponse.body?.stackFrames ?? []).map(toFrameSnapshot);
  const frame = stack[0];
  if (!frame) throw new Error("debugpy stopped without a stack frame");

  const scopesResponse = await dap.request<{ scopes?: DapScope[] }>("scopes", { frameId: frame.id }, timeoutMs);
  const localsScope = (scopesResponse.body?.scopes ?? []).find((scope) => scope.name === "Locals") ?? scopesResponse.body?.scopes?.[0];
  let locals: VariableSnapshot[] = [];
  if (localsScope?.variablesReference) {
    const variablesResponse = await dap.request<{ variables?: DapVariable[] }>(
      "variables",
      { variablesReference: localsScope.variablesReference, start: 0, count: 50 },
      timeoutMs,
    );
    locals = (variablesResponse.body?.variables ?? []).map((variable) => ({
      name: variable.name,
      value: compactVariableValue(variable.value),
      type: variable.type,
      evaluateName: variable.evaluateName,
      variablesReference: variable.variablesReference,
    }));
  }

  return { reason, threadId, frame, stack, locals };
}

function toFrameSnapshot(frame: DapStackFrame): StackFrameSnapshot {
  return {
    id: frame.id,
    name: frame.name,
    path: frame.source?.path,
    line: frame.line,
    column: frame.column,
  };
}

async function normalizeBreakpoints(cwd: string, breakpoints: PythonBreakpoint[]): Promise<PythonBreakpoint[]> {
  const root = await realpath(cwd);
  const normalized: PythonBreakpoint[] = [];
  for (const breakpoint of breakpoints) {
    const path = await realpath(resolve(cwd, breakpoint.path));
    assertInside(root, path);
    normalized.push({ path, line: breakpoint.line });
  }
  return normalized;
}

function assertInside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`))) return;
  throw new Error(`Breakpoint path must stay inside ${root}: ${path}`);
}

function groupBreakpointLines(breakpoints: PythonBreakpoint[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const breakpoint of breakpoints) {
    const lines = groups.get(breakpoint.path) ?? [];
    lines.push(breakpoint.line);
    groups.set(
      breakpoint.path,
      [...new Set(lines)].sort((a, b) => a - b),
    );
  }
  return groups;
}

async function buildRunnerCommand(options: PythonDebugOptions, port: number): Promise<RunnerCommand> {
  const python = options.python ?? "python3";
  const debugpyArgs = [
    "-Xfrozen_modules=off",
    "-m",
    "debugpy",
    "--listen",
    `127.0.0.1:${port}`,
    "--wait-for-client",
    "-m",
    "pytest",
    ...(options.pytestArgs ?? ["-q"]),
    options.test,
  ];

  const runner = options.runner ?? "auto";
  if (runner === "direct" || (runner === "auto" && (await canImportDebugpy(python, options.cwd)))) {
    return { command: python, args: debugpyArgs };
  }

  if (runner === "uv" || (runner === "auto" && (await commandExists("uv")))) {
    const packages = unique(["debugpy", ...(options.uvPackages ?? [])]);
    return {
      command: "uv",
      args: [
        "run",
        ...(options.uvNoProject ? ["--no-project"] : []),
        ...packages.flatMap((pkg) => ["--with", pkg]),
        python,
        ...debugpyArgs,
      ],
    };
  }

  return { command: python, args: debugpyArgs };
}

async function canImportDebugpy(python: string, cwd: string): Promise<boolean> {
  try {
    await execFile(python, ["-c", "import debugpy"], { cwd, timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile(command, ["--version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolvePort(address.port);
        else reject(new Error("Could not allocate debugpy port"));
      });
    });
    server.on("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function limitText(text: string, max: number, side: "head" | "tail"): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return side === "head" ? `${text.slice(0, max)}\n[truncated ${omitted} chars]` : `[truncated ${omitted} chars]\n${text.slice(-max)}`;
}

function compactVariableValue(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_VARIABLE_VALUE_CHARS) return singleLine;
  return `${singleLine.slice(0, MAX_VARIABLE_VALUE_CHARS)}... [truncated ${singleLine.length - MAX_VARIABLE_VALUE_CHARS} chars]`;
}

type CollapsedHit = {
  start: number;
  end: number;
  count: number;
  hit: BreakpointHit;
  signature: string;
};

function collapseConsecutiveHits(hits: BreakpointHit[]): CollapsedHit[] {
  const collapsed: CollapsedHit[] = [];
  for (const [index, hit] of hits.entries()) {
    const signature = hitSignature(hit);
    const last = collapsed[collapsed.length - 1];
    if (last?.signature === signature) {
      last.end = index + 1;
      last.count += 1;
      continue;
    }
    collapsed.push({ start: index + 1, end: index + 1, count: 1, hit, signature });
  }
  return collapsed;
}

function hitSignature(hit: BreakpointHit): string {
  const localSignature = selectSummaryLocals(hit)
    .map((variable) => `${variable.name}=${compactSummaryValue(variable.value, 80)}`)
    .join("|");
  return [hit.reason, hit.frame.path ?? "", hit.frame.line, hit.frame.name, localSignature].join("::");
}

function selectSummaryLocals(hit: BreakpointHit): VariableSnapshot[] {
  const important = hit.locals.filter((variable) => IMPORTANT_LOCAL_NAMES.has(variable.name));
  const fallback = hit.locals.filter((variable) => !IMPORTANT_LOCAL_NAMES.has(variable.name) && !NOISY_LOCAL_NAMES.has(variable.name));
  return [...important, ...fallback].slice(0, MAX_SUMMARY_VARIABLES);
}

function compactSummaryValue(value: string, max = MAX_SUMMARY_VALUE_CHARS): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max)}...`;
}

function summarizeProcessOutput(result: PythonDebugResult): string | undefined {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (!output) return undefined;

  const summaryLine = output
    .split(/\r?\n/)
    .reverse()
    .find((line) => /\b\d+\s+(passed|failed|error|errors|skipped|xfailed|xpassed)\b|FAILED|ERROR|Traceback/i.test(line.trim()));
  if (summaryLine) return `Process output summary: ${compactSummaryValue(summaryLine.trim(), 240)}`;
  return `Process output summary: ${compactSummaryValue(output, 240)}`;
}

function relativePath(cwd: string, path: string): string {
  if (!path) return basename(path);
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function shellish(parts: string[]): string {
  return parts.map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}
