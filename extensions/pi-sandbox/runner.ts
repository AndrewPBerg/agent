import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { existingProtectedDirectories, sensitiveFilesForSandbox, workspaceAndGitMounts } from "./policy";

const DEFAULT_CAPTURE_LIMIT_BYTES = 64 * 1024;

const SAFE_ENVIRONMENT_NAMES = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TZ",
  "USER",
]);

export interface SandboxRunOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  bwrapPath?: string;
  signal?: AbortSignal;
  timeout?: number;
  onData?: (data: Buffer) => void;
  captureLimitBytes?: number;
  maxOutputBytes?: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputLimitReached: boolean;
}

function sandboxEnvironment(env: NodeJS.ProcessEnv, home: string, cacheRoot: string): Record<string, string> {
  const result: Record<string, string> = {
    HOME: home,
    XDG_CACHE_HOME: join(cacheRoot, "xdg"),
    npm_config_cache: join(cacheRoot, "npm"),
    UV_CACHE_DIR: join(cacheRoot, "uv"),
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    CARGO_HOME: join(cacheRoot, "cargo"),
    GOCACHE: join(cacheRoot, "go-build"),
    GOMODCACHE: join(cacheRoot, "go-mod"),
  };

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (SAFE_ENVIRONMENT_NAMES.has(name) || name.startsWith("LC_")) result[name] = value;
  }
  return result;
}

async function buildBubblewrapArgs(options: SandboxRunOptions): Promise<{ bwrapPath: string; args: string[]; hostEnv: NodeJS.ProcessEnv }> {
  const home = resolve(options.home ?? process.env.HOME ?? "/tmp/pi-sandbox-home");
  const bwrapPath = options.bwrapPath ?? process.env.PI_BWRAP_PATH ?? "/usr/bin/bwrap";
  await access(bwrapPath, fsConstants.X_OK);

  const cacheRoot = join(home, ".pi", "agent", "sandbox-cache");
  await mkdir(cacheRoot, { recursive: true });
  for (const name of ["xdg", "npm", "uv", "pip", "cargo", "go-build", "go-mod"]) {
    await mkdir(join(cacheRoot, name), { recursive: true });
  }

  const emptySecretFile = join(cacheRoot, "empty-secret");
  try {
    await chmod(emptySecretFile, 0o600);
  } catch {
    // The placeholder is created on the first sandboxed invocation.
  }
  await writeFile(emptySecretFile, "");
  await chmod(emptySecretFile, 0o444);

  const environment = sandboxEnvironment(options.env ?? process.env, home, cacheRoot);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];

  for (const path of await workspaceAndGitMounts(options.cwd)) args.push("--bind", path, path);
  args.push("--bind", cacheRoot, cacheRoot);

  const [protectedDirectories, sensitiveFiles] = await Promise.all([
    existingProtectedDirectories(home),
    sensitiveFilesForSandbox(options.cwd, home),
  ]);
  for (const path of sensitiveFiles) args.push("--ro-bind", emptySecretFile, path);
  for (const path of protectedDirectories) args.push("--tmpfs", path);

  args.push("--clearenv");
  for (const [name, value] of Object.entries(environment)) args.push("--setenv", name, value);
  args.push("--chdir", resolve(options.cwd), "--", options.executable, ...options.args);
  const argumentBytes = args.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
  if (argumentBytes > 1024 * 1024) {
    throw new Error("Sandbox policy produced more than 1MB of Bubblewrap arguments; refusing to run rather than leave paths unmasked.");
  }

  return {
    bwrapPath,
    args,
    hostEnv: {
      HOME: home,
      LANG: environment.LANG ?? "C.UTF-8",
      PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    },
  };
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runSandboxedProcess(options: SandboxRunOptions): Promise<SandboxRunResult> {
  if (options.signal?.aborted) throw new Error("aborted");
  const invocation = await buildBubblewrapArgs(options);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.bwrapPath, invocation.args, {
      cwd: options.cwd,
      detached: true,
      env: invocation.hostEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let outputBytes = 0;
    let outputLimitReached = false;
    let timedOut = false;
    const captureLimit = options.captureLimitBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
    const timeoutHandle =
      options.timeout && options.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, options.timeout * 1_000)
        : undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => killProcessGroup(child);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
      outputBytes += chunk.byteLength;
      const remaining = Math.max(0, captureLimit - capturedBytes);
      if (remaining > 0) {
        const text = chunk.subarray(0, remaining).toString();
        if (stream === "stdout") stdout += text;
        else stderr += text;
        capturedBytes += Math.min(remaining, chunk.byteLength);
      }
      options.onData?.(chunk);
      if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes && !outputLimitReached) {
        outputLimitReached = true;
        killProcessGroup(child);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (options.signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
      else resolvePromise({ exitCode, stdout, stderr, outputLimitReached });
    });
  });
}

export function createSandboxedBashOperations(options: { home?: string; bwrapPath?: string } = {}): BashOperations {
  return {
    async exec(command, cwd, execution) {
      const result = await runSandboxedProcess({
        executable: "/usr/bin/bash",
        args: ["-lc", command],
        cwd,
        env: execution.env,
        home: options.home,
        bwrapPath: options.bwrapPath,
        signal: execution.signal,
        timeout: execution.timeout,
        onData: execution.onData,
      });
      return { exitCode: result.exitCode };
    },
  };
}
