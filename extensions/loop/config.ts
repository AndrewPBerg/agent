import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type LoopConfig, loopConfigSchema, prModeSchema, type StressProfile, type Workflow } from "./schemas";

export type LoadedLoopConfig = LoopConfig & { errors: string[]; sourcePaths: string[] };

function piHome(): string {
  return process.env.PI_HOME || join(homedir(), ".pi");
}

function yamlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && /\.ya?ml$/i.test(entry)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

export function parseLoopConfig(text: string): LoopConfig {
  const value = (parseYaml(text) ?? {}) as {
    defaults?: { prMode?: unknown };
    workflows?: Record<string, { stages?: Array<Record<string, unknown>> }>;
  };
  const defaultPrMode = typeof value.defaults?.prMode === "string" ? value.defaults.prMode : "draft";
  for (const workflow of Object.values(value.workflows ?? {})) {
    for (const stage of workflow.stages ?? []) {
      if (stage.type === "pr" && stage.mode === undefined) stage.mode = defaultPrMode;
    }
  }
  return loopConfigSchema.parse(value);
}

export function loopConfigRoots(ctx: ExtensionContext): string[] {
  const roots = [join(piHome(), "agent", "loops")];
  const project = join(ctx.cwd, CONFIG_DIR_NAME, "loops");
  if (typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted()) roots.push(project);
  return roots;
}

export function loadLoopConfig(ctx: ExtensionContext): LoadedLoopConfig {
  const workflows: Record<string, Workflow> = {};
  const stressProfiles: Record<string, StressProfile> = {};
  const errors: string[] = [];
  const sourcePaths: string[] = [];
  let prMode: LoopConfig["defaults"]["prMode"] = "draft";

  for (const root of loopConfigRoots(ctx)) {
    for (const path of yamlFiles(root)) {
      try {
        const text = readFileSync(path, "utf8");
        const document = parseYaml(text) as { defaults?: { prMode?: unknown } } | undefined;
        const parsed = parseLoopConfig(text);
        Object.assign(workflows, parsed.workflows);
        Object.assign(stressProfiles, parsed.stressProfiles);
        const explicitPrMode = prModeSchema.safeParse(document?.defaults?.prMode);
        if (explicitPrMode.success) prMode = explicitPrMode.data;
        sourcePaths.push(path);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { version: 1, defaults: { prMode }, workflows, stressProfiles, errors, sourcePaths };
}

export function renderScalarTemplate(value: string, variables: Record<string, string | undefined>): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, name: string) => variables[name] ?? "");
}

function extensionMatches(extension: string, files: string[]): boolean {
  const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return files.some((file) => file.toLowerCase().endsWith(normalized));
}

export function selectStressProfiles(
  profiles: Record<string, StressProfile>,
  requested: string,
  cwdBasename: string,
  changedFiles: string[],
): Array<{ id: string; profile: StressProfile }> {
  if (requested !== "auto") return profiles[requested] ? [{ id: requested, profile: profiles[requested] }] : [];

  return Object.entries(profiles)
    .filter(([, profile]) => {
      const cwdMatches = !profile.match.cwdBasename || profile.match.cwdBasename === cwdBasename;
      const extensions = profile.match.fileExtensions;
      const filesMatch = !extensions.length || extensions.some((extension) => extensionMatches(extension, changedFiles));
      return cwdMatches && filesMatch;
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, profile]) => ({ id, profile }));
}

export function loopConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(loopConfigSchema) as Record<string, unknown>;
}
