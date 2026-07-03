import { execFile as execFileCallback } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const execFile = promisify(execFileCallback);
const STATUS_KEY = "combinations";
const DEFAULT_MAX_CARDS = 5;

const combinationSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  priority: z.number().optional().default(0),
  when: z
    .object({
      prompts: z.array(z.string()).optional().default([]),
      fileExtensions: z.array(z.string()).optional().default([]),
      tools: z.array(z.string()).optional().default([]),
    })
    .optional()
    .default({}),
  guidance: z.string().min(1),
  preferredTools: z.array(z.string()).optional().default([]),
  obligations: z.array(z.string()).optional().default([]),
  maxPromptLines: z.number().int().positive().optional(),
});

type ParsedCombination = z.infer<typeof combinationSchema>;
export type Combination = Omit<ParsedCombination, "when"> & {
  sourcePath: string;
  when: { prompts: string[]; fileExtensions: string[]; tools: string[] };
};
export type CombinationSignals = {
  prompt: string;
  changedFiles: string[];
  activeTools: string[];
};

function piHome(): string {
  return process.env.PI_HOME || join(homedir(), ".pi");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function truncateLines(text: string, maxLines?: number): string {
  if (!maxLines) return text.trim();
  return text.trim().split(/\r?\n/).slice(0, maxLines).join("\n").trim();
}

export function parseCombinationYaml(text: string, sourcePath = "<inline>"): Combination {
  const parsed = combinationSchema.parse(parseYaml(text) ?? {});
  const when = parsed.when ?? {};
  return {
    ...parsed,
    sourcePath,
    when: {
      prompts: when.prompts ?? [],
      fileExtensions: when.fileExtensions ?? [],
      tools: when.tools ?? [],
    },
  };
}

function findYamlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && /\.(ya?ml)$/i.test(entry)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function combinationRoots(ctx: ExtensionContext): string[] {
  const override = process.env.PI_COMBINATIONS_DIRS;
  if (override)
    return override
      .split(delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => resolve(ctx.cwd, item));

  const roots = [join(piHome(), "agent", "combinations")];
  const projectRoot = join(ctx.cwd, CONFIG_DIR_NAME, "combinations");
  if (typeof ctx.isProjectTrusted === "function") {
    if (ctx.isProjectTrusted()) roots.push(projectRoot);
  } else {
    roots.push(projectRoot);
  }
  return roots;
}

function loadCombinations(ctx: ExtensionContext): { combinations: Combination[]; errors: string[] } {
  const byId = new Map<string, Combination>();
  const errors: string[] = [];

  for (const root of unique(combinationRoots(ctx))) {
    for (const file of findYamlFiles(root)) {
      try {
        const combination = parseCombinationYaml(readFileSync(file, "utf8"), file);
        if (combination.enabled) byId.set(combination.id, combination);
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { combinations: [...byId.values()], errors };
}

function promptMatches(needles: string[], prompt: string): boolean {
  if (!needles.length) return true;
  const haystack = normalize(prompt);
  return needles.some((needle) => {
    const normalized = normalize(needle);
    return normalized.length > 0 && haystack.includes(normalized);
  });
}

function filesMatch(extensions: string[], changedFiles: string[]): boolean {
  const normalizedExtensions = extensions.map(normalizeExtension).filter(Boolean);
  if (!normalizedExtensions.length) return true;
  return changedFiles.some((file) => normalizedExtensions.some((extension) => file.toLowerCase().endsWith(extension)));
}

function toolsMatch(requiredTools: string[], availableTools: string[]): boolean {
  if (!requiredTools.length) return true;
  const available = new Set(availableTools);
  return requiredTools.every((tool) => available.has(tool));
}

export function selectCombinationCards(combinations: Combination[], signals: CombinationSignals): Combination[] {
  return combinations
    .filter(
      (combination) =>
        promptMatches(combination.when.prompts, signals.prompt) &&
        filesMatch(combination.when.fileExtensions, signals.changedFiles) &&
        toolsMatch(combination.when.tools, signals.activeTools),
    )
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, DEFAULT_MAX_CARDS);
}

export function renderCombinationPrompt(cards: Combination[]): string {
  if (!cards.length) return "";

  const rendered = cards.map((card) => {
    const parts = [`- ${card.id}${card.description ? `: ${card.description}` : ""}`];
    parts.push(`  Guidance: ${truncateLines(card.guidance, card.maxPromptLines).replace(/\n/g, "\n    ")}`);
    if (card.preferredTools.length) parts.push(`  Prefer/capabilities: ${card.preferredTools.join(", ")}`);
    if (card.obligations.length) parts.push(`  Obligations: ${card.obligations.join("; ")}`);
    return parts.join("\n");
  });

  return [
    "COMBINATIONS:",
    "The combinations extension selected these compact semantic affordances from local YAML. Use them as workflow guidance; do not read or expose the YAML unless explicitly asked.",
    ...rendered,
  ].join("\n");
}

function parseGitStatusFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).trim();
      const renamed = raw.match(/^(.+) -> (.+)$/);
      return renamed?.[2] ?? raw;
    })
    .filter(Boolean);
}

async function changedFiles(ctx: ExtensionContext, pi: ExtensionAPI): Promise<string[]> {
  try {
    if (typeof (pi as any).exec === "function") {
      const result = await (pi as any).exec("git", ["status", "--short", "--untracked-files=all"], { timeout: 3_000 });
      return unique(parseGitStatusFiles(String(result.stdout ?? result.output ?? "")));
    }

    const result = await execFile("git", ["status", "--short", "--untracked-files=all"], { cwd: ctx.cwd, timeout: 3_000 });
    return unique(parseGitStatusFiles(String(result.stdout ?? "")));
  } catch {
    return [];
  }
}

function activeTools(pi: ExtensionAPI): string[] {
  return pi.getActiveTools?.() ?? (pi.getAllTools?.() ?? []).map((tool: { name: string }) => tool.name);
}

function summarizeLoaded(count: number, errors: string[]): string {
  return errors.length ? `combinations:${count} (${errors.length} invalid)` : `combinations:${count}`;
}

export default function combinationsExtension(pi: ExtensionAPI) {
  let combinations: Combination[] = [];
  let loadErrors: string[] = [];

  function reload(ctx: ExtensionContext) {
    const loaded = loadCombinations(ctx);
    combinations = loaded.combinations;
    loadErrors = loaded.errors;
    if (loadErrors.length) ctx.ui.notify(`Some combination YAML files were ignored:\n${loadErrors.slice(0, 3).join("\n")}`, "warning");
  }

  pi.registerCommand("combinations", {
    description: "Inspect or reload ambient semantic combinations loaded from YAML",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const items = ["status", "reload"].filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const command =
        String(args ?? "")
          .trim()
          .toLowerCase() || "status";
      if (command === "reload") reload(ctx);
      ctx.ui.notify(
        [
          summarizeLoaded(combinations.length, loadErrors),
          combinations.length ? `Loaded: ${combinations.map((item) => item.id).join(", ")}` : undefined,
          loadErrors.length ? `Invalid:\n${loadErrors.join("\n")}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        loadErrors.length ? "warning" : "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!combinations.length) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const cards = selectCombinationCards(combinations, {
      prompt: String(event.prompt ?? ""),
      changedFiles: await changedFiles(ctx, pi),
      activeTools: activeTools(pi),
    });

    if (!cards.length) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, `combos:${cards.map((card) => card.id).join(",")}`);
    return { systemPrompt: `${event.systemPrompt}\n\n${renderCombinationPrompt(cards)}` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
