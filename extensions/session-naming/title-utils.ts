const TRIVIAL_INPUT_RE =
  /^\s*(hi+|hello+|hey+|yo+|sup|moin|servus|hallo|hola|test+|ok(ay)?|lol|lmao|huh|what|sure|thx|ty|ping|gm|gn|thanks|thank\s*you|\?+|\.+)\s*[!?.]*\s*$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape bytes are the intended input.
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ASCII controls is the intended behavior.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const TUI_BORDER_RE = /[\u2500-\u257f\u2580-\u259f]/;
const TAG_RE = /^[a-z][a-z0-9-]*$/;
const SCOPE_RE = /^[a-z0-9]+$/;
const DEFAULT_SCOPE_MAX_LENGTH = 12;

export type TitleTag = {
  name: string;
  description?: string;
};

export type TitleTagInput = string | readonly [string, string?] | TitleTag;

export const BUILTIN_TITLE_TAGS: readonly TitleTag[] = [
  { name: "feat", description: "Use for a new user-facing feature or capability." },
  { name: "add", description: "Use for adding a small missing item without implying a full feature." },
  { name: "fix", description: "Use for correcting broken, incorrect, or failing behavior." },
  { name: "refactor", description: "Use for restructuring code without changing intended behavior." },
  { name: "perf", description: "Use for performance, latency, memory, or efficiency improvements." },
  { name: "style", description: "Use for formatting, visual polish, naming, or non-behavioral style changes." },
  { name: "test", description: "Use for adding or changing automated tests or test fixtures." },
  { name: "bench", description: "Use for benchmarks, profiling harnesses, or performance measurements." },
  { name: "docs", description: "Use for documentation, README, comments, guides, or changelog work." },
  { name: "build", description: "Use for packaging, bundling, dependency, release, or build-system changes." },
  { name: "ops", description: "Use for deployment, infrastructure, runtime operations, or maintenance workflows." },
  { name: "chore", description: "Use for routine maintenance that does not fit a more specific tag." },
  { name: "onboard", description: "Use for first-run setup, user onboarding, or introductory guidance." },
  { name: "scaffold", description: "Use for creating the initial structure of a project, package, module, or extension." },
  { name: "bootstrap", description: "Use for wiring enough foundation/configuration to make something usable." },
  { name: "init", description: "Use for initializing a repo, package, module, config, or generated starting point." },
  { name: "skill", description: "Use for creating, modifying, reviewing, or documenting Pi agent skills." },
  { name: "analyze", description: "Use for inspecting existing behavior, code, data, or options without changing it yet." },
  { name: "audit", description: "Use for systematic quality, security, compliance, or correctness checks." },
  { name: "review", description: "Use for code review, design review, or evaluating proposed changes." },
  { name: "research", description: "Use for external or exploratory information gathering." },
  { name: "investigate", description: "Use for diagnosing an unknown cause or narrowing down a problem." },
  { name: "debug", description: "Use for reproducing and fixing a specific bug or failure." },
  { name: "troubleshoot", description: "Use for operational or environment problem solving." },
  { name: "plan", description: "Use for implementation plans, migration plans, or step sequencing." },
  { name: "design", description: "Use for architecture, schema, API, UX, or component design." },
  { name: "propose", description: "Use for suggesting options, alternatives, or recommendations." },
  { name: "compare", description: "Use for contrasting two or more options, tools, designs, or outputs." },
  { name: "evaluate", description: "Use for judging fitness, usability, quality, or trade-offs against criteria." },
  { name: "explain", description: "Use for explaining how or why something works." },
  { name: "summarize", description: "Use for condensing existing information into a shorter form." },
  { name: "document", description: "Use for producing structured documentation or records beyond small docs edits." },
  { name: "configure", description: "Use for settings, options, environment, or integration configuration." },
  { name: "migrate", description: "Use for moving code, data, APIs, config, or versions from one shape to another." },
  { name: "prototype", description: "Use for quick experimental implementations or proofs of concept." },
  { name: "validate", description: "Use for verifying behavior, testing manually, or confirming assumptions." },
  { name: "wire", description: "Use for connecting existing pieces, commands, handlers, or integrations." },
] as const;

export const CONVENTIONAL_TITLE_RE = /^([a-z][a-z0-9-]*)(?:\(([^)]*)\))?:\s(.+\S)$/iu;
export const ISO_FALLBACK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export type TitleTagConfig = {
  builtinTags: boolean;
  tags: readonly TitleTagInput[];
};

export type NormalizeTitleOptions = {
  maxLength: number;
  scopeMaxLength?: number;
  useTags: boolean;
  tags: readonly string[];
};

export function resolveTitleTags(config: TitleTagConfig): TitleTag[] {
  const out: TitleTag[] = config.builtinTags ? [...BUILTIN_TITLE_TAGS] : [];
  const seen = new Set(out.map((tag) => tag.name));
  for (const raw of config.tags ?? []) {
    const tag = normalizeTagInput(raw);
    if (!tag) continue;
    if (seen.has(tag.name)) continue;
    seen.add(tag.name);
    out.push(tag);
  }
  return out;
}

export function formatTitleTagCatalog(tags: readonly TitleTag[]): string {
  return tags.map((tag) => (tag.description ? `- ${tag.name} — ${tag.description}` : `- ${tag.name}`)).join("\n");
}

function normalizeTagInput(raw: TitleTagInput): TitleTag | undefined {
  let name: unknown;
  let description: unknown;
  if (typeof raw === "string") {
    name = raw;
  } else if (Array.isArray(raw)) {
    [name, description] = raw;
  } else if (raw && typeof raw === "object") {
    ({ name, description } = raw as TitleTag);
  }
  if (typeof name !== "string") return undefined;
  const normalizedName = name.trim().toLowerCase();
  if (!TAG_RE.test(normalizedName)) return undefined;
  const normalizedDescription = typeof description === "string" ? description.trim() : "";
  return normalizedDescription ? { name: normalizedName, description: normalizedDescription } : { name: normalizedName };
}

export function fallbackDatetime(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offMinutes = -now.getTimezoneOffset();
  const sign = offMinutes >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMinutes) / 60));
  const offM = pad(Math.abs(offMinutes) % 60);
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${date}T${time}${sign}${offH}:${offM}`;
}

export function isTrivialInput(text: string | undefined | null): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 3) return true;
  return TRIVIAL_INPUT_RE.test(t);
}

function cleanLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE_RE, "")
    .replace(CONTROL_CHARS_RE, "")
    .trim()
    .replace(/^[\s>*_~`"'\u201C\u2018-]+/, "")
    .replace(/[`"'\u201D\u2019\s*_~]+$/, "")
    .trim()
    .replace(/[.\s]+$/g, "");
}

function configuredMaxLength(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 52;
}

function configuredScopeMaxLength(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : DEFAULT_SCOPE_MAX_LENGTH;
}

function titleParts(line: string): { tag: string; scope?: string; description: string } | undefined {
  const match = line.match(CONVENTIONAL_TITLE_RE);
  if (!match) return undefined;
  const rawScope = match[2]?.trim();
  return {
    tag: match[1]!.toLowerCase(),
    ...(rawScope ? { scope: rawScope.toLowerCase() } : {}),
    description: match[3]!,
  };
}

function formatTitleParts(parts: { tag: string; scope?: string; description: string }): string {
  return `${parts.tag}${parts.scope ? `(${parts.scope})` : ""}: ${parts.description}`;
}

function titleDescription(line: string): string | undefined {
  return titleParts(line)?.description;
}

function isValidScope(scope: string | undefined, maxLength: number): boolean {
  if (scope === undefined) return true;
  if (scope.length === 0 || scope.length > maxLength) return false;
  if (!SCOPE_RE.test(scope)) return false;
  return /[a-z]/.test(scope);
}

function validTaggedTitle(line: string, maxLength: number, scopeMaxLength: number, tags: readonly string[]): string | undefined {
  const parts = titleParts(line);
  if (!parts) return undefined;
  if (!tags.includes(parts.tag)) return undefined;
  if (!isValidScope(parts.scope, scopeMaxLength)) return undefined;
  if (parts.description.length > maxLength) return undefined;
  return formatTitleParts(parts);
}

function isValidPlainTitle(line: string, maxLength: number): boolean {
  if (!line || line.length > maxLength) return false;
  if (TUI_BORDER_RE.test(line)) return false;
  return true;
}

function stripTag(line: string): string | undefined {
  const description = titleDescription(line);
  return description ? cleanLine(description) : undefined;
}

function isValidTitleCandidate(line: string, options: Required<NormalizeTitleOptions>): string | undefined {
  if (TUI_BORDER_RE.test(line)) return undefined;
  if (ISO_FALLBACK_RE.test(line)) return line;

  const maxLength = configuredMaxLength(options.maxLength);
  const scopeMaxLength = configuredScopeMaxLength(options.scopeMaxLength);
  const effectiveUseTags = options.useTags && options.tags.length > 0;
  if (effectiveUseTags) {
    return validTaggedTitle(line, maxLength, scopeMaxLength, options.tags);
  }

  const untagged = stripTag(line) ?? line;
  return isValidPlainTitle(untagged, maxLength) ? untagged : undefined;
}

function extractTitlePrefix(line: string, options: Required<NormalizeTitleOptions>): string | undefined {
  const limit = Math.min(line.length, 260);
  for (let end = limit; end > 0; end--) {
    const previous = line[end - 1];
    const next = line[end];
    if (next && /[\p{L}\p{N}._/-]/u.test(previous ?? "") && /[\p{L}\p{N}._/-]/u.test(next)) continue;
    const candidate = cleanLine(line.slice(0, end));
    const valid = isValidTitleCandidate(candidate, options);
    if (valid) return valid;
  }
  return undefined;
}

export function normalizeTitle(raw: string, options: NormalizeTitleOptions): string {
  const normalizedOptions: Required<NormalizeTitleOptions> = {
    maxLength: configuredMaxLength(options.maxLength),
    scopeMaxLength: configuredScopeMaxLength(options.scopeMaxLength),
    useTags: options.useTags,
    tags: options.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  };
  const lines = (raw ?? "").split(/\r?\n/).map(cleanLine).filter(Boolean);

  for (const line of lines) {
    const valid = isValidTitleCandidate(line, normalizedOptions);
    if (valid) return valid;
    if (TUI_BORDER_RE.test(line)) {
      const prefix = extractTitlePrefix(line, normalizedOptions);
      if (prefix) return prefix;
    }
  }

  return fallbackDatetime();
}
