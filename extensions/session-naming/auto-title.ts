/** Session title generation for Pi sessions. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
  type SessionInfo,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_PI_CONFIG, loadPiConfig, type PiConfig, type SessionTitleGenerationConfig } from "./config.js";
import { isAutoTitleModelValue, parseTitleModelRef, pickAutoTitleModel } from "./model-selection.js";
import { collectProjectMetadata, formatProjectMetadata, type ProjectMetadata } from "./project-metadata.js";
import { buildSessionTranscriptBlock } from "./session-transcript.js";
import { hasTemporaryAutoTitle, markAutoTitle, shouldSkipAutoTitle } from "./state.js";
import { emitSessionTitleMessage } from "./title-message.js";
import { shouldCreateInitialTitlePending } from "./title-scheduling.js";
import {
  fallbackDatetime,
  formatTitleTagCatalog,
  ISO_FALLBACK_RE,
  isTrivialInput,
  normalizeTitle,
  resolveTitleTags,
} from "./title-utils.js";

export {
  fallbackDatetime,
  isTrivialInput,
  normalizeTitle,
} from "./title-utils.js";

type PendingTitle = {
  firstPrompt: string;
  rawInput?: string;
  commandName?: string;
  waitTurns: number;
  turnsSeen: number;
  reason: "initial" | "temporary-retry" | "temporary-fallback" | "manual-auto";
  force?: boolean;
};

type TitleResult = {
  title: string;
  temporary: boolean;
};

type WorkspaceContext = {
  sessionTitles: string[];
  git?: { branch?: string; dirty?: string[] };
  projects: ProjectMetadata[];
  trackedFiles?: string[];
};

const SESSION_EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SYSTEM_TEMPLATE = readFileSync(resolve(SESSION_EXTENSION_DIR, "prompt-title-system.md"), "utf8");
const DEFAULT_REQUEST_TEMPLATE = readFileSync(resolve(SESSION_EXTENSION_DIR, "prompt-title-request.md"), "utf8");

const NO_TEMPERATURE_APIS = new Set(["openai-codex-responses"]);
const COMMAND_WAIT_TURNS = 3;
const TEMPORARY_RETRY_AFTER_TURNS = 10;
const MAX_TEMPORARY_TITLE_RETRIES = 3;

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => (Object.hasOwn(vars, key) ? vars[key] : whole));
}

function firstTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserPrompt(branch: SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message.role === "user") return firstTextContent(entry.message.content);
  }
  return undefined;
}

function isCommandInput(text: string): boolean {
  return /^\s*\/[\w:-]+/.test(text);
}

function commandName(text: string): string | undefined {
  return text.match(/^\s*\/([^\s]+)/)?.[1]?.toLowerCase();
}

function sessionTitle(session: SessionInfo): string | undefined {
  return session.name?.trim() || session.firstMessage?.trim() || undefined;
}

async function collectSessionTitles(ctx: ExtensionContext): Promise<string[]> {
  try {
    const current = ctx.sessionManager.getSessionFile();
    const dir = SettingsManager.create(ctx.cwd, getAgentDir()).getSessionDir();
    return (await SessionManager.list(ctx.cwd, dir))
      .filter((s) => s.path !== current)
      .map(sessionTitle)
      .filter((t): t is string => Boolean(t))
      .slice(0, 15);
  } catch {
    return [];
  }
}

async function collectGit(pi: ExtensionAPI): Promise<WorkspaceContext["git"]> {
  try {
    const [br, st] = await Promise.all([
      pi.exec("git", ["branch", "--show-current"], { timeout: 1500 }),
      pi.exec("git", ["status", "--short"], { timeout: 1500 }),
    ]);
    return {
      branch: br.stdout.trim() || undefined,
      dirty: st.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 15),
    };
  } catch {
    return undefined;
  }
}

async function collectTrackedFiles(pi: ExtensionAPI): Promise<string[]> {
  try {
    const r = await pi.exec("git", ["ls-files"], { timeout: 1500 });
    return r.stdout.split("\n").filter(Boolean).slice(0, 30);
  } catch {
    return [];
  }
}

async function collectWorkspace(pi: ExtensionAPI, ctx: ExtensionContext): Promise<WorkspaceContext> {
  const [sessionTitles, git, trackedFiles] = await Promise.all([collectSessionTitles(ctx), collectGit(pi), collectTrackedFiles(pi)]);
  return {
    sessionTitles,
    git,
    projects: collectProjectMetadata(ctx.cwd),
    trackedFiles,
  };
}

function configuredTitleMaxLength(titleConfig: SessionTitleGenerationConfig): number {
  const value = titleConfig.maxLength;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 52;
}

function configuredScopeMaxLength(titleConfig: SessionTitleGenerationConfig): number {
  const value = titleConfig.scopeMaxLength;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 12;
}

function configuredTitleRetries(titleConfig: SessionTitleGenerationConfig): number {
  const value = titleConfig.retries;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3;
}

function shouldUseTags(titleConfig: SessionTitleGenerationConfig): boolean {
  return titleConfig.useTags !== false;
}

function languageInstruction(language: string): string {
  const trimmed = language.trim();
  if (!trimmed || trimmed === "auto") {
    return "Use the same natural language as the user's messages. If multiple user languages appear, prefer the latest substantive user message.";
  }
  return `Use this natural language for the title description: ${trimmed}.`;
}

function buildSystemPrompt(titleConfig: SessionTitleGenerationConfig): string {
  const maxLen = configuredTitleMaxLength(titleConfig);
  const useTags = shouldUseTags(titleConfig);
  const tags = resolveTitleTags({
    builtinTags: titleConfig.builtinTags,
    tags: titleConfig.tags,
  });
  const tagCatalog = formatTitleTagCatalog(tags);
  const tagNames = tags.map((tag) => tag.name);
  const emojiRule = titleConfig.emojis
    ? "Emojis are allowed inside the description only when they meaningfully clarify the topic."
    : "Never use emojis.";
  const formatRule = useTags
    ? "Use `<tag>(<optional-scope>): <description>` when at least one tag is available. If no tag is available, output only `<description>`."
    : "Output only `<description>` without a prefixed tag or scope.";
  const tagRule = useTags
    ? tags.length
      ? "Use only the allowed tag names from <tag-guidance>. Choose the tag whose guidance best matches the user's actual intent."
      : "No tags are configured; omit the prefixed tag and output only the description."
    : "Tags are disabled; do not output a tag, scope, colon prefix, or Conventional Commit prefix.";

  return render(DEFAULT_SYSTEM_TEMPLATE, {
    max_length: String(maxLen),
    scope_max_length: String(configuredScopeMaxLength(titleConfig)),
    emoji_rule: emojiRule,
    fallback_datetime: fallbackDatetime(),
    language_instruction: languageInstruction(titleConfig.language),
    format_rule: formatRule,
    tag_rule: tagRule,
    tag_names: tagNames.join(", ") || "(none)",
    tag_guidance: tagCatalog || "(none)",
  });
}

const DEFAULT_COMMAND_HINT =
  "This session was started with the user command `/{{command.name}}`. Make sure the title clearly reflects that command. Use a command-derived scope only when it is one single word that satisfies the scope rules; otherwise put the command name in the description.";

function buildCommandHintBlock(pending: PendingTitle): string {
  if (!pending.commandName) return "";
  const rendered = DEFAULT_COMMAND_HINT.replace(/\{\{\s*command\.name\s*\}\}/g, pending.commandName);
  return `<command-hint>\n${rendered}\n</command-hint>\n\n`;
}

function buildUserMessage(
  pending: PendingTitle,
  branch: SessionEntry[],
  titleConfig: SessionTitleGenerationConfig,
  workspace: WorkspaceContext,
): string {
  const tags = resolveTitleTags({
    builtinTags: titleConfig.builtinTags,
    tags: titleConfig.tags,
  });
  const tagNames = tags.map((tag) => tag.name);
  const ctx: string[] = [];
  ctx.push(`language: ${titleConfig.language || "auto"}`);
  ctx.push(`format: ${shouldUseTags(titleConfig) && tags.length > 0 ? "tagged" : "description-only"}`);
  ctx.push(`descriptionMaxLength: ${configuredTitleMaxLength(titleConfig)}`);
  ctx.push(`scopeMaxLength: ${configuredScopeMaxLength(titleConfig)}`);
  ctx.push(`tagNames: ${tagNames.join(", ") || "(none)"}`);
  if (workspace.projects.length) ctx.push(`projects: ${formatProjectMetadata(workspace.projects)}`);
  if (workspace.git?.branch) ctx.push(`branch: ${workspace.git.branch}`);
  if (workspace.git?.dirty?.length) ctx.push(`dirty: ${workspace.git.dirty.slice(0, 8).join(", ")}`);
  if (workspace.trackedFiles?.length) ctx.push(`files: ${workspace.trackedFiles.slice(0, 20).join(", ")}`);
  const context_block = ctx.length ? `<context>\n${ctx.join("\n")}\n</context>\n\n` : "";
  const existing_titles_block = workspace.sessionTitles?.length
    ? `<existing-titles>\n${workspace.sessionTitles.join("\n")}\n</existing-titles>\n\n`
    : "";
  const command_hint_block = buildCommandHintBlock(pending);
  const transcriptBlock = buildSessionTranscriptBlock(branch, {
    maxMessageCount: titleConfig.maxMessageCount,
    includeTools: titleConfig.includeTools,
  });
  const content_block = transcriptBlock ?? `<message>\n${pending.rawInput ?? pending.firstPrompt ?? ""}\n</message>`;

  return render(DEFAULT_REQUEST_TEMPLATE, {
    context_block,
    existing_titles_block,
    command_hint_block,
    content_block,
  }).trimEnd();
}

function parseResult(raw: string, pending: PendingTitle, titleConfig: SessionTitleGenerationConfig): TitleResult {
  const inputText = pending.rawInput ?? pending.firstPrompt;
  const inputIsTrivial = isTrivialInput(inputText);
  const normalized = normalizeTitle(raw ?? "", {
    maxLength: configuredTitleMaxLength(titleConfig),
    scopeMaxLength: configuredScopeMaxLength(titleConfig),
    useTags: shouldUseTags(titleConfig),
    tags: resolveTitleTags({
      builtinTags: titleConfig.builtinTags,
      tags: titleConfig.tags,
    }).map((tag) => tag.name),
  });
  const isFallback = ISO_FALLBACK_RE.test(normalized);
  return { title: normalized, temporary: isFallback || inputIsTrivial };
}

type ResolvedTitleModel = {
  model: Model<any>;
  auth: { apiKey?: string; headers?: Record<string, string> };
  thinking?: ThinkingLevel;
  attempts: number;
};

async function resolveTitleModels(
  ctx: ExtensionContext,
  titleConfig: SessionTitleGenerationConfig,
  pending: PendingTitle,
): Promise<ResolvedTitleModel[]> {
  const configured = titleConfig.model?.trim() || "auto";
  const currentModel = ctx.model;
  const attempts = configuredTitleRetries(titleConfig);
  const resolveAuth = async (
    model: Model<any> | undefined,
    thinking: ThinkingLevel | undefined,
    modelAttempts: number,
  ): Promise<ResolvedTitleModel | undefined> => {
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return undefined;
    return { model, auth, thinking, attempts: modelAttempts };
  };

  let primary: ResolvedTitleModel | undefined;
  if (!isAutoTitleModelValue(configured)) {
    const ref = parseTitleModelRef(configured, currentModel?.provider);
    const model = ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
    primary = await resolveAuth(model, ref?.thinking, attempts);
  } else {
    const usage = ctx.getContextUsage();
    const currentContextTokens = usage?.tokens ?? null;
    const forceCurrentContextCheck = pending.force === true && pending.reason === "manual-auto";
    const picked = pickAutoTitleModel({
      availableModels: ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
      })),
      forceCurrentContextCheck,
      currentContextTokens,
    });
    const model = picked ? ctx.modelRegistry.find(picked.provider, picked.id) : currentModel;
    primary = await resolveAuth(model, undefined, attempts);
  }

  const out: ResolvedTitleModel[] = [];
  const seen = new Set<string>();
  const push = (candidate: ResolvedTitleModel | undefined): void => {
    if (!candidate) return;
    const key = `${candidate.model.provider}/${candidate.model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  push(primary);
  push(await resolveAuth(currentModel, undefined, 1));
  return out;
}

async function requestTitle(
  model: Model<any>,
  auth: { apiKey?: string; headers?: Record<string, string> },
  thinking: ThinkingLevel | undefined,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const message = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 80,
      ...(thinking ? { reasoning: thinking } : {}),
      ...(NO_TEMPERATURE_APIS.has(model.api) ? {} : { temperature: 0.3 }),
    },
  );
  return firstTextContent(message.content);
}

async function loadConfig(ctx: ExtensionContext): Promise<PiConfig> {
  try {
    return (await loadPiConfig(ctx.cwd)).config;
  } catch {
    return DEFAULT_PI_CONFIG;
  }
}

export async function generateSessionTitleNow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: { force?: boolean; reason?: PendingTitle["reason"] } = {},
): Promise<TitleResult | undefined> {
  const config = await loadConfig(ctx);
  const titleConfig = config.session.titleGeneration;
  if (titleConfig.enabled === false) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const prompt = latestUserPrompt(branch) ?? pi.getSessionName() ?? "";
  const pending: PendingTitle = {
    firstPrompt: prompt,
    rawInput: prompt,
    waitTurns: 0,
    turnsSeen: 0,
    reason: options.reason ?? "manual-auto",
    force: options.force,
  };
  return generateTitle(pi, ctx, titleConfig, pending);
}

async function generateTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  titleConfig: SessionTitleGenerationConfig,
  pending: PendingTitle,
): Promise<TitleResult | undefined> {
  if (
    shouldSkipAutoTitle(ctx, pi, {
      allowTemporaryRetry: true,
      force: pending.force,
    })
  ) {
    return undefined;
  }

  const candidates = await resolveTitleModels(ctx, titleConfig, pending);
  if (candidates.length === 0) return undefined;

  if (ctx.hasUI) ctx.ui.setStatus("session-title", "naming session…");
  try {
    const branch = ctx.sessionManager.getBranch();
    const workspace = await collectWorkspace(pi, ctx);
    const systemPrompt = buildSystemPrompt(titleConfig);
    const userMessage = buildUserMessage(pending, branch, titleConfig, workspace);

    let usedCandidate: ResolvedTitleModel | undefined;
    let raw = "";
    let lastError: string | undefined;
    outer: for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const { model, auth, thinking } = candidate;
      for (let attempt = 1; attempt <= candidate.attempts; attempt++) {
        try {
          raw = await requestTitle(model, auth, thinking, systemPrompt, userMessage);
          if (process.env.PI_DEBUG_SESSION_TITLE) {
            console.warn(
              `[session-title] raw from ${model.provider}/${model.id}${thinking ? `:${thinking}` : ""} attempt ${attempt}: ${JSON.stringify(raw)}`,
            );
          }
          if (raw && raw.trim().length > 0) {
            usedCandidate = candidate;
            break outer;
          }
          lastError = "empty title";
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          console.warn(
            `[session-title] model ${model.provider}/${model.id}${thinking ? `:${thinking}` : ""} attempt ${attempt}/${candidate.attempts} failed: ${lastError}`,
          );
        }
      }
    }
    const candidate = usedCandidate ?? candidates[0];
    const model = candidate.model;
    const modelLabel = `${model.provider}/${model.id}${candidate.thinking ? `:${candidate.thinking}` : ""}`;
    if (!usedCandidate && lastError && ctx.hasUI) {
      ctx.ui.notify(`Title generation failed on all auto-title attempts (last: ${lastError}); using fallback title`, "warning");
    }

    if (
      shouldSkipAutoTitle(ctx, pi, {
        allowTemporaryRetry: true,
        force: pending.force,
      })
    ) {
      return undefined;
    }

    const result = parseResult(raw, pending, titleConfig);
    pi.setSessionName(result.title);
    markAutoTitle(pi, result.title, modelLabel, result.temporary);
    if (ctx.hasUI) {
      ctx.ui.setTitle(result.title);
    }
    emitSessionTitleMessage(
      pi,
      {
        title: result.title,
        actor: modelLabel,
        source: "auto",
        temporary: result.temporary,
      },
      { ctx },
    );
    return result;
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus("session-title", undefined);
  }
}

export function registerSessionAutoTitle(pi: ExtensionAPI, initialConfig = DEFAULT_PI_CONFIG): void {
  const titleConfig = initialConfig.session.titleGeneration;
  if (titleConfig.enabled === false) return;

  let pending: PendingTitle | undefined;
  let lastRawInput: string | undefined;
  let generating = false;
  let temporaryTurns = 0;
  let temporaryRetries = 0;

  function makePending(
    prompt: string,
    rawInput: string | undefined,
    reason: PendingTitle["reason"],
    _config: SessionTitleGenerationConfig,
    waitTurns?: number,
  ): PendingTitle {
    const isCmd = Boolean(rawInput && isCommandInput(rawInput));
    return {
      firstPrompt: prompt,
      rawInput,
      commandName: rawInput ? commandName(rawInput) : undefined,
      waitTurns: waitTurns ?? (isCmd ? COMMAND_WAIT_TURNS : 0),
      turnsSeen: 0,
      reason,
    };
  }

  function scheduleGeneration(ctx: ExtensionContext, snapshot = pending): void {
    if (!snapshot || generating || shouldSkipAutoTitle(ctx, pi, { allowTemporaryRetry: true })) {
      return;
    }
    generating = true;
    void (async () => {
      try {
        const config = await loadConfig(ctx);
        const result = await generateTitle(pi, ctx, config.session.titleGeneration, snapshot);
        if (pending === snapshot) pending = undefined;
        if (result?.temporary) {
          temporaryTurns = 0;
          temporaryRetries++;
        } else if (result) {
          temporaryRetries = 0;
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Title generation failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      } finally {
        generating = false;
      }
    })();
  }

  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" as const };
    lastRawInput = event.text;
    return { action: "continue" as const };
  });

  function consumeRawInputForPrompt(prompt: string): string | undefined {
    const rawInput = lastRawInput;
    lastRawInput = undefined;
    if (!rawInput) return undefined;
    if (rawInput === prompt) return rawInput;
    if (isCommandInput(rawInput)) return rawInput;
    return undefined;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const rawInput = consumeRawInputForPrompt(event.prompt);
    const config = await loadConfig(ctx);
    const currentTitleConfig = config.session.titleGeneration;
    const temporaryTitle = hasTemporaryAutoTitle(ctx);
    const shouldSkip = shouldSkipAutoTitle(ctx, pi, {
      allowTemporaryRetry: false,
    });
    if (
      !shouldCreateInitialTitlePending({
        pending: Boolean(pending),
        generating,
        titleGenerationEnabled: currentTitleConfig.enabled !== false,
        hasTemporaryTitle: temporaryTitle,
        shouldSkip,
      })
    ) {
      return;
    }

    pending = makePending(event.prompt, rawInput, "initial", currentTitleConfig);
    if (pending.waitTurns === 0) scheduleGeneration(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const config = await loadConfig(ctx);
    if (pending && !generating) {
      pending.turnsSeen++;
      if (pending.turnsSeen >= pending.waitTurns) scheduleGeneration(ctx);
      return;
    }
    if (
      !generating &&
      temporaryRetries < MAX_TEMPORARY_TITLE_RETRIES &&
      hasTemporaryAutoTitle(ctx) &&
      !shouldSkipAutoTitle(ctx, pi, { allowTemporaryRetry: true })
    ) {
      temporaryTurns++;
      if (temporaryTurns >= TEMPORARY_RETRY_AFTER_TURNS) {
        const prompt = latestUserPrompt(ctx.sessionManager.getBranch()) ?? "";
        if (prompt) {
          pending = makePending(prompt, prompt, "temporary-fallback", config.session.titleGeneration, 0);
          scheduleGeneration(ctx);
        }
      }
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (pending && !generating && pending.turnsSeen >= pending.waitTurns) scheduleGeneration(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    if (
      shouldSkipAutoTitle(ctx, pi, {
        allowTemporaryRetry: hasTemporaryAutoTitle(ctx),
      })
    ) {
      pending = undefined;
    }
  });
}

export async function runAutoTitleCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  // Fire-and-forget: don't block the slash command (or wait for the agent
  // to go idle) so the title is generated in the background while the
  // agent keeps working. The transcript message is injected by
  // `generateTitle` -> `emitSessionTitleMessage` once the LLM returns.
  void generateSessionTitleNow(pi, ctx, {
    force: true,
    reason: "manual-auto",
  })
    .then((result) => {
      if (!result && ctx.hasUI) ctx.ui.notify("Could not generate a session title for the current context.", "warning");
    })
    .catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Title generation failed: ${msg}`, "warning");
      else console.warn(`[session-title] manual /rename auto failed: ${msg}`);
    });
}
