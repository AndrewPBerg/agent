import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatPythonDebugFullResult,
  formatPythonDebugResult,
  MAX_INTERACTIVE_BREAKPOINTS,
  type PythonDebugOptions,
  type PythonDebugResult,
  PythonDebugSession,
  type PythonDebugSessionStatus,
  type PythonRunner,
  parseBreakpointSpec,
  parseBugrunArgs,
  runPythonPytestDebug,
} from "./python";

type BugrunDetailLevel = "summary" | "full";
type BugrunIntent = "solve" | "explore" | "harden" | "lab";
type BugrunTheme = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type BugrunConfig = {
  python?: {
    python?: string;
    runner?: PythonRunner;
    uvPackages?: string[];
    uvNoProject?: boolean;
    pytestArgs?: string[];
    timeoutMs?: number;
    maxHits?: number;
    justMyCode?: boolean;
    detailLevel?: BugrunDetailLevel;
  };
};

type BugrunSessionParams = BugrunParams & { sessionId?: string };
type BugrunSessionCommandParams = { sessionId?: string; hitIndex?: number; detailLevel?: BugrunDetailLevel };

type BugrunParams = {
  question?: string;
  cwd?: string;
  test: string;
  breakpoints?: string[];
  python?: string;
  runner?: PythonRunner;
  uvPackages?: string[];
  uvNoProject?: boolean;
  pytestArgs?: string[];
  timeoutMs?: number;
  maxHits?: number;
  justMyCode?: boolean;
  detailLevel?: BugrunDetailLevel;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(EXTENSION_DIR, "fixtures", "python-shop");
const FIXTURE_TEST = "tests/test_cart.py::test_discount_total";
const FIXTURE_BREAKPOINT = "src/shop/cart.py:9";
const BUGRUN_INTENTS = ["solve", "explore", "harden", "lab"] as const;
const BUGRUN_INTENT_ALIASES: Record<string, BugrunIntent> = {
  debug: "solve",
  solver: "solve",
  qa: "harden",
  fun: "lab",
};

function stringEnum<const T extends readonly string[]>(values: T, options: Record<string, unknown> = {}) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

function readConfig(ctx: ExtensionContext): BugrunConfig {
  if (typeof ctx.isProjectTrusted === "function" && !ctx.isProjectTrusted()) return {};

  const path = join(ctx.cwd, CONFIG_DIR_NAME, "debug.json");
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf8")) as BugrunConfig;
  } catch (error) {
    ctx.ui.notify(`bugrun ignored invalid ${path}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return {};
  }
}

function buildOptions(params: BugrunParams, ctx: ExtensionContext): PythonDebugOptions {
  const config = readConfig(ctx).python ?? {};
  const cwd = resolve(ctx.cwd, params.cwd ?? ".");
  const breakpointSpecs = params.breakpoints ?? [];

  return {
    cwd,
    test: params.test,
    breakpoints: breakpointSpecs.map((spec) => parseBreakpointSpec(spec, cwd)),
    python: params.python ?? config.python,
    runner: params.runner ?? config.runner ?? "auto",
    uvPackages: params.uvPackages ?? config.uvPackages,
    uvNoProject: params.uvNoProject ?? config.uvNoProject,
    pytestArgs: params.pytestArgs ?? config.pytestArgs,
    timeoutMs: params.timeoutMs ?? config.timeoutMs,
    maxHits: params.maxHits ?? config.maxHits,
    justMyCode: params.justMyCode ?? config.justMyCode,
  };
}

function parseBugrunIntent(raw: string): { intent?: BugrunIntent; request: string } {
  const [first = "", ...rest] = raw.trim().split(/\s+/);
  const normalized = first.toLowerCase();
  const intent = BUGRUN_INTENTS.includes(normalized as BugrunIntent) ? (normalized as BugrunIntent) : BUGRUN_INTENT_ALIASES[normalized];
  return intent ? { intent, request: rest.join(" ").trim() } : { request: raw.trim() };
}

function intentGuidance(intent: BugrunIntent): string {
  switch (intent) {
    case "solve":
      return "Mode: solve — reproduce the bug, prove the failing state transition, make the smallest fix, rerun the focused check.";
    case "harden":
      return "Mode: harden — identify abstraction invariants, exercise edge/error paths, report missing contracts/tests before patching.";
    case "lab":
      return "Mode: lab — make it playful: pick a small runtime experiment, predict what happens, then prove or correct the mental model.";
    case "explore":
      return "Mode: explore — trace boundaries and state changes to build a mental model; do not patch unless runtime evidence exposes a bug.";
  }
}

function buildFocusedPrompt(cwd: string, test: string, breakpoints: string[], fixture = false, intent: BugrunIntent = "solve"): string {
  const fixtureOptions = fixture
    ? '\n- runner: uv\n- uvPackages: ["pytest"]\n- uvNoProject: true\n- pytestArgs: ["-q", "-p", "no:cacheprovider"]'
    : "";
  return `Use Bugrun as a Python runtime code-flow microscope for this focused pytest stimulus.

${intentGuidance(intent)}

Use the \`bugrun_debug\` tool with:
- cwd: ${cwd}
- test: ${test}
- breakpoints: ${breakpoints.length ? breakpoints.map((item) => `\`${item}\``).join(", ") : "(inspect first and add one natural production-code breakpoint)"}${fixtureOptions}

Use pytest as the executable stimulus, not as the whole answer. Keep the first run compact; use \`detailLevel: "full"\` only if expanded hit/locals text is truly needed in LLM context. Explain the call path, important stack frames, locals/state transitions, and what runtime evidence showed that static analysis alone would miss. Follow the selected mode above for whether to patch, test, or narrate next.`;
}

function buildExploratoryPrompt(cwd: string, request: string, intent: BugrunIntent = "explore"): string {
  return `Use Bugrun as a Python runtime code-flow microscope.

${intentGuidance(intent)}

User request:
${request}

Working directory:
${cwd}

Intent:
- The user invoked /bugrun because DAP breakpoints/stack/locals should explain this flow better than only pytest results or static analysis.
- Do not stop at static analysis. Use static reading only to choose the smallest executable stimulus and natural breakpoints.

Workflow:
1. Inspect the repo to locate the mentioned Python file/symbols and nearby tests.
2. If no focused pytest target already exercises the path, create the smallest pytest stimulus needed to drive it.
3. Choose natural production-code breakpoints at the relevant boundaries, then call \`bugrun_debug\` or \`bugrun_start\` with explicit \`path.py:line\` breakpoints.
4. Keep the first run compact; use expanded/full detail only if stack/locals text is truly needed in LLM context.
5. Use runtime evidence to answer in the selected mode: solve, explore, harden, or lab.
6. Do not add temporary print/log instrumentation unless Bugrun cannot answer the question.`;
}

function looksLikePytestTarget(target?: string): boolean {
  if (!target) return false;
  return (
    target.includes("::") || target.startsWith("tests/") || /(^|\/)test_[^/]*\.py$/.test(target) || /(^|\/)[^/]+_test\.py$/.test(target)
  );
}

class BugrunModePanel implements Component {
  constructor(
    private readonly intent: BugrunIntent,
    private readonly theme: BugrunTheme,
  ) {}

  render(width: number): string[] {
    const th = this.theme;
    const line = (text: string) => truncateToWidth(text, Math.max(20, width), "…");
    return [
      line(`${th.fg("accent", th.bold("Bugrun"))} mode: ${th.bold(this.intent)} • /bugrun solve|explore|harden|lab ...`),
      line(intentGuidance(this.intent).replace(/^Mode: /, "")),
    ];
  }

  invalidate(): void {}
}

function setBugrunModeUi(ctx: ExtensionContext, intent: BugrunIntent): void {
  ctx.ui.setStatus("bugrun", `bugrun:${intent}`);
  if (!ctx.hasUI) return;
  ctx.ui.setWidget?.("bugrun-panel", (_tui: unknown, theme: BugrunTheme) => new BugrunModePanel(intent, theme), {
    placement: "belowEditor",
  });
}

class BugrunTracePanel implements Component {
  constructor(
    private readonly debugResult: PythonDebugResult,
    private readonly theme: BugrunTheme,
  ) {}

  render(width: number): string[] {
    const w = Math.max(20, width);
    const lines: string[] = [];
    const th = this.theme;
    const statusColor = this.debugResult.exitCode === 0 ? "success" : "error";
    const status = this.debugResult.exitCode === 0 ? "passed" : `exit ${this.debugResult.exitCode ?? "signal"}`;

    const add = (line = "") => lines.push(truncateToWidth(line, w, ""));
    add(
      `${th.fg("accent", th.bold("Bugrun Trace"))} ${th.fg(statusColor, status)} ${th.fg("muted", `• ${this.debugResult.hits.length} hit(s) • ${this.debugResult.durationMs}ms`)}`,
    );
    add(th.fg("dim", this.debugResult.test));

    const steps = collapseTraceHits(this.debugResult.hits).slice(0, 12);
    if (!steps.length) {
      add(th.fg("warning", "No breakpoint hits captured."));
      return lines;
    }

    for (const step of steps) {
      const hit = step.hit;
      const label = step.count === 1 ? `#${step.start}` : `#${step.start}-${step.end} ×${step.count}`;
      add("");
      add(
        `${th.fg("accent", label)} ${th.bold(hit.frame.name)} ${th.fg("muted", `${relativeDisplay(this.debugResult.cwd, hit.frame.path)}:${hit.frame.line}`)}`,
      );

      const callers = hit.stack
        .slice(1, 4)
        .map((frame) => `${frame.name} ${relativeDisplay(this.debugResult.cwd, frame.path)}:${frame.line}`)
        .join(" ← ");
      if (callers) add(th.fg("dim", `callers: ${callers}`));

      for (const sourceLine of sourceExcerpt(this.debugResult.cwd, hit.frame.path, hit.frame.line, this.debugResult.breakpoints, th))
        add(sourceLine);

      const locals = selectTraceLocals(hit.locals).slice(0, 6);
      if (locals.length) {
        add(th.fg("muted", "locals"));
        for (const variable of locals) add(`  ${th.fg("accent", variable.name)} = ${compactTraceValue(variable.value)}`);
      }
    }

    if (this.debugResult.hits.length > steps.length)
      add(th.fg("dim", `... ${this.debugResult.hits.length - steps.length} more hits omitted from trace view`));
    return lines;
  }

  invalidate(): void {}
}

type TraceStep = {
  start: number;
  end: number;
  count: number;
  hit: PythonDebugResult["hits"][number];
  signature: string;
};

function collapseTraceHits(hits: PythonDebugResult["hits"]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const [index, hit] of hits.entries()) {
    const signature = [hit.frame.path ?? "", hit.frame.line, hit.frame.name].join(":");
    const last = steps[steps.length - 1];
    if (last?.signature === signature) {
      last.end = index + 1;
      last.count += 1;
      continue;
    }
    steps.push({ start: index + 1, end: index + 1, count: 1, hit, signature });
  }
  return steps;
}

function sourceExcerpt(
  cwd: string,
  path: string | undefined,
  line: number,
  breakpoints: PythonDebugResult["breakpoints"],
  theme: BugrunTheme,
): string[] {
  if (!path || !isInside(cwd, path)) return [theme.fg("dim", "  source unavailable outside workspace")];

  try {
    const source = readFileSync(path, "utf8").split(/\r?\n/);
    const start = Math.max(1, line - 4);
    const end = Math.min(source.length, line + 4);
    const breakpointLines = new Set(breakpoints.filter((breakpoint) => breakpoint.path === path).map((breakpoint) => breakpoint.line));
    const width = String(end).length;
    const lines: string[] = [];

    for (let current = start; current <= end; current++) {
      const isHit = current === line;
      const isBreakpoint = breakpointLines.has(current);
      const marker = isHit ? theme.fg("accent", "▶") : isBreakpoint ? theme.fg("warning", "●") : " ";
      const number = String(current).padStart(width, " ");
      const prefix = `${marker} ${theme.fg(isHit ? "accent" : "dim", number)} │ `;
      lines.push(`${prefix}${source[current - 1] ?? ""}`);
    }
    return lines;
  } catch {
    return [theme.fg("dim", "  source unavailable")];
  }
}

function selectTraceLocals(locals: PythonDebugResult["hits"][number]["locals"]): PythonDebugResult["hits"][number]["locals"] {
  const important = new Set(["intent", "payload", "result", "command", "executor", "executor_result", "state", "ctx", "deps"]);
  const noisy = new Set(["self", "function variables"]);
  const selected = locals.filter((variable) => important.has(variable.name));
  const fallback = locals.filter((variable) => !important.has(variable.name) && !noisy.has(variable.name));
  return [...selected, ...fallback];
}

function compactTraceValue(value: string, max = 160): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max)}...`;
}

function relativeDisplay(cwd: string, path: string | undefined): string {
  if (!path) return "<unknown>";
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) ? rel : path;
}

function isInside(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function formatSessionStatus(status: PythonDebugSessionStatus): string {
  const lines = [`Bugrun session ${status.id}: ${status.state}`];
  lines.push(`Pytest target: ${status.test}`);
  lines.push(`Hits: ${status.hits.length}; duration: ${status.durationMs}ms`);
  if (status.exitCode !== null || status.signal)
    lines.push(`Exit: ${status.exitCode ?? "signal"}${status.signal ? ` (${status.signal})` : ""}`);
  if (status.error) lines.push(`Error: ${status.error}`);

  const hit = status.currentHit;
  if (hit) {
    lines.push("");
    lines.push(`Current stop: ${hit.frame.name} at ${relativeDisplay(status.cwd, hit.frame.path)}:${hit.frame.line}`);
    const caller = hit.stack[1];
    if (caller) lines.push(`Caller: ${caller.name} ${relativeDisplay(status.cwd, caller.path)}:${caller.line}`);
    const locals = selectTraceLocals(hit.locals).slice(0, 4);
    if (locals.length)
      lines.push(`Locals: ${locals.map((variable) => `${variable.name}=${compactTraceValue(variable.value, 140)}`).join("; ")}`);
  }

  const output = status.stderrSummary || status.stdoutSummary;
  if (output) {
    const line = output
      .split(/\r?\n/)
      .reverse()
      .find((candidate) => candidate.trim());
    if (line) lines.push(`Output: ${compactTraceValue(line, 220)}`);
  }

  lines.push("");
  lines.push("Next: use bugrun_continue to advance, bugrun_expand for TUI-only expanded trace view, or bugrun_stop to terminate.");
  return lines.join("\n");
}

function formatExpandedHitNotice(status: PythonDebugSessionStatus, hitIndex?: number): string {
  const index = hitIndex ?? status.hits.length;
  const hit = status.hits[index - 1];
  if (!hit) return `Bugrun session ${status.id} has no hit #${index}. Captured hits: ${status.hits.length}.`;
  return [
    `Bugrun expanded trace view prepared for hit #${index} (${status.id}).`,
    `${hit.reason}: ${hit.frame.name} at ${relativeDisplay(status.cwd, hit.frame.path)}:${hit.frame.line}`,
    "Source excerpts, stack, and locals are rendered in the Pi TUI only; LLM content stays compact by design.",
  ].join("\n");
}

function resolveSession(sessions: Map<string, PythonDebugSession>, sessionId?: string): PythonDebugSession {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`No Bugrun session found: ${sessionId}`);
    return session;
  }
  if (sessions.size === 1) return [...sessions.values()][0];
  if (!sessions.size) throw new Error("No live Bugrun sessions. Use bugrun_start first.");
  throw new Error(`Multiple live Bugrun sessions: ${[...sessions.keys()].join(", ")}. Pass sessionId.`);
}

function statusToResult(status: PythonDebugSessionStatus): PythonDebugResult {
  return {
    cwd: status.cwd,
    test: status.test,
    command: status.command,
    args: status.args,
    breakpoints: status.breakpoints,
    hits: status.hits,
    exitCode: status.exitCode,
    signal: status.signal,
    stdout: status.stdoutSummary ?? "",
    stderr: status.stderrSummary ?? "",
    durationMs: status.durationMs,
  };
}

async function stopAllSessions(sessions: Map<string, PythonDebugSession>): Promise<number> {
  const count = sessions.size;
  await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
  sessions.clear();
  return count;
}

function clearBugrunUi(ctx: ExtensionContext) {
  ctx.ui.setStatus("bugrun", undefined);
  ctx.ui.setWidget?.("bugrun-panel", undefined);
}

export default function bugrun(pi: ExtensionAPI) {
  const sessions = new Map<string, PythonDebugSession>();

  pi.registerTool({
    name: "bugrun_start",
    label: "Bugrun Start",
    description:
      "Start a multi-shot Python pytest/debugpy session. Stops at first breakpoint; continue/expand with follow-up Bugrun tools.",
    promptSnippet: "Start an interactive Bugrun session with up to five production-code breakpoints, then inspect stops before continuing.",
    promptGuidelines: [
      "Prefer bugrun_start for exploratory runtime flow debugging where the next breakpoint/inspection depends on previous state.",
      `Use at most ${MAX_INTERACTIVE_BREAKPOINTS} breakpoints; choose boundaries where state changes or control crosses components.`,
      "Use bugrun_continue to advance and bugrun_expand only when compact stop summaries are insufficient.",
    ],
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ description: "Optional stable session id. Defaults to bugrun-<timestamp>." })),
      question: Type.Optional(Type.String({ description: "Runtime question to answer from breakpoint evidence." })),
      cwd: Type.Optional(Type.String({ description: "Project directory for pytest. Defaults to Pi cwd." })),
      test: Type.String({ description: "Focused pytest target, e.g. tests/test_cart.py::test_discount_total." }),
      breakpoints: Type.Array(Type.String({ description: "Breakpoint spec path.py:line, relative to cwd unless absolute." }), {
        minItems: 1,
        maxItems: MAX_INTERACTIVE_BREAKPOINTS,
      }),
      python: Type.Optional(Type.String({ description: "Python executable. Defaults to python3 or .pi/debug.json." })),
      runner: Type.Optional(stringEnum(["auto", "direct", "uv"] as const)),
      uvPackages: Type.Optional(
        Type.Array(Type.String({ description: "Extra uv --with packages. debugpy is always added for uv runner." })),
      ),
      uvNoProject: Type.Optional(Type.Boolean({ description: "Pass uv run --no-project." })),
      pytestArgs: Type.Optional(Type.Array(Type.String({ description: "Arguments before the pytest target. Defaults to ['-q']." }))),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: "Whole debug session timeout in milliseconds." })),
      justMyCode: Type.Optional(Type.Boolean({ description: "debugpy justMyCode flag. Defaults false for agent debugging." })),
    }),
    async execute(_toolCallId, params: BugrunSessionParams, signal, onUpdate, ctx) {
      const sessionId = params.sessionId?.trim() || `bugrun-${Date.now().toString(36)}`;
      if (sessions.has(sessionId)) throw new Error(`Bugrun session already exists: ${sessionId}`);
      const options = buildOptions(params, ctx);
      ctx.ui.setStatus("bugrun", `bugrun:${sessionId} starting`);
      onUpdate?.({ content: [{ type: "text", text: `Starting Bugrun session ${sessionId} for ${options.test}...` }] });
      const session = await PythonDebugSession.start(sessionId, options, signal);
      sessions.set(sessionId, session);
      const status = await session.continueToStop(signal);
      ctx.ui.setStatus("bugrun", `bugrun:${sessionId} ${status.state}`);
      return {
        content: [{ type: "text", text: formatSessionStatus(status) }],
        details: { sessionId, status, result: statusToResult(status) },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("bugrun_start ")) + theme.fg("muted", args.test ?? ""), 0, 0);
    },
    renderResult(result, _options, theme) {
      const status = (result.details as { status?: PythonDebugSessionStatus } | undefined)?.status;
      if (status) return new BugrunTracePanel(statusToResult(status), theme as BugrunTheme);
      return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    },
  });

  pi.registerTool({
    name: "bugrun_continue",
    label: "Bugrun Continue",
    description: "Continue a live Bugrun session to the next breakpoint or process exit.",
    parameters: Type.Object({ sessionId: Type.Optional(Type.String({ description: "Session id. Defaults to the only live session." })) }),
    async execute(_toolCallId, params: BugrunSessionCommandParams, signal, _onUpdate, ctx) {
      const session = resolveSession(sessions, params.sessionId);
      const status = await session.continueToStop(signal);
      ctx.ui.setStatus("bugrun", `bugrun:${status.id} ${status.state}`);
      return {
        content: [{ type: "text", text: formatSessionStatus(status) }],
        details: { sessionId: status.id, status, result: statusToResult(status) },
      };
    },
    renderResult(result, _options, theme) {
      const status = (result.details as { status?: PythonDebugSessionStatus } | undefined)?.status;
      if (status) return new BugrunTracePanel(statusToResult(status), theme as BugrunTheme);
      return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    },
  });

  pi.registerTool({
    name: "bugrun_status",
    label: "Bugrun Status",
    description: "Return compact status for a live Bugrun session without continuing it.",
    parameters: Type.Object({ sessionId: Type.Optional(Type.String({ description: "Session id. Defaults to the only live session." })) }),
    async execute(_toolCallId, params: BugrunSessionCommandParams) {
      const session = resolveSession(sessions, params.sessionId);
      const status = session.status();
      return {
        content: [{ type: "text", text: formatSessionStatus(status) }],
        details: { sessionId: status.id, status, result: statusToResult(status) },
      };
    },
  });

  pi.registerTool({
    name: "bugrun_expand",
    label: "Bugrun Expand",
    description: "Prepare an expanded TUI trace view for one captured Bugrun hit without pasting stack/locals into LLM context.",
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ description: "Session id. Defaults to the only live session." })),
      hitIndex: Type.Optional(Type.Integer({ minimum: 1, description: "1-based hit index. Defaults to current/latest hit." })),
    }),
    async execute(_toolCallId, params: BugrunSessionCommandParams) {
      const session = resolveSession(sessions, params.sessionId);
      const status = session.status();
      return {
        content: [{ type: "text", text: formatExpandedHitNotice(status, params.hitIndex) }],
        details: { sessionId: status.id, status, hitIndex: params.hitIndex ?? status.hits.length, result: statusToResult(status) },
      };
    },
    renderResult(result, _options, theme) {
      const status = (result.details as { status?: PythonDebugSessionStatus } | undefined)?.status;
      if (status) return new BugrunTracePanel(statusToResult(status), theme as BugrunTheme);
      return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "", 0, 0);
    },
  });

  pi.registerTool({
    name: "bugrun_stop",
    label: "Bugrun Stop",
    description: "Terminate a live Bugrun session and clean up debugpy/pytest.",
    parameters: Type.Object({ sessionId: Type.Optional(Type.String({ description: "Session id. Defaults to the only live session." })) }),
    async execute(_toolCallId, params: BugrunSessionCommandParams, _signal, _onUpdate, ctx) {
      const session = resolveSession(sessions, params.sessionId);
      const status = await session.stop();
      sessions.delete(status.id);
      clearBugrunUi(ctx);
      return { content: [{ type: "text", text: `Stopped Bugrun session ${status.id}.` }], details: { sessionId: status.id, status } };
    },
  });

  pi.registerTool({
    name: "bugrun_debug",
    label: "Bugrun Debug",
    description:
      "Run one focused Python pytest stimulus under debugpy, stop at explicit breakpoints, and return stack/locals/runtime code-flow evidence. MVP supports Python only and requires at least one path.py:line breakpoint.",
    promptSnippet:
      "Investigate Python code flow with debugpy breakpoints, stack frames, and locals instead of relying only on pytest output or static analysis.",
    promptGuidelines: [
      "Use bugrun_debug when runtime stack/locals would clarify Python code flow better than static analysis or pytest results alone.",
      "bugrun_debug requires explicit breakpoints like src/foo.py:42; choose natural production-code breakpoints at the relevant boundary or state transition.",
      "bugrun_debug defaults to compact LLM content; request detailLevel=full only when you need expanded hit/locals text in context.",
      "After bugrun_debug returns evidence, explain call path and locals/state transitions; summarize large objects instead of pasting huge locals wholesale, and patch only when runtime evidence exposes a concrete bug.",
    ],
    parameters: Type.Object({
      question: Type.Optional(Type.String({ description: "Runtime question to answer from breakpoint evidence." })),
      cwd: Type.Optional(Type.String({ description: "Project directory for pytest. Defaults to Pi cwd." })),
      test: Type.String({ description: "Focused pytest target, e.g. tests/test_cart.py::test_discount_total." }),
      breakpoints: Type.Optional(
        Type.Array(Type.String({ description: "Breakpoint spec path.py:line, relative to cwd unless absolute." })),
      ),
      python: Type.Optional(Type.String({ description: "Python executable. Defaults to python3 or .pi/debug.json." })),
      runner: Type.Optional(stringEnum(["auto", "direct", "uv"] as const)),
      uvPackages: Type.Optional(
        Type.Array(Type.String({ description: "Extra uv --with packages, e.g. pytest. debugpy is always added for uv runner." })),
      ),
      uvNoProject: Type.Optional(
        Type.Boolean({ description: "Pass uv run --no-project. Useful for tiny fixtures; usually false for real uv projects." }),
      ),
      pytestArgs: Type.Optional(Type.Array(Type.String({ description: "Arguments before the pytest target. Defaults to ['-q']." }))),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: "Whole debug session timeout in milliseconds." })),
      maxHits: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 25, description: "Maximum breakpoint hits to capture before just continuing." }),
      ),
      justMyCode: Type.Optional(Type.Boolean({ description: "debugpy justMyCode flag. Defaults false for agent debugging." })),
      detailLevel: Type.Optional(
        stringEnum(["summary", "full"] as const, {
          description: "Controls LLM-facing content. Defaults to compact summary; full expands every hit with capped locals/output.",
        }),
      ),
    }),
    async execute(_toolCallId, params: BugrunParams, signal, onUpdate, ctx) {
      const options = buildOptions(params, ctx);
      ctx.ui.setStatus("bugrun", "bugrun:debugpy running");
      onUpdate?.({ content: [{ type: "text", text: `Starting debugpy pytest session for ${options.test}...` }] });

      try {
        const result = await runPythonPytestDebug(options, signal);
        const detailLevel = params.detailLevel ?? readConfig(ctx).python?.detailLevel ?? "summary";
        const text =
          detailLevel === "full" ? formatPythonDebugFullResult(result, params.question) : formatPythonDebugResult(result, params.question);
        ctx.ui.setStatus("bugrun", `bugrun:${result.hits.length} hit(s) exit:${result.exitCode ?? "signal"}`);
        return {
          content: [{ type: "text", text }],
          details: {
            cwd: result.cwd,
            test: result.test,
            breakpoints: result.breakpoints,
            hits: result.hits,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            result,
            detailLevel,
          },
        };
      } finally {
        ctx.ui.setStatus("bugrun", undefined);
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("bugrun_debug ")) + theme.fg("muted", args.test ?? ""), 0, 0);
    },
    renderResult(result, _options, theme) {
      const debugResult = (result.details as { result?: PythonDebugResult } | undefined)?.result;
      if (debugResult) return new BugrunTracePanel(debugResult, theme as BugrunTheme);
      const fallback = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      return new Text(fallback, 0, 0, (text: string) => theme.bg("toolSuccessBg", text));
    },
  });

  pi.registerCommand("bugrun", {
    description: "Use DAP/debugpy as a runtime microscope for Python code flow",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const items = ["solve", "explore", "harden", "lab", "clear", "fixture", "help"]
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();

      const command = raw.split(/\s+/)[0].toLowerCase();

      if (command === "clear") {
        const stopped = await stopAllSessions(sessions);
        clearBugrunUi(ctx);
        ctx.ui.notify(stopped ? `Bugrun cleared; stopped ${stopped} live session(s).` : "Bugrun cleared.", "info");
        return;
      }

      if (raw && !["fixture", "help", "status", "stop", "clear"].includes(command)) {
        const intentRequest = parseBugrunIntent(raw);
        if (intentRequest.intent && !intentRequest.request) {
          ctx.ui.notify(`Usage: /bugrun ${intentRequest.intent} <question-or-pytest-target>`, "info");
          return;
        }
        const request = intentRequest.request || raw;
        try {
          const parsed = parseBugrunArgs(request, ctx.cwd);
          const intent = intentRequest.intent ?? (looksLikePytestTarget(parsed.test) ? "solve" : "explore");
          setBugrunModeUi(ctx, intent);
          if (!looksLikePytestTarget(parsed.test)) {
            pi.sendUserMessage(buildExploratoryPrompt(ctx.cwd, request, intent));
            return;
          }

          pi.sendUserMessage(
            buildFocusedPrompt(
              ctx.cwd,
              parsed.test,
              parsed.breakpoints.map((breakpoint) => `${breakpoint.path}:${breakpoint.line}`),
              false,
              intent,
            ),
          );
          return;
        } catch {
          const intent = intentRequest.intent ?? "explore";
          setBugrunModeUi(ctx, intent);
          pi.sendUserMessage(buildExploratoryPrompt(ctx.cwd, request, intent));
          return;
        }
      }

      const parsed = parseBugrunArgs(raw, ctx.cwd);

      if (parsed.command === "fixture") {
        setBugrunModeUi(ctx, "solve");
        pi.sendUserMessage(buildFocusedPrompt(FIXTURE_DIR, FIXTURE_TEST, [FIXTURE_BREAKPOINT], true, "solve"));
        return;
      }

      if (!parsed.test || parsed.command === "help") {
        ctx.ui.notify(
          [
            "Usage:",
            "/bugrun [solve|explore|harden|lab] <question-or-pytest-target>",
            "/bugrun <pytest-target> <breakpoint.py:line> [more breakpoints...]",
            "/bugrun fixture  # queues the included broken Python fixture",
            "/bugrun clear  # stop live sessions and clear Bugrun UI",
            "Examples:",
            "/bugrun explore native.py in relation to pydantic Graph",
            "/bugrun harden fbv2 runtime abstraction boundaries",
            "/bugrun solve tests/test_cart.py::test_discount_total src/shop/cart.py:9",
          ].join("\n"),
          "info",
        );
        return;
      }
    },
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\nBugrun policy: when the user asks to understand Python code flow or invokes /bugrun, pick the intent first: solve (bug fix), explore (mental model), harden (abstraction QA), or lab (playful proof). Prefer runtime DAP evidence via bugrun_debug/bugrun_start (pytest as stimulus, debugpy as microscope) before relying only on static analysis, pytest output, or temporary print/log instrumentation.",
  }));

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopAllSessions(sessions);
    clearBugrunUi(ctx);
  });
}
