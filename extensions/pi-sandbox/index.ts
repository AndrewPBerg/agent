import { constants as fsConstants } from "node:fs";
import { access as fsAccess, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createGrepTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { MAILBOX_EXTERNAL_JOB_EVENT, type MailboxJobSnapshot } from "../subagent-mailbox/protocol";
import { allowedCanonicalPath, HOST_EXECUTION_TOOLS, normalizeToolPath, protectedPathReason } from "./policy";
import { createSandboxedBashOperations, resetSandboxCaches, runSandboxedProcess } from "./runner";

const STATE_ENTRY = "pi-sandbox-state";
const BASH_YIELD_CONFIG_ENTRY = "bash-mailbox-config";
const BASH_JOB_ENTRY = "bash-mailbox-job";
const BASH_MAILBOX_TYPE = "bash-mailbox";
const DEFAULT_BASH_YIELD_MS = 10_000;
const MAX_BASH_YIELD_SECONDS = 300;
const TERMINAL_BATCH_MS = 250;
const MAX_MAILBOX_OUTPUT_CHARS = 20_000;
const FILE_TOOLS = new Set(["edit", "find", "grep", "ls", "read", "write"]);
const DEFAULT_GREP_LIMIT = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;

interface StateEntry {
  type?: string;
  customType?: string;
  data?: { enabled?: unknown; version?: unknown; yieldMs?: unknown; job?: unknown };
}

type BashJobStatus = "running" | "completed" | "failed" | "cancelled";

type BashJob = {
  id: string;
  command: string;
  cwd: string;
  status: BashJobStatus;
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  controller?: AbortController;
  cancellationRequested?: boolean;
  generation: number;
};

type PiSandboxDependencies = {
  createBashTool: typeof createBashTool;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
};

function boundedTail(value: string, maxChars = MAX_MAILBOX_OUTPUT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `[${value.length - maxChars} earlier characters omitted]\n${value.slice(-maxChars)}`;
}

function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n")
    .trim();
}

function bashJobSnapshot(job: BashJob): MailboxJobSnapshot {
  return {
    id: job.id,
    kind: "bash",
    agent: "bash",
    task: job.command,
    cwd: job.cwd,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    output: job.output,
    error: job.error,
  };
}

function restoredState(entries: StateEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.customType === STATE_ENTRY && typeof entry.data?.enabled === "boolean") return entry.data.enabled;
  }
  return false;
}

function restoredBashYieldMs(entries: StateEntry[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.customType !== BASH_YIELD_CONFIG_ENTRY || entry.data?.version !== 1) continue;
    const value = entry.data.yieldMs;
    if (value === null) return undefined;
    if (typeof value === "number" && Number.isFinite(value) && value >= 1_000 && value <= MAX_BASH_YIELD_SECONDS * 1_000) return value;
  }
  return DEFAULT_BASH_YIELD_MS;
}

function updateStatus(ctx: any, enabled: boolean, bwrapAvailable: boolean): void {
  const text = enabled ? (bwrapAvailable ? "sandbox: on" : "sandbox: unavailable (fail-closed)") : "sandbox: off (host tools)";
  ctx.ui?.setStatus?.("pi-sandbox", text);
}

function truncateOutput(output: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = output.split("\n");
  let text = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
    text = Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
    truncated = true;
  }
  return { text, truncated };
}

function imageMimeType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}

function guardedReadOperations(cwd: string) {
  return {
    async access(path: string) {
      await fsAccess(await allowedCanonicalPath(path, cwd), fsConstants.R_OK);
    },
    async readFile(path: string) {
      return readFile(await allowedCanonicalPath(path, cwd));
    },
    async detectImageMimeType(path: string) {
      const allowedPath = await allowedCanonicalPath(path, cwd);
      return imageMimeType(allowedPath);
    },
  };
}

function guardedEditOperations(cwd: string) {
  return {
    async access(path: string) {
      await fsAccess(await allowedCanonicalPath(path, cwd), fsConstants.R_OK | fsConstants.W_OK);
    },
    async readFile(path: string) {
      return readFile(await allowedCanonicalPath(path, cwd));
    },
    async writeFile(path: string, content: string) {
      await writeFile(await allowedCanonicalPath(path, cwd), content);
    },
  };
}

function guardedWriteOperations(cwd: string) {
  return {
    async mkdir(path: string) {
      await mkdir(await allowedCanonicalPath(path, cwd), { recursive: true });
    },
    async writeFile(path: string, content: string) {
      await writeFile(await allowedCanonicalPath(path, cwd), content);
    },
  };
}

function grepArguments(params: any): string[] {
  const args = ["--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.context && params.context > 0) args.push("--context", String(params.context));
  if (params.glob) args.push("--glob", String(params.glob));
  args.push("--", String(params.pattern), String(params.path || ".").replace(/^@/, ""));
  return args;
}

export function createPiSandbox(pi: ExtensionAPI, dependencyOverrides: Partial<PiSandboxDependencies> = {}) {
  const dependencies: PiSandboxDependencies = {
    createBashTool,
    now: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...dependencyOverrides,
  };
  let sandboxEnabled = false;
  let bwrapAvailable = false;
  let bashYieldMs: number | undefined = DEFAULT_BASH_YIELD_MS;
  let bashGeneration = 0;
  let nextBashJob = 1;
  let sessionCtx: any;
  let terminalBatchTimer: ReturnType<typeof setTimeout> | undefined;
  const bashJobs = new Map<string, BashJob>();
  const pendingTerminalJobs: BashJob[] = [];
  const initialCwd = process.cwd();
  const baseBash = dependencies.createBashTool(initialCwd);
  const baseEdit = createEditTool(initialCwd);
  const baseGrep = createGrepTool(initialCwd);
  const baseRead = createReadTool(initialCwd);
  const baseWrite = createWriteTool(initialCwd);

  const emitBashJob = (job: BashJob, persist = true) => {
    const snapshot = bashJobSnapshot(job);
    if (persist) pi.appendEntry(BASH_JOB_ENTRY, { version: 1, job: snapshot });
    pi.events.emit(MAILBOX_EXTERNAL_JOB_EVENT, { job: snapshot });
    const running = [...bashJobs.values()].filter((candidate) => candidate.status === "running").length;
    sessionCtx?.ui?.setStatus?.(BASH_MAILBOX_TYPE, running ? `bash:${running}` : undefined);
  };

  const flushTerminalBatch = () => {
    terminalBatchTimer = undefined;
    const jobs = pendingTerminalJobs.splice(0).filter((job) => job.generation === bashGeneration);
    if (!jobs.length) return;
    const blocks = jobs.map((job) => {
      const result = boundedTail(job.output?.trim() || job.error?.trim() || "(no output)");
      return [`Job: ${job.id}`, `Status: ${job.status}`, `Command: ${job.command}`, "", result].join("\n");
    });
    pi.sendMessage(
      {
        customType: BASH_MAILBOX_TYPE,
        content: [
          `${jobs.length} background bash job${jobs.length === 1 ? "" : "s"} reached a terminal state.`,
          "The commands were allowed to continue after the bash tool yielded; do not rerun them.",
          "",
          blocks.join("\n\n---\n\n"),
          "",
          "Continue from these results and verify the relevant outcome before declaring success.",
        ].join("\n"),
        display: true,
        details: { jobs: jobs.map(bashJobSnapshot) },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const queueTerminal = (job: BashJob) => {
    pendingTerminalJobs.push(job);
    if (terminalBatchTimer) return;
    terminalBatchTimer = dependencies.setTimer(flushTerminalBatch, TERMINAL_BATCH_MS);
  };

  const finalizeBashJob = (job: BashJob, outcome: { ok: true; result: unknown } | { ok: false; error: unknown }) => {
    if (job.status !== "running") return;
    job.completedAt = dependencies.now();
    job.controller = undefined;
    if (job.cancellationRequested) {
      job.status = "cancelled";
      job.error = "Background bash job was cancelled.";
    } else if (outcome.ok) {
      job.status = "completed";
      job.output = boundedTail(toolResultText(outcome.result) || "(no output)");
    } else {
      job.status = "failed";
      job.error = boundedTail(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
    }
    emitBashJob(job);
    if (job.generation === bashGeneration) queueTerminal(job);
  };

  const runBash = async (id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
    if (sandboxEnabled && !bwrapAvailable) {
      throw new Error("Pi sandbox is enabled, but Bubblewrap is unavailable. Tool execution failed closed.");
    }
    const tool = sandboxEnabled
      ? dependencies.createBashTool(ctx.cwd, { operations: createSandboxedBashOperations() })
      : dependencies.createBashTool(ctx.cwd);
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });

    let yielded = false;
    let latestPartial: unknown;
    const startedAt = dependencies.now();
    const yieldAfterMs = bashYieldMs;
    const completion = Promise.resolve()
      .then(() =>
        tool.execute(id, params, controller.signal, (partial: unknown) => {
          latestPartial = partial;
          if (!yielded) onUpdate?.(partial);
        }),
      )
      .then(
        (result) => ({ ok: true as const, result }),
        (error) => ({ ok: false as const, error }),
      );

    if (yieldAfterMs === undefined) {
      const outcome = await completion;
      signal?.removeEventListener("abort", abortFromParent);
      if (outcome.ok) return outcome.result;
      throw outcome.error;
    }

    let yieldTimer: ReturnType<typeof setTimeout> | undefined;
    const race = await Promise.race([
      completion.then((outcome) => ({ type: "completed" as const, outcome })),
      new Promise<{ type: "yielded" }>((resolve) => {
        yieldTimer = dependencies.setTimer(() => resolve({ type: "yielded" }), yieldAfterMs);
      }),
    ]);
    if (race.type === "completed") {
      if (yieldTimer) dependencies.clearTimer(yieldTimer);
      signal?.removeEventListener("abort", abortFromParent);
      if (race.outcome.ok) return race.outcome.result;
      throw race.outcome.error;
    }

    yielded = true;
    signal?.removeEventListener("abort", abortFromParent);
    const job: BashJob = {
      id: `bash-${startedAt}-${nextBashJob++}`,
      command: String(params.command ?? ""),
      cwd: ctx.cwd,
      status: "running",
      startedAt,
      controller,
      generation: bashGeneration,
    };
    bashJobs.set(job.id, job);
    emitBashJob(job);
    void completion.then((outcome) => finalizeBashJob(job, outcome));

    const partial = toolResultText(latestPartial);
    const status = [
      `Command still running after ${(yieldAfterMs / 1_000).toFixed(0)} seconds.`,
      `Background job: ${job.id}`,
      "Completion will be delivered automatically through the mailbox; do not poll or rerun the command.",
    ].join("\n");
    return {
      content: [{ type: "text" as const, text: partial ? `${partial}\n\n${status}` : status }],
      details: { backgroundJob: bashJobSnapshot(job) },
    };
  };

  pi.registerTool({
    ...baseRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled) return createReadTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const tool = createReadTool(ctx.cwd, { operations: guardedReadOperations(ctx.cwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled) return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const tool = createWriteTool(ctx.cwd, { operations: guardedWriteOperations(ctx.cwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled) return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const tool = createEditTool(ctx.cwd, { operations: guardedEditOperations(ctx.cwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseBash,
    label: "bash (session sandbox)",
    execute: runBash,
  });

  pi.registerTool({
    ...baseGrep,
    label: "grep (session sandbox)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled) return createGrepTool(ctx.cwd).execute(id, params, signal, onUpdate);
      if (!bwrapAvailable) throw new Error("Pi sandbox is enabled, but Bubblewrap is unavailable. Tool execution failed closed.");

      const reason = await protectedPathReason(String(params.path || "."), ctx.cwd);
      if (reason) throw new Error(`Sandbox blocked grep path: ${reason}`);

      const result = await runSandboxedProcess({
        executable: "/usr/bin/rg",
        args: grepArguments(params),
        cwd: ctx.cwd,
        signal,
        captureLimitBytes: MAX_OUTPUT_BYTES,
        maxOutputBytes: 256 * 1024,
      });
      if (result.exitCode === 1 && !result.outputLimitReached) {
        return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      }
      if (result.exitCode !== 0 && !result.outputLimitReached) {
        throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
      }

      const limit = Math.max(1, Number(params.limit ?? DEFAULT_GREP_LIMIT));
      const output = truncateOutput(result.stdout.replace(/\n$/, ""), limit);
      return {
        content: [{ type: "text" as const, text: output.text || "No matches found" }],
        details: output.truncated || result.outputLimitReached ? { matchLimitReached: limit } : undefined,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    resetSandboxCaches();
    bashGeneration += 1;
    sessionCtx = ctx;
    const entries = (ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries()) as StateEntry[];
    sandboxEnabled = restoredState(entries);
    bashYieldMs = restoredBashYieldMs(entries);
    bashJobs.clear();
    const restoredJobs = new Map<string, BashJob>();
    for (const entry of entries) {
      if (entry.customType !== BASH_JOB_ENTRY || entry.data?.version !== 1 || !entry.data.job || typeof entry.data.job !== "object")
        continue;
      const snapshot = entry.data.job as Partial<MailboxJobSnapshot>;
      if (
        snapshot.kind !== "bash" ||
        typeof snapshot.id !== "string" ||
        typeof snapshot.task !== "string" ||
        typeof snapshot.cwd !== "string" ||
        typeof snapshot.startedAt !== "number" ||
        !["running", "completed", "failed", "cancelled"].includes(String(snapshot.status))
      )
        continue;
      restoredJobs.set(snapshot.id, {
        id: snapshot.id,
        command: snapshot.task,
        cwd: snapshot.cwd,
        status: snapshot.status as BashJobStatus,
        startedAt: snapshot.startedAt,
        completedAt: snapshot.completedAt,
        output: snapshot.output,
        error: snapshot.error,
        generation: bashGeneration,
      });
    }
    for (const job of restoredJobs.values()) {
      bashJobs.set(job.id, job);
      if (job.status === "running") {
        job.status = "failed";
        job.completedAt = dependencies.now();
        job.error = "Background bash process was not recoverable after session restore.";
        emitBashJob(job);
      } else {
        emitBashJob(job, false);
      }
    }
    const bwrapPath = process.env.PI_BWRAP_PATH ?? "/usr/bin/bwrap";
    try {
      await fsAccess(bwrapPath, fsConstants.X_OK);
      bwrapAvailable = true;
    } catch {
      bwrapAvailable = false;
      if (sandboxEnabled) ctx.ui?.notify?.(`Bubblewrap unavailable at ${bwrapPath}; sandboxed process tools will fail closed.`, "error");
    }
    updateStatus(ctx, sandboxEnabled, bwrapAvailable);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    bashGeneration += 1;
    sessionCtx = undefined;
    if (terminalBatchTimer) dependencies.clearTimer(terminalBatchTimer);
    terminalBatchTimer = undefined;
    pendingTerminalJobs.length = 0;
    const completedAt = dependencies.now();
    for (const job of bashJobs.values()) {
      if (job.status !== "running") continue;
      job.cancellationRequested = true;
      job.status = "cancelled";
      job.completedAt = completedAt;
      job.error = "Parent session ended before the background bash command completed.";
      pi.appendEntry(BASH_JOB_ENTRY, { version: 1, job: bashJobSnapshot(job) });
      job.controller?.abort();
      job.controller = undefined;
    }
    ctx.ui?.setStatus?.("pi-sandbox", undefined);
    ctx.ui?.setStatus?.(BASH_MAILBOX_TYPE, undefined);
  });

  pi.on("user_bash", async (_event, _ctx) => {
    if (!sandboxEnabled) return undefined;
    if (!bwrapAvailable) {
      return {
        result: {
          output: "Pi sandbox is enabled, but Bubblewrap is unavailable. Command blocked.",
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
    return { operations: createSandboxedBashOperations() };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return undefined;

    if (HOST_EXECUTION_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool ${event.toolName} starts host processes and is not sandbox-routed. Only you can run /is_sandboxed false for this session.`,
      };
    }

    if (!FILE_TOOLS.has(event.toolName)) return undefined;
    const inputPath = String((event.input as { path?: unknown }).path ?? ".");
    const reason = await protectedPathReason(inputPath, ctx.cwd);
    if (!reason) return undefined;
    return {
      block: true,
      reason: `Sandbox blocked ${event.toolName} access to ${normalizeToolPath(inputPath, ctx.cwd)}: ${reason}.`,
    };
  });

  pi.registerCommand("bash-yield", {
    description: `Show or set automatic bash yielding in seconds (default ${DEFAULT_BASH_YIELD_MS / 1_000}): /bash-yield [seconds|off]`,
    handler: async (args, ctx) => {
      const value = String(args ?? "")
        .trim()
        .toLowerCase();
      if (!value || value === "status") {
        ctx.ui?.notify?.(
          bashYieldMs === undefined ? "Automatic bash yielding is disabled." : `Bash commands yield after ${bashYieldMs / 1_000} seconds.`,
          "info",
        );
        return;
      }
      if (value === "off") {
        bashYieldMs = undefined;
        pi.appendEntry(BASH_YIELD_CONFIG_ENTRY, { version: 1, yieldMs: null });
        ctx.ui?.notify?.("Automatic bash yielding disabled for this session.", "warning");
        return;
      }
      const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_BASH_YIELD_SECONDS) {
        ctx.ui?.notify?.(`Usage: /bash-yield <1-${MAX_BASH_YIELD_SECONDS}|off|status>`, "warning");
        return;
      }
      bashYieldMs = seconds * 1_000;
      pi.appendEntry(BASH_YIELD_CONFIG_ENTRY, { version: 1, yieldMs: bashYieldMs });
      ctx.ui?.notify?.(`Bash commands will yield after ${seconds} seconds.`, "info");
    },
  });

  pi.registerCommand("bash-stop", {
    description: "Stop one or all running background bash jobs: /bash-stop <job-id|all>",
    handler: async (args, ctx) => {
      const value = String(args ?? "").trim();
      const running = [...bashJobs.values()].filter((job) => job.status === "running");
      const selected = value === "all" ? running : running.filter((job) => job.id === value);
      if (!value || !selected.length) {
        ctx.ui?.notify?.(value ? `No running bash job ${JSON.stringify(value)}.` : "Usage: /bash-stop <job-id|all>", "warning");
        return;
      }
      for (const job of selected) {
        job.cancellationRequested = true;
        job.controller?.abort();
      }
      ctx.ui?.notify?.(`Cancellation requested for ${selected.length} background bash job${selected.length === 1 ? "" : "s"}.`, "info");
    },
  });

  pi.registerCommand("bash-jobs", {
    description: "Summarize background bash jobs; use /mailbox for the live monitor",
    handler: async (_args, ctx) => {
      const jobs = [...bashJobs.values()].sort((left, right) => right.startedAt - left.startedAt);
      const summary = jobs.length
        ? jobs
            .slice(0, 10)
            .map((job) => `${job.id} · ${job.status} · ${job.command.replace(/\s+/g, " ").slice(0, 80)}`)
            .join("\n")
        : "No background bash jobs have run in this session.";
      ctx.ui?.notify?.(`${summary}\nUse /mailbox for live details.`, "info");
    },
  });

  const setSandbox = (enabled: boolean, ctx: any) => {
    sandboxEnabled = enabled;
    pi.appendEntry(STATE_ENTRY, { enabled: sandboxEnabled });
    updateStatus(ctx, sandboxEnabled, bwrapAvailable);
    ctx.ui?.notify?.(
      `Agent tool sandbox is ${sandboxEnabled ? "enabled" : "disabled"} for this session.`,
      sandboxEnabled ? "info" : "warning",
    );
  };

  pi.registerCommand("sandboxed", {
    description: "Toggle OS sandboxing for agent-controlled tools in this session",
    handler: async (_args, ctx) => setSandbox(!sandboxEnabled, ctx),
  });

  pi.registerCommand("is_sandboxed", {
    description: "Show or set OS sandboxing for agent-controlled tools in this session (true|false)",
    getArgumentCompletions: (prefix) => {
      const values = ["true", "false", "status"];
      const matches = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "true" || value === "false") return setSandbox(value === "true", ctx);
      if (value !== "" && value !== "status") {
        ctx.ui?.notify?.("Usage: /is_sandboxed [true|false|status] (or /sandboxed to toggle)", "warning");
        return;
      }
      ctx.ui?.notify?.(
        `Agent tool sandbox is ${sandboxEnabled ? "enabled" : "disabled"} for this session.`,
        sandboxEnabled ? "info" : "warning",
      );
    },
  });
}

export default function piSandbox(pi: ExtensionAPI) {
  createPiSandbox(pi);
}

export { restoredBashYieldMs, restoredState };
