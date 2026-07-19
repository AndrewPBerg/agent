import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createGrepTool } from "@earendil-works/pi-coding-agent";
import { HOST_EXECUTION_TOOLS, normalizeToolPath, protectedPathReason } from "./policy";
import { createSandboxedBashOperations, runSandboxedProcess } from "./runner";

const STATE_ENTRY = "pi-sandbox-state";
const FILE_TOOLS = new Set(["edit", "find", "grep", "ls", "read", "write"]);
const DEFAULT_GREP_LIMIT = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;

interface StateEntry {
  type?: string;
  customType?: string;
  data?: { enabled?: unknown };
}

function restoredState(entries: StateEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.customType === STATE_ENTRY && typeof entry.data?.enabled === "boolean") return entry.data.enabled;
  }
  return true;
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

function grepArguments(params: any): string[] {
  const args = ["--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) args.push("--ignore-case");
  if (params.literal) args.push("--fixed-strings");
  if (params.context && params.context > 0) args.push("--context", String(params.context));
  if (params.glob) args.push("--glob", String(params.glob));
  args.push("--", String(params.pattern), String(params.path || ".").replace(/^@/, ""));
  return args;
}

export default function piSandbox(pi: ExtensionAPI) {
  let sandboxEnabled = true;
  let bwrapAvailable = false;
  const initialCwd = process.cwd();
  const baseBash = createBashTool(initialCwd);
  const baseGrep = createGrepTool(initialCwd);

  pi.registerTool({
    ...baseBash,
    label: "bash (session sandbox)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled) return createBashTool(ctx.cwd).execute(id, params, signal, onUpdate);
      if (!bwrapAvailable) throw new Error("Pi sandbox is enabled, but Bubblewrap is unavailable. Tool execution failed closed.");
      const tool = createBashTool(ctx.cwd, { operations: createSandboxedBashOperations() });
      return tool.execute(id, params, signal, onUpdate);
    },
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
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
    sandboxEnabled = restoredState(entries as StateEntry[]);
    const bwrapPath = process.env.PI_BWRAP_PATH ?? "/usr/bin/bwrap";
    try {
      await access(bwrapPath, fsConstants.X_OK);
      bwrapAvailable = true;
    } catch {
      bwrapAvailable = false;
      if (sandboxEnabled) ctx.ui?.notify?.(`Bubblewrap unavailable at ${bwrapPath}; sandboxed process tools will fail closed.`, "error");
    }
    updateStatus(ctx, sandboxEnabled, bwrapAvailable);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui?.setStatus?.("pi-sandbox", undefined);
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

  pi.registerCommand("is_sandboxed", {
    description: "Show or set OS sandboxing for agent-controlled tools in this session (true|false)",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "true" || value === "false") {
        sandboxEnabled = value === "true";
        pi.appendEntry(STATE_ENTRY, { enabled: sandboxEnabled });
        updateStatus(ctx, sandboxEnabled, bwrapAvailable);
      } else if (value !== "") {
        ctx.ui?.notify?.("Usage: /is_sandboxed [true|false]", "warning");
        return;
      }
      ctx.ui?.notify?.(
        `Agent tool sandbox is ${sandboxEnabled ? "enabled" : "disabled"} for this session.`,
        sandboxEnabled ? "info" : "warning",
      );
    },
  });
}

export { restoredState };
