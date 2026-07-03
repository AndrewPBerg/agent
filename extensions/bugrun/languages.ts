import { type ChildProcessWithoutNullStreams, execFile as execFileCallback, spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
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
        args: ["dap", "--listen=127.0.0.1:0"],
        adapter: options.adapter ?? "dlv",
        note: "Go tests via Delve DAP launch mode=test",
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
    let debuggeeExitCode: number | null = null;
    let sawDebuggeeExit = false;
    while (Date.now() < deadline) {
      const event = await Promise.race([
        dap.waitForEvent<{ reason?: string; threadId?: number; exitCode?: number }>(
          (candidate) => candidate.event === "stopped" || candidate.event === "terminated" || candidate.event === "exited",
          timeLeft(),
        ),
        adapter.exited.then(() => undefined),
      ]);
      if (!event) break;
      if (event.event === "terminated" || event.event === "exited") {
        sawDebuggeeExit = true;
        if (typeof event.body?.exitCode === "number") debuggeeExitCode = event.body.exitCode;
        break;
      }
      const threadId = event.body?.threadId;
      if (typeof threadId !== "number") break;
      if (hits.length < maxHits) hits.push(await captureHit(dap, cwd, threadId, event.body?.reason ?? "stopped", timeLeft()));
      await dap.request("continue", { threadId }, timeLeft());
    }

    const adapterExitCode = adapter.exitCode();
    const exitCode = debuggeeExitCode ?? adapterExitCode ?? (sawDebuggeeExit ? 0 : null);
    return {
      language: options.language,
      cwd,
      test: options.test,
      command: runner.command,
      args: runner.args,
      breakpoints,
      hits,
      exitCode,
      signal: exitCode === null ? adapter.signal() : null,
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

async function launchArgs(options: GenericDebugOptions, cwd: string, _port?: number) {
  const override = options.command?.trim() ? splitCommand(options.command) : undefined;
  if (options.language === "go") {
    if (override) throw new Error("Bugrun Go does not support arbitrary command overrides; use test/testArgs with dlv dap mode=test.");
    const target = resolveGoTestTarget(cwd, options.test, normalizeGoTestBinaryArgs(options.testArgs ?? []));
    return {
      name: "bugrun go test",
      type: "go",
      request: "launch",
      mode: "test",
      program: target.program,
      args: target.args,
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

  if (options.language === "ts") {
    const adapter = await resolveAdapterExecutable(runner.adapter);
    const tcpMode = await shouldUseTcpJsDebugAdapter(adapter);
    if (tcpMode) {
      const port = await getFreePort();
      const launch = await jsDebugServerLaunch(adapter, port);
      const child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      }) as ChildProcessWithoutNullStreams;
      return processAdapter(child, await connectDap("127.0.0.1", port, 15_000, signal), port, { killProcessGroup: true });
    }

    const child = spawn(adapter, [], {
      cwd: options.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    }) as ChildProcessWithoutNullStreams;
    return processAdapter(child, new DapClient(child.stdin, child.stdout), undefined, { killProcessGroup: true });
  }

  const child = spawn(runner.adapter, [], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], signal }) as ChildProcessWithoutNullStreams;
  return processAdapter(child, new DapClient(child.stdin, child.stdout));
}

async function resolveAdapterExecutable(adapter: string): Promise<string> {
  if (adapter.includes("/") || adapter.includes("\\")) {
    try {
      return await realpath(adapter);
    } catch {
      return adapter;
    }
  }
  try {
    const { stdout } = await execFile("sh", ["-lc", `command -v -- ${shellQuote(adapter)}`], { timeout: 3_000 });
    return stdout.trim().split(/\r?\n/)[0] || adapter;
  } catch {
    return adapter;
  }
}

async function shouldUseTcpJsDebugAdapter(adapter: string): Promise<boolean> {
  if (/(^|[/\\])dapDebugServer\.js$/.test(adapter)) return true;
  try {
    const content = await readFile(adapter, "utf8");
    if (content.includes("MCP Client -> DAP Server") || content.includes("process.stdin.on('data'")) return false;
    if (content.includes("dapDebugServer.js")) return true;
    return content.includes("listening at") && content.includes("socket path") && content.includes("host=localhost");
  } catch {
    return false;
  }
}

async function jsDebugServerLaunch(adapter: string, port: number): Promise<{ command: string; args: string[] }> {
  const content = await readFile(adapter, "utf8").catch(() => "");
  const needsNode = adapter.endsWith(".js") || content.startsWith('"use strict"') || content.startsWith("'use strict'");
  return needsNode ? { command: process.execPath, args: [adapter, String(port)] } : { command: adapter, args: [String(port)] };
}

function normalizeGoTestBinaryArgs(args: string[]) {
  return args.map((arg) => {
    if (arg === "-run") return "-test.run";
    if (arg.startsWith("-run=")) return `-test.run=${arg.slice("-run=".length)}`;
    if (arg === "-v") return "-test.v";
    return arg;
  });
}

function resolveGoTestTarget(cwd: string, test: string, testArgs: string[]) {
  const trimmed = test.trim();
  const isPackageTarget = trimmed === "." || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("/");
  if (isPackageTarget) return { program: resolve(cwd, trimmed), args: testArgs };
  const hasRunFilter = testArgs.some((arg) => arg === "-test.run" || arg.startsWith("-test.run="));
  return { program: cwd, args: hasRunFilter ? testArgs : ["-test.run", trimmed, ...testArgs] };
}

function processAdapter(
  child: ChildProcessWithoutNullStreams,
  dap: DapClient,
  port?: number,
  options: { killProcessGroup?: boolean } = {},
): AdapterProcess {
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
      killAdapterProcess(child, options.killProcessGroup, "SIGTERM");
      await Promise.race([exited, delay(1_000)]);
      if (exitCode === null) killAdapterProcess(child, options.killProcessGroup, "SIGKILL");
    },
  };
}

function killAdapterProcess(child: ChildProcessWithoutNullStreams, killProcessGroup: boolean | undefined, signal: NodeJS.Signals) {
  if (killProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing just the adapter process when process groups are unavailable.
    }
  }
  child.kill(signal);
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
    await execFile("sh", ["-lc", `command -v -- ${shellQuote(command)}`], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
