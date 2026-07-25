import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface PiConfig {
  session: SessionConfig;
}

export type SessionTitleTagConfig = string | readonly [string, string?] | { name: string; description?: string };

export interface SessionTitleGenerationConfig {
  enabled: boolean;
  language: string;
  model: string;
  retries: number;
  emojis: boolean;
  maxLength: number;
  scopeMaxLength: number;
  maxMessageCount: number;
  includeTools: boolean;
  useTags: boolean;
  builtinTags: boolean;
  tags: SessionTitleTagConfig[];
}

export interface SessionRenameConfig {
  enabled: boolean;
  command: string;
  interactiveWhenEmpty: boolean;
}

export interface SessionBrowserConfig {
  enabled: boolean;
  command: string;
  pageSize: number;
  delete: {
    enabled: boolean;
    useTrash: boolean;
    confirmPresses: number;
  };
}

export interface SessionConfig {
  titleGeneration: SessionTitleGenerationConfig;
  rename: SessionRenameConfig;
  browser: SessionBrowserConfig;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U> ? U[] : T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface LoadedPiConfig {
  config: PiConfig;
  sources: string[];
}

export const DEFAULT_SESSION_NAMING_CONFIG: PiConfig = {
  session: {
    titleGeneration: {
      enabled: true,
      language: "auto",
      model: "openai-codex/gpt-5.3-codex-spark",
      retries: 3,
      emojis: false,
      maxLength: 52,
      scopeMaxLength: 12,
      maxMessageCount: -1,
      includeTools: true,
      useTags: true,
      builtinTags: true,
      tags: [],
    },
    rename: {
      enabled: true,
      command: "rename",
      interactiveWhenEmpty: true,
    },
    browser: {
      enabled: true,
      command: "sessions",
      pageSize: 12,
      delete: {
        enabled: true,
        useTrash: true,
        confirmPresses: 2,
      },
    },
  },
};

export const DEFAULT_PI_CONFIG = DEFAULT_SESSION_NAMING_CONFIG;

type SettingsWithSessionNaming = {
  session?: Record<string, unknown>;
};

const SESSION_KEYS = ["titleGeneration", "rename", "browser"] as const;
const TITLE_GENERATION_KEYS = [
  "enabled",
  "language",
  "model",
  "retries",
  "emojis",
  "maxLength",
  "scopeMaxLength",
  "maxMessageCount",
  "includeTools",
  "useTags",
  "builtinTags",
  "tags",
] as const;
const RENAME_KEYS = ["enabled", "command", "interactiveWhenEmpty"] as const;
const BROWSER_KEYS = ["enabled", "command", "pageSize", "delete"] as const;
const DELETE_KEYS = ["enabled", "useTrash", "confirmPresses"] as const;

export function loadSessionNamingConfig(cwd: string, agentDir = getAgentDir()): LoadedPiConfig {
  const manager = SettingsManager.create(cwd, agentDir);
  let config = clone(DEFAULT_SESSION_NAMING_CONFIG);

  const globalSettings = normalizeConfigAliases(manager.getGlobalSettings()) as SettingsWithSessionNaming;
  const projectSettings = normalizeConfigAliases(manager.getProjectSettings()) as SettingsWithSessionNaming;

  config = mergeSettingsConfig(config, globalSettings);
  config = mergeSettingsConfig(config, projectSettings);

  return {
    config,
    sources: settingsSources(cwd, agentDir),
  };
}

export async function loadPiConfig(cwd: string): Promise<LoadedPiConfig> {
  return loadSessionNamingConfig(cwd, getAgentDir());
}

function mergeSettingsConfig(base: PiConfig, settings: SettingsWithSessionNaming): PiConfig {
  const session = pickKnown(settings.session, SESSION_KEYS);
  return {
    session: {
      titleGeneration: mergeKnown(base.session.titleGeneration, pickKnown(session.titleGeneration, TITLE_GENERATION_KEYS)),
      rename: mergeKnown(base.session.rename, pickKnown(session.rename, RENAME_KEYS)),
      browser: mergeBrowserConfig(base.session.browser, pickKnown(session.browser, BROWSER_KEYS)),
    },
  };
}

function mergeBrowserConfig(base: SessionBrowserConfig, override: Record<string, unknown>): SessionBrowserConfig {
  return {
    ...mergeKnown(base, override),
    delete: mergeKnown(base.delete, pickKnown(override.delete, DELETE_KEYS)),
  };
}

function mergeKnown<T>(base: T, override: unknown): T {
  return deepMerge(base, override as DeepPartial<T> | undefined);
}

function pickKnown(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) out[key] = value[key];
  }
  return out;
}

function settingsSources(cwd: string, agentDir: string): string[] {
  return [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")].filter((path) => existsSync(path));
}

export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return clone(override as T);
  }

  const merged: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = deepMerge(current, value as Record<string, unknown>);
    } else {
      merged[key] = clone(value);
    }
  }
  return merged as T;
}

function normalizeConfigAliases(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeConfigAliases(item));
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeToCamel(key), normalizeConfigAliases(item)]));
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
