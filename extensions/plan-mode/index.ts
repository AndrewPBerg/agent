import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "plan-mode";
const QUESTION_TOOL = "plan_mode_question";
const DISABLED_TOOLS = new Set(["edit", "write"]);
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "flameframe_inspect", "flameframe_process", "flameframe_zoom", QUESTION_TOOL];

const PLAN_PROMPT = `
PLAN MODE:
- You are in read-only planning mode. Do not edit product/source files or implement changes.
- Use tools only to inspect, search, understand, and collect bounded planning evidence. Bash is restricted to read-only commands plus Yosoi artifacts under .yosoi/.
- Consider relevant skills before finalizing, but only when they materially improve the plan:
  - Repo/code structure, symbols, diffs, dependencies, or tests: use SUPP first.
  - Web/source discovery or research packets: use Yosoi search/fetch/research and save artifacts under .yosoi/.
  - Video, captions, timestamps, or frame evidence: use FlameFrame tools.
  - Ambiguous product/design direction or option-space exploration: use brainstorming.
- Cite concrete evidence in the plan: files/symbols, command outputs, Yosoi artifact paths/URLs, FlameFrame timestamps, or explicit assumptions.
- Do not bloat planning with unrelated research; stop when additional evidence will not change the implementation plan.
- Ask concise structured questions with plan_mode_question only when a preference or tradeoff materially changes the plan.
- Resolve discoverable facts before finalizing.
- When ready, produce exactly one final plan block:
<proposed_plan>
# Title
## Summary
...
## Key Changes
...
## Test Plan
...
## Assumptions
...
</proposed_plan>
- Do not implement until the user chooses /plan continue or /plan clear-context.
`;

type Phase = "idle" | "planning" | "ready";

interface PlanState {
  version: 1;
  phase: Phase;
  objective?: string;
  proposedPlan?: string;
  planFile?: string;
  toolsBeforePlan?: string[];
  updatedAt: number;
}

function nowState(patch: Omit<Partial<PlanState>, "version" | "updatedAt">): PlanState {
  return { version: 1, phase: "idle", ...patch, updatedAt: Date.now() };
}

function textFromMessage(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: { text: string }) => part.text)
    .join("\n");
}

function extractProposedPlan(text: string): string | undefined {
  const tagged = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)?.[1]?.trim();
  if (tagged) return tagged;

  const headingIndex = text.search(/^#{1,3}\s+.*plan.*$/im);
  if (headingIndex >= 0) {
    const candidate = text.slice(headingIndex).trim();
    if (/##\s+(summary|key changes|test plan|assumptions)/i.test(candidate)) return candidate;
  }

  return undefined;
}

function compact(value: string, max = 96): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function isAllowedYosoiArtifactCommand(command: string): boolean {
  if (/[;`]|\$\(|\|\||(?<!>)\|(?!\|)/.test(command)) return false;
  const parts = command
    .split(/&&/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  return parts.every((part) => {
    if (/^mkdir\s+-p\s+(?:\.\/)?\.yosoi(?:\/[A-Za-z0-9._/-]+)?\s*$/i.test(part)) return true;
    if (!/^uvx\s+yosoi\s+(search|fetch|crawl|map|research\s+(init|observe|status))\b/i.test(part)) return false;

    const output = part.match(/\s(?:--output|-o)\s+(\S+)/);
    if (output) {
      const target = output[1].replace(/^['"]|['"]$/g, "");
      if (!target.startsWith(".yosoi/") && !target.startsWith("./.yosoi/")) return false;
    }

    const redirect = part.match(/(?:^|\s)(>{1,2})\s*(\S+)\s*$/);
    if (!redirect) return true;
    const target = redirect[2].replace(/^['"]|['"]$/g, "");
    return target.startsWith(".yosoi/") || target.startsWith("./.yosoi/");
  });
}

function isSafePlanningCommand(command: string): boolean {
  if (isAllowedYosoiArtifactCommand(command)) return true;

  const destructive = [
    /(^|[^<])>(?!>)/,
    />>/,
    /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/i,
    /\b(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone))\b/i,
    /\b(npm\s+(install|uninstall|update|ci|link|publish)|pnpm\s+(add|remove|install|publish)|yarn\s+(add|remove|install|publish))\b/i,
    /\b(pip\s+(install|uninstall)|uv\s+(add|remove|sync)|cargo\s+(build|run|test|install|publish))\b/i,
    /\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
    /\b(vim?|nano|emacs|code|subl)\b/i,
  ];
  if (destructive.some((pattern) => pattern.test(command))) return false;

  const trimmed = command.trim();
  return /^(pwd|ls|find|fd|rg|grep|git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)|supp\b|cat\b|head\b|tail\b|sed\s+-n\b|awk\b|jq\b|wc\b|sort\b|uniq\b|diff\b|file\b|stat\b|du\b|df\b|tree\b|which\b|type\b|env\b|printenv\b|uname\b|whoami\b|id\b|date\b|test\b|cmp\b|node\s+--version|python\s+--version|pnpm\s+(list|ls|why|view|info|outdated)|npm\s+(list|ls|view|info|outdated))\b/i.test(
    trimmed,
  );
}

function latestState(ctx: ExtensionContext): PlanState {
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: PlanState };
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data?.version === 1) return entry.data;
  }
  return nowState({ phase: "idle" });
}

function uniqueExisting(pi: ExtensionAPI, names: string[]): string[] {
  const all = new Set((pi.getAllTools?.() ?? []).map((tool: { name: string }) => tool.name));
  return [...new Set(names)].filter((name) => all.size === 0 || all.has(name));
}

export default function planMode(pi: ExtensionAPI) {
  let state: PlanState = nowState({ phase: "idle" });

  function persist(ctx?: ExtensionContext) {
    pi.appendEntry(CUSTOM_TYPE, state);
    if (ctx) updateStatus(ctx);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (state.phase === "planning") ctx.ui.setStatus(CUSTOM_TYPE, "plan:planning");
    else if (state.phase === "ready") ctx.ui.setStatus(CUSTOM_TYPE, "plan:ready");
    else ctx.ui.setStatus(CUSTOM_TYPE, undefined);
  }

  function enablePlanningTools() {
    if (!state.toolsBeforePlan) state = { ...state, toolsBeforePlan: pi.getActiveTools?.() ?? undefined };
    pi.setActiveTools(uniqueExisting(pi, PLAN_TOOLS));
  }

  function restoreTools() {
    const previous = state.toolsBeforePlan;
    if (previous?.length) pi.setActiveTools(previous);
  }

  async function writePlanFile(ctx: any, plan: string): Promise<string> {
    const piHome = process.env.PI_HOME || join(homedir(), ".pi");
    const dir = join(piHome, "plans");
    await mkdir(dir, { recursive: true });
    const slug =
      compact(state.objective ?? "plan", 48)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "plan";
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.md`);
    await writeFile(file, plan.endsWith("\n") ? plan : `${plan}\n`, "utf8");
    state = { ...state, planFile: file, updatedAt: Date.now() };
    persist(ctx);
    return file;
  }

  function clearPlan(ctx: ExtensionContext, message = "Plan mode cleared.") {
    restoreTools();
    state = nowState({ phase: "idle" });
    persist(ctx);
    ctx.ui.notify(message, "info");
  }

  async function startPlanning(objective: string | undefined, ctx: any) {
    restoreTools();
    state = nowState({ phase: "planning", objective: objective?.trim() || undefined, toolsBeforePlan: pi.getActiveTools?.() ?? undefined });
    enablePlanningTools();
    persist(ctx);
    ctx.ui.notify("Plan mode enabled. Write tools are blocked until /plan continue or /plan clear-context.", "info");
    if (objective?.trim()) {
      pi.sendUserMessage(`Plan this task before implementation.\n\nObjective:\n${objective.trim()}`);
    }
  }

  async function continueCurrent(ctx: any) {
    if (!state.proposedPlan) {
      ctx.ui.notify("No proposed plan is ready yet.", "warning");
      return;
    }
    const plan = state.proposedPlan;
    const planFile = state.planFile ?? (await writePlanFile(ctx, plan));
    restoreTools();
    state = nowState({ phase: "idle", objective: state.objective, proposedPlan: plan, planFile });
    persist(ctx);
    await ctx.waitForIdle?.();
    pi.sendUserMessage(
      `Implement the approved plan from ${planFile}. Read that file first, then execute it in this current session. Verify with the narrowest meaningful checks.`,
    );
  }

  async function clearContextAndImplement(ctx: any) {
    if (!state.proposedPlan) {
      ctx.ui.notify("No proposed plan is ready yet.", "warning");
      return;
    }
    const plan = state.proposedPlan;
    const planFile = state.planFile ?? (await writePlanFile(ctx, plan));
    const parentSession = ctx.sessionManager.getSessionFile?.();
    restoreTools();
    state = nowState({ phase: "idle", objective: state.objective, proposedPlan: plan, planFile });
    persist(ctx);
    await ctx.waitForIdle?.();

    const kickoff = `Implement the approved plan from ${planFile}.\n\nRead that file first and use it as the durable source of truth. Treat prior planning context as unavailable unless it is written in the plan. Verify with the narrowest meaningful checks.`;
    const result = await ctx.newSession({
      parentSession,
      withSession: async (replacementCtx: any) => {
        await replacementCtx.sendUserMessage(kickoff);
      },
    });
    if (result?.cancelled) ctx.ui.notify("New session cancelled; plan was saved to " + planFile, "warning");
  }

  async function showReadyMenu(ctx: any) {
    if (!state.proposedPlan) {
      ctx.ui.notify(
        state.phase === "planning" ? "Still planning. Ask the agent to produce <proposed_plan> when ready." : "No active plan.",
        "info",
      );
      return;
    }
    const choice = await ctx.ui.select("Plan ready — what next?", [
      "Continue in current context",
      "Clear context and implement",
      "Stay in plan mode",
      "Discard plan",
      "Save plan only",
    ]);
    if (choice === "Continue in current context") await continueCurrent(ctx);
    else if (choice === "Clear context and implement") await clearContextAndImplement(ctx);
    else if (choice === "Stay in plan mode") {
      state = { ...state, phase: "planning", proposedPlan: undefined, updatedAt: Date.now() };
      enablePlanningTools();
      persist(ctx);
      ctx.ui.notify("Plan mode still active. Send feedback to revise the plan.", "info");
    } else if (choice === "Discard plan") clearPlan(ctx, "Plan discarded.");
    else if (choice === "Save plan only") {
      const file = await writePlanFile(ctx, state.proposedPlan);
      ctx.ui.notify(`Plan saved to ${file}`, "info");
    }
  }

  pi.registerFlag("plan", { description: "Start in read-only plan mode", type: "boolean", default: false });

  pi.registerTool({
    name: QUESTION_TOOL,
    label: "Plan Question",
    description: "Ask the user concise structured questions while drafting an implementation plan.",
    promptSnippet: "Ask 1-3 concise planning questions with options when user preference affects the implementation plan.",
    promptGuidelines: [
      "Use plan_mode_question only during plan mode and only for important preferences or tradeoffs that cannot be discovered from the repo.",
    ],
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
      },
      required: ["question", "options"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = Array.isArray(params.options) ? params.options.map(String).filter(Boolean).slice(0, 6) : [];
      const answer = ctx.mode === "tui" ? await ctx.ui.select(String(params.question), [...options, "Other / no preference"]) : undefined;
      return {
        content: [
          {
            type: "text",
            text: answer ? `User selected: ${answer}` : "No interactive answer. State a low-risk assumption or ask in plain text.",
          },
        ],
        details: { answer },
      };
    },
  });

  pi.registerCommand("plan", {
    description: "Codex-style plan mode: read-only planning, then continue or clear context before implementing",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["continue", "clear-context", "stay", "discard", "status", "save", "exit"];
      const items = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const arg = raw.toLowerCase();

      if (!raw) {
        if (state.phase === "ready") await showReadyMenu(ctx);
        else if (state.phase === "planning") ctx.ui.notify("Plan mode active. Ask for a <proposed_plan>, or use /plan exit.", "info");
        else await startPlanning(undefined, ctx);
        return;
      }

      if (arg === "status") {
        ctx.ui.notify(
          [
            `Plan phase: ${state.phase}`,
            state.objective ? `Objective: ${compact(state.objective)}` : undefined,
            state.planFile ? `File: ${state.planFile}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        return;
      }
      if (arg === "continue" || arg === "implement") return continueCurrent(ctx);
      if (arg === "clear-context" || arg === "clear" || arg === "new") return clearContextAndImplement(ctx);
      if (arg === "discard" || arg === "exit" || arg === "off") return clearPlan(ctx);
      if (arg === "stay") {
        state = { ...state, phase: "planning", proposedPlan: undefined, updatedAt: Date.now() };
        enablePlanningTools();
        persist(ctx);
        ctx.ui.notify("Staying in plan mode. Send revision feedback.", "info");
        return;
      }
      if (arg === "save") {
        if (!state.proposedPlan) ctx.ui.notify("No proposed plan is ready yet.", "warning");
        else ctx.ui.notify(`Plan saved to ${await writePlanFile(ctx, state.proposedPlan)}`, "info");
        return;
      }

      await startPlanning(raw, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    state = latestState(ctx);
    if (pi.getFlag?.("plan") === true && state.phase === "idle")
      state = nowState({ phase: "planning", toolsBeforePlan: pi.getActiveTools?.() ?? undefined });
    if (state.phase === "planning") enablePlanningTools();
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (state.phase !== "planning") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_PROMPT}` };
  });

  pi.on("tool_call", (event) => {
    if (state.phase !== "planning") return;
    if (DISABLED_TOOLS.has(event.toolName))
      return { block: true, reason: "Plan mode is read-only. Use /plan continue or /plan exit first." };
    if (event.toolName === "bash" && !isSafePlanningCommand(String(event.input?.command ?? ""))) {
      return { block: true, reason: `Plan mode blocked non-read-only bash command: ${event.input?.command ?? ""}` };
    }
  });

  pi.on("agent_end", (event, ctx) => {
    if (state.phase !== "planning") return;
    const lastAssistant = [...(event.messages ?? [])].reverse().map(textFromMessage).find(Boolean);
    const plan = lastAssistant ? extractProposedPlan(lastAssistant) : undefined;
    if (!plan) return;
    state = { ...state, phase: "ready", proposedPlan: plan, updatedAt: Date.now() };
    persist(ctx);
    ctx.ui.notify("Plan ready. Run /plan to choose: continue, clear context and implement, stay, save, or discard.", "info");
  });

  pi.on("session_compact", (_event, ctx) => {
    persist(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(CUSTOM_TYPE, undefined);
  });
}

export const __planModeTest = { extractProposedPlan, isSafePlanningCommand };
