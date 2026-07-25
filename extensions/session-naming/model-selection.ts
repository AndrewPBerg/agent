import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type AutoTitleModelCandidate = {
  provider: string;
  id: string;
};

export type AvailableModelRef = AutoTitleModelCandidate & {
  contextWindow?: number | null;
};

export type ParsedTitleModelRef = AutoTitleModelCandidate & {
  thinking?: ThinkingLevel;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh"]);

export const AUTO_TITLE_MODEL_CANDIDATES: AutoTitleModelCandidate[] = [
  { provider: "deepseek", id: "deepseek-v4-flash" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "github-copilot", id: "gpt-5.4-mini" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "opencode", id: "big-pickle" },
];

export function isAutoTitleModelValue(value: string | undefined): boolean {
  return !value || value.trim() === "" || value.trim() === "auto";
}

export function parseTitleModelRef(value: string | undefined, defaultProvider?: string): ParsedTitleModelRef | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "auto") return undefined;

  const slash = trimmed.indexOf("/");
  const provider = slash > 0 ? trimmed.slice(0, slash) : defaultProvider;
  let id = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  if (!provider || !id) return undefined;

  let thinking: ThinkingLevel | undefined;
  const colon = id.lastIndexOf(":");
  if (colon > 0) {
    const suffix = id.slice(colon + 1);
    if (!THINKING_LEVELS.has(suffix as ThinkingLevel)) return undefined;
    thinking = suffix as ThinkingLevel;
    id = id.slice(0, colon);
  }
  if (!id) return undefined;
  return { provider, id, thinking };
}

export function shouldSkipAutoTitleCandidateForContext(args: {
  forceCurrentContextCheck: boolean;
  currentContextTokens: number | null | undefined;
  candidateContextWindow: number | null | undefined;
}): boolean {
  if (!args.forceCurrentContextCheck) return false;
  if (args.currentContextTokens === null || args.currentContextTokens === undefined) return false;
  if (args.candidateContextWindow === null || args.candidateContextWindow === undefined) {
    return false;
  }
  return args.currentContextTokens > args.candidateContextWindow;
}

export function pickAutoTitleModels(args: {
  availableModels: AvailableModelRef[];
  forceCurrentContextCheck: boolean;
  currentContextTokens: number | null | undefined;
}): AvailableModelRef[] {
  const out: AvailableModelRef[] = [];
  for (const candidate of AUTO_TITLE_MODEL_CANDIDATES) {
    const model = args.availableModels.find((available) => available.provider === candidate.provider && available.id === candidate.id);
    if (!model) continue;
    if (
      shouldSkipAutoTitleCandidateForContext({
        forceCurrentContextCheck: args.forceCurrentContextCheck,
        currentContextTokens: args.currentContextTokens,
        candidateContextWindow: model.contextWindow,
      })
    ) {
      continue;
    }
    out.push(model);
  }
  return out;
}

export function pickAutoTitleModel(args: {
  availableModels: AvailableModelRef[];
  forceCurrentContextCheck: boolean;
  currentContextTokens: number | null | undefined;
}): AvailableModelRef | undefined {
  return pickAutoTitleModels(args)[0];
}
