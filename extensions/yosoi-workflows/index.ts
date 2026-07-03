import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const workflows = ["help", "search", "fetch", "crawl", "research"] as const;
const commands = ["help", "search", "fetch", "crawl", "research", "dashboard", "hide", "clear"] as const;
type Workflow = (typeof workflows)[number];
type YosoiCommand = (typeof commands)[number];

type RunStatus = "running" | "ok" | "error";

interface YosoiRun {
  id: string;
  command: string;
  workflow: string;
  urls: string[];
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  exitCode?: number;
  httpStatusCodes: number[];
  error?: string;
  outputPath?: string;
  fetcher?: string;
  summary?: string;
  contextTokens?: number;
}

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

const runs: YosoiRun[] = [];
const active = new Map<string, YosoiRun>();
let dashboardVisible = true;
let latestContextTokens: number | undefined;
let activated = false;

const workflowPrompts: Record<Workflow, (target: string) => string> = {
  help: () => `Use the project-local Yosoi web workflows.

Read:
- ~/.pi/agent/skills/yosoi-web-workflows/SKILL.md
- ~/.pi/agent/skills/yosoi-fetch/SKILL.md when fetching page evidence
- ~/.pi/agent/skills/yosoi-research-frontier/SKILL.md when creating a research packet

Summarize the right Yosoi command path for my task. Use uvx or uv run commands only.`,

  search: (target) => `Use Yosoi search for source discovery.

Target/query: ${target || "<fill query>"}

Follow ~/.pi/agent/skills/yosoi-web-workflows/SKILL.md.
Start with:
uvx yosoi search "${target || "QUERY"}" --limit 10 --json > .yosoi/search-results.json

Then inspect candidate URLs, fetch promising pages before making content claims, and report source quality/gaps.`,

  fetch: (target) => `Use Yosoi fetch for bounded page evidence, not scraping.

URL(s): ${target || "<fill URL>"}

Follow ~/.pi/agent/skills/yosoi-web-workflows/SKILL.md and ~/.pi/agent/skills/yosoi-fetch/SKILL.md.
Start with:
uvx yosoi fetch "${target || "URL"}" --view text --chars 12000 --json

If JS/source fidelity matters, compare raw/rendered or save a bundle. Report status, fetcher, truncation, artifacts, and next step.`,

  crawl: (target) => `Use Yosoi crawl for a bounded site/frontier traversal.

Seed(s): ${target || "<fill seed URL>"}

Follow ~/.pi/agent/skills/yosoi-web-workflows/SKILL.md.
Start conservatively:
uvx yosoi crawl "${target || "URL"}" --limit 25 --json > .yosoi/crawl-results.json

Respect policy/robots settings, keep output as artifacts, and fetch/scrape representative pages before claiming structured facts.`,

  research: (target) => `Use the Yosoi research frontier packet workflow.

Topic: ${target || "<fill topic>"}

Follow ~/.pi/agent/skills/yosoi-web-workflows/SKILL.md and ~/.pi/agent/skills/yosoi-research-frontier/SKILL.md.
Start with:
uvx yosoi research init "${target || "TOPIC"}" --json

Then save search/crawl/scrape artifacts into the packet, append observations, and separate available-now evidence from paid/blocked/unknown gaps.`,
};

function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  return text.length <= width ? text : text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
}

function parseArgs(args: string): { command: YosoiCommand; target: string } {
  const trimmed = args.trim();
  if (!trimmed) return { command: "help", target: "" };
  const [first, ...rest] = trimmed.split(/\s+/);
  if ((commands as readonly string[]).includes(first)) {
    return { command: first as YosoiCommand, target: rest.join(" ") };
  }
  return { command: "help", target: trimmed };
}

function completions(prefix: string): AutocompleteItem[] | null {
  const items = commands.map((command) => ({
    value: command,
    label: command,
    detail: command === "dashboard" ? "show Yosoi run dashboard" : `Yosoi ${command}`,
  }));
  const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
  return filtered.length ? filtered : null;
}

function isYosoiShellCommand(command: string): boolean {
  return /(?:^|[\s;&|()])(?:UV_CACHE_DIR=\S+\s+)?(?:(?:uv\s+run|uvx)\s+)?yosoi\b/.test(command);
}

function extractWorkflow(command: string): string {
  const match = command.match(/(?:^|[\s;&|()])(?:UV_CACHE_DIR=\S+\s+)?(?:(?:uv\s+run|uvx)\s+)?yosoi\s+([\w-]+)(?:\s+([\w-]+))?/);
  if (!match) return "yosoi";
  return match[1] === "research" && match[2] ? `research ${match[2]}` : match[1];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractUrls(text: string): string[] {
  return unique(text.match(/https?:\/\/[^\s"'<>]+/g) ?? []);
}

function extractRedirectPath(command: string): string | undefined {
  const match = command.match(/(?:^|\s)>\s*([^\s;&|]+)/);
  return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

async function readSmallJsonArtifact(cwd: string, path: string): Promise<unknown | undefined> {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  if (!resolved.includes("/.yosoi/") && !resolved.startsWith("/tmp/")) return undefined;
  try {
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 1_000_000) return undefined;
    return firstJsonObject(await readFile(resolved, "utf8"));
  } catch {
    return undefined;
  }
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

function firstJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)]) {
    if (!candidate || !candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }
  return undefined;
}

function getArray(obj: unknown, key: string): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const value = (obj as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function getRecord(obj: unknown, key: string): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function applyJsonSummary(run: YosoiRun, payload: unknown): void {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  if (!root) return;

  const resultUnits = getArray(root, "results");
  for (const raw of resultUnits) {
    if (!raw || typeof raw !== "object") continue;
    const unit = raw as Record<string, unknown>;
    const url = stringValue(unit.url) ?? stringValue(unit.final_url);
    if (url) run.urls.push(url);
    const code = numberValue(unit.status_code);
    if (code !== undefined) run.httpStatusCodes.push(code);
    run.fetcher ??= stringValue(unit.fetcher_type);
    run.error ??= stringValue(unit.error);
  }

  const hits = getArray(root, "hits");
  if (hits.length) {
    for (const raw of hits.slice(0, 5)) {
      if (raw && typeof raw === "object") {
        const url = stringValue((raw as Record<string, unknown>).url);
        if (url) run.urls.push(url);
      }
    }
    run.summary = `${hits.length} search hits`;
  }

  const summary = getRecord(root, "summary");
  if (summary) {
    const fetched = numberValue(summary.pages_fetched);
    const attempted = numberValue(summary.attempted_urls);
    const status = stringValue(summary.status);
    run.summary = [status, fetched !== undefined && attempted !== undefined ? `${fetched}/${attempted} pages` : undefined]
      .filter(Boolean)
      .join(" ");
  }

  const status = stringValue(root.status);
  if (status && !run.summary) run.summary = status;
  run.urls = unique(run.urls);
  run.httpStatusCodes = [...new Set(run.httpStatusCodes)].sort((a, b) => a - b);
}

function latestUsage(ctx: ExtensionContext): UsageLike | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; usage?: UsageLike; aborted?: boolean; error?: unknown };
    if (message.role !== "assistant" || message.aborted || message.error || !message.usage) continue;
    const total = usageTokens(message.usage);
    if (total > 0) return message.usage;
  }
  return undefined;
}

function usageTokens(usage: UsageLike | undefined): number {
  if (!usage) return 0;
  return usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "ctx n/a";
  return tokens >= 1000 ? `ctx ${(tokens / 1000).toFixed(1)}k` : `ctx ${tokens}`;
}

function formatDuration(run: YosoiRun): string {
  const end = run.endedAt ?? Date.now();
  return `${((end - run.startedAt) / 1000).toFixed(1)}s`;
}

function statusGlyph(run: YosoiRun): string {
  if (run.status === "running") return "…";
  return run.status === "ok" ? "✓" : "✗";
}

function renderDashboard(ctx: ExtensionContext): void {
  if (!activated) return;
  latestContextTokens = usageTokens(latestUsage(ctx)) || latestContextTokens;
  ctx.ui.setStatus("yosoi", `yosoi ${runs.length}${active.size ? `/${active.size} running` : ""}`);
  if (!dashboardVisible || !ctx.hasUI) {
    ctx.ui.setWidget("yosoi-dashboard", undefined);
    return;
  }

  ctx.ui.setWidget("yosoi-dashboard", (_tui, _theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const header = `Yosoi runs ${runs.length} • ${formatTokens(latestContextTokens)} • /yosoi hide`;
      const rows = runs
        .slice(-6)
        .reverse()
        .map((run) => {
          const code = run.httpStatusCodes.length
            ? run.httpStatusCodes.join(",")
            : run.exitCode !== undefined
              ? `exit ${run.exitCode}`
              : "—";
          const url = run.urls[0] ? run.urls[0].replace(/^https?:\/\//, "") : run.outputPath ? `> ${run.outputPath}` : "no url";
          const detail = [code, run.fetcher, run.summary, formatDuration(run), formatTokens(run.contextTokens)].filter(Boolean).join(" • ");
          return `${statusGlyph(run)} ${truncateToWidth(`${run.workflow} ${detail} ${url}`, Math.max(0, width - 2), "…")}`;
        });
      return [truncateToWidth(header, width, "…"), ...rows].slice(0, 7);
    },
  }));
}

function isYosoiSkillPath(path: string): boolean {
  return /(?:^|[/-])yosoi(?:-|$).*\/SKILL\.md$/i.test(path) || /(?:^|[/-])yosoi-[^/]+(?:\/|$)/i.test(path);
}

function isYosoiSkillCommand(text: string): boolean {
  return /^\/skill:yosoi(?:-|$)/i.test(text.trim());
}

function activate(ctx: ExtensionContext): void {
  activated = true;
  renderDashboard(ctx);
}

async function handleYosoiCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  activate(ctx);
  const { command, target } = parseArgs(args);
  if (command === "dashboard") {
    dashboardVisible = true;
    renderDashboard(ctx);
    ctx.ui.notify("Yosoi dashboard shown", "info");
    return;
  }
  if (command === "hide") {
    dashboardVisible = false;
    renderDashboard(ctx);
    return;
  }
  if (command === "clear") {
    runs.length = 0;
    active.clear();
    latestContextTokens = usageTokens(latestUsage(ctx)) || undefined;
    renderDashboard(ctx);
    ctx.ui.notify("Yosoi dashboard cleared", "info");
    return;
  }

  ctx.ui.setEditorText(workflowPrompts[command](target));
  ctx.ui.notify(`Yosoi ${command} workflow prompt loaded`, "info");
}

export default function (pi: ExtensionAPI) {
  activated = false;
  runs.length = 0;
  active.clear();
  latestContextTokens = undefined;
  dashboardVisible = true;

  pi.registerCommand("yosoi", {
    description: "Prefill a Yosoi workflow prompt or show the Yosoi run dashboard",
    getArgumentCompletions: completions,
    handler: handleYosoiCommand,
  });

  pi.on("session_start", (_event, ctx) => {
    renderDashboard(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (isYosoiSkillCommand(event.text)) activate(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "read" && isYosoiSkillPath(String((event.input as { path?: unknown }).path ?? ""))) {
      activate(ctx);
      return;
    }
    if (!activated || event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!isYosoiShellCommand(command)) return;

    const run: YosoiRun = {
      id: event.toolCallId,
      command,
      workflow: extractWorkflow(command),
      urls: extractUrls(command),
      startedAt: Date.now(),
      status: "running",
      httpStatusCodes: [],
      outputPath: extractRedirectPath(command),
      contextTokens: usageTokens(latestUsage(ctx)) || undefined,
    };
    runs.push(run);
    while (runs.length > 25) runs.shift();
    active.set(event.toolCallId, run);
    renderDashboard(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    const run = active.get(event.toolCallId);
    if (!run) return;

    active.delete(event.toolCallId);
    run.endedAt = Date.now();
    run.status = event.isError ? "error" : "ok";
    run.contextTokens = usageTokens(latestUsage(ctx)) || run.contextTokens;

    const output = textFromContent(event.content);
    run.urls = unique([...run.urls, ...extractUrls(output)]);
    const exit = output.match(/Command exited with code (\d+)/);
    if (exit) run.exitCode = Number(exit[1]);
    if (event.isError) run.error = output.split("\n").slice(-2).join(" ").trim() || "command failed";

    const payload = firstJsonObject(output) ?? (run.outputPath ? await readSmallJsonArtifact(ctx.cwd, run.outputPath) : undefined);
    if (payload) applyJsonSummary(run, payload);
    renderDashboard(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!activated) return;
    latestContextTokens = usageTokens(latestUsage(ctx)) || latestContextTokens;
    renderDashboard(ctx);
  });
}
