import { type ChildProcessWithoutNullStreams, execFile as execFileCallback, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { connectDap, DapClient } from "./dap";
import { type BreakpointHit, captureHit, type PythonBreakpoint } from "./python";

const execFile = promisify(execFileCallback);

export type BugrunLanguage = "python" | "rust" | "go" | "ts";
export type GenericRunnerCommand = { command: string; args: string[]; adapter: string; note: string };

export type GenericDebugOptions = {
  language: Exclude<BugrunLanguage, "python">;
  cwd: string;
  test: string;
  command?: string;
  testArgs?: string[];
  adapter?: string;
  breakpoints?: PythonBreakpoint[];
  maxHits?: number;
  timeoutMs?: number;
};

export type GenericDebugResult = {
  language: Exclude<BugrunLanguage, "python">;
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

export function parseLanguage(value: unknown): BugrunLanguage {
  if (value === "rust" || value === "go" || value === "ts" || value === "python" || value === undefined) return value ?? "python";
  throw new Error(`Unsupported Bugrun language: ${String(value)}`);
}

export async function buildGenericRunnerCommand(options: GenericDebugOptions): Promise<GenericRunnerCommand> {
  if (options.command?.trim()) return shellCommand(options.command, options.adapter ?? defaultAdapter(options.language));

  switch (options.language) {
    case "rust":
      return {
        command: "cargo",
        args: ["test", ...(options.testArgs ?? []), options.test],
        adapter: options.adapter ?? "lldb-dap",
        note: "Rust cargo test via lldb-dap/CodeLLDB-compatible DAP",
      };
    case "go":
      return {
        command: "dlv",
        args: ["dap", "--listen=127.0.0.1:0", "--", "test", ...(options.testArgs ?? []), options.test],
        adapter: options.adapter ?? "dlv",
        note: "Go go test via Delve DAP",
      };
    case "ts":
      return {
        command: options.adapter ?? "js-debug-adapter",
        args: [],
        adapter: options.adapter ?? "js-debug-adapter",
        note: "TypeScript/JavaScript via vscode-js-debug js-debug-adapter",
      };
  }
}

export async function assertGenericAdapterAvailable(options: GenericDebugOptions): Promise<void> {
  const runner = await buildGenericRunnerCommand(options);
  if (await commandExists(runner.adapter)) return;
  throw new Error(`Bugrun ${options.language} requires ${runner.adapter} on PATH for DAP debugging (${runner.note}).`);
}

export async function runGenericDebug(options: GenericDebugOptions, signal?: AbortSignal): Promise<GenericDebugResult> {
  const startedAt = Date.now();
  const cwd = await realpath(options.cwd);
  const breakpoints = await normalizeBreakpoints(cwd, options.breakpoints ?? []);
  if (!breakpoints.length) throw new Error(`bugrun ${options.language} requires at least one breakpoint (path:line).`);
  await assertGenericAdapterAvailable(options);

  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxHits = options.maxHits ?? 5;
  const deadline = Date.now() + timeoutMs;
  const timeLeft = () => Math.max(1_000, deadline - Date.now());
  const runner = await buildGenericRunnerCommand(options);
  const adapter = await startAdapter(options, runner, signal);
  let dap: DapClient | undefined;

  try {
    dap = adapter.dap;
    await dap.request("initialize", initializeArgs(options.language), timeLeft());
    const launch = dap.request("launch", await launchArgs(options, cwd, adapter.port), timeLeft());
    await dap.waitForEvent((event) => event.event === "initialized", timeLeft());
    for (const [path, lines] of groupBreakpointLines(breakpoints)) {
      await dap.request(
        "setBreakpoints",
        { source: { path }, breakpoints: lines.map((line) => ({ line })), lines, sourceModified: false },
        timeLeft(),
      );
    }
    await dap.request("setExceptionBreakpoints", { filters: [] }, timeLeft());
    await dap.request("configurationDone", {}, timeLeft());
    await launch;

    const hits: BreakpointHit[] = [];
    while (Date.now() < deadline) {
      const event = await Promise.race([
        dap.waitForEvent<{ reason?: string; threadId?: number }>(
          (candidate) => candidate.event === "stopped" || candidate.event === "terminated" || candidate.event === "exited",
          timeLeft(),
        ),
        adapter.exited.then(() => undefined),
      ]);
      if (!event || event.event === "terminated" || event.event === "exited") break;
      const threadId = event.body?.threadId;
      if (typeof threadId !== "number") break;
      if (hits.length < maxHits) hits.push(await captureHit(dap, cwd, threadId, event.body?.reason ?? "stopped", timeLeft()));
      await dap.request("continue", { threadId }, timeLeft());
    }

    return {
      language: options.language,
      cwd,
      test: options.test,
      command: runner.command,
      args: runner.args,
      breakpoints,
      hits,
      exitCode: adapter.exitCode(),
      signal: adapter.signal(),
      stdout: adapter.stdout(),
      stderr: adapter.stderr(),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    dap?.dispose();
    await adapter.stop();
  }
}

function initializeArgs(language: Exclude<BugrunLanguage, "python">) {
  return {
    adapterID: language === "go" ? "go" : language === "rust" ? "lldb" : "pwa-node",
    clientID: "pi-bugrun",
    pathFormat: "path",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsRunInTerminalRequest: false,
  };
}

async function launchArgs(options: GenericDebugOptions, cwd: string, port?: number) {
  const override = options.command?.trim() ? splitCommand(options.command) : undefined;
  if (options.language === "go") {
    if (override) throw new Error("Bugrun Go does not support arbitrary command overrides; use test/testArgs with dlv dap mode=test.");
    return {
      name: "bugrun go test",
      type: "go",
      request: "launch",
      mode: "test",
      program: cwd,
      args: [...(options.testArgs ?? []), options.test],
    };
  }
  if (options.language === "rust") {
    const [program, ...args] = override ?? [await buildRustTestExecutable(cwd, options), options.test];
    return {
      name: "bugrun cargo test",
      type: "lldb",
      request: "launch",
      program,
      args,
      cwd,
    };
  }
  const [runtimeExecutable, ...runtimeArgs] = override ?? ["node", "--test", ...(options.testArgs ?? []), options.test];
  return {
    name: "bugrun ts test",
    type: "pwa-node",
    request: "launch",
    cwd,
    runtimeExecutable,
    runtimeArgs,
    console: "internalConsole",
    port,
  };
}

type AdapterProcess = {
  dap: DapClient;
  port?: number;
  exited: Promise<void>;
  exitCode: () => number | null;
  signal: () => NodeJS.Signals | null;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<void>;
};

async function startAdapter(options: GenericDebugOptions, runner: GenericRunnerCommand, signal?: AbortSignal): Promise<AdapterProcess> {
  if (options.language === "go") {
    const port = await getFreePort();
    const child = spawn(runner.adapter, ["dap", `--listen=127.0.0.1:${port}`], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    }) as ChildProcessWithoutNullStreams;
    return processAdapter(child, await connectDap("127.0.0.1", port, 15_000, signal), port);
  }

  const child = spawn(runner.adapter, [], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], signal }) as ChildProcessWithoutNullStreams;
  return processAdapter(child, new DapClient(child.stdin, child.stdout));
}

function processAdapter(child: ChildProcessWithoutNullStreams, dap: DapClient, port?: number): AdapterProcess {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.stdout.on("data", (chunk) => (stdout = limitText(stdout + chunk.toString("utf8"), 100_000)));
  child.stderr.on("data", (chunk) => (stderr = limitText(stderr + chunk.toString("utf8"), 100_000)));
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolveExit();
    }),
  );
  return {
    dap,
    port,
    exited,
    exitCode: () => exitCode,
    signal: () => exitSignal,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: async () => {
      if (exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([exited, delay(1_000)]);
      if (exitCode === null) child.kill("SIGKILL");
    },
  };
}

async function buildRustTestExecutable(cwd: string, options: GenericDebugOptions): Promise<string> {
  const args = ["test", "--no-run", "--message-format=json", ...(options.testArgs ?? []), options.test];
  try {
    const { stdout } = await execFile("cargo", args, { cwd, timeout: options.timeoutMs ?? 60_000, maxBuffer: 10_000_000 });
    const executables = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { reason?: string; executable?: string };
        } catch {
          return undefined;
        }
      })
      .filter((message): message is { executable: string } => Boolean(message?.executable));
    const executable = executables.at(-1)?.executable;
    if (!executable) throw new Error("cargo did not report a test executable");
    return executable;
  } catch (error) {
    throw new Error(
      `Bugrun Rust failed to build test executable with cargo ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function defaultAdapter(language: Exclude<BugrunLanguage, "python">): string {
  if (language === "rust") return "lldb-dap";
  if (language === "go") return "dlv";
  return "js-debug-adapter";
}

function shellCommand(command: string, adapter: string): GenericRunnerCommand {
  const [executable, ...args] = splitCommand(command);
  if (!executable) throw new Error("Bugrun command override must include an executable.");
  return { command: executable, args, adapter, note: "User-supplied Bugrun command" };
}

function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile(command, ["--version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function normalizeBreakpoints(cwd: string, breakpoints: PythonBreakpoint[]): Promise<PythonBreakpoint[]> {
  const root = await realpath(cwd);
  const normalized: PythonBreakpoint[] = [];
  for (const breakpoint of breakpoints) {
    const path = await realpath(resolve(cwd, breakpoint.path));
    const rel = relative(root, path);
    if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`)))
      throw new Error(`Breakpoint path must stay inside ${root}: ${path}`);
    normalized.push({ path, line: breakpoint.line });
  }
  return normalized;
}

function groupBreakpointLines(breakpoints: PythonBreakpoint[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const breakpoint of breakpoints)
    groups.set(
      breakpoint.path,
      [...new Set([...(groups.get(breakpoint.path) ?? []), breakpoint.line])].sort((a, b) => a - b),
    );
  return groups;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("Could not allocate DAP port")),
      );
    });
    server.on("error", reject);
  });
}

function limitText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
