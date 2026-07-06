import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export type DirectoryRule = {
  path: string;
  allow?: string[];
  block?: string[];
  source: string;
};

export type McpAccessDecision = {
  allowedServers?: Set<string>;
  blockedServers: Set<string>;
  matchedRules: DirectoryRule[];
  configuredServers: Set<string>;
};

const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");
const LOCAL_ACCESS_FILE = "mcp-access.local.json";

export function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  return expandPath(configured);
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function normalizedPath(path: string): string {
  return resolve(expandPath(path));
}

export function isSameOrDescendant(cwd: string, parent: string): boolean {
  const resolvedCwd = normalizedPath(cwd);
  const resolvedParent = normalizedPath(parent);
  return resolvedCwd === resolvedParent || resolvedCwd.startsWith(`${resolvedParent}/`);
}

function readJson(path: string): JsonObject | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function argvConfigPath(): string | undefined {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

export function mcpConfigPaths(cwd: string): string[] {
  const override = process.env.PI_MCP_ACCESS_GUARD_CONFIGS?.trim();
  if (override)
    return override
      .split(delimiter)
      .filter(Boolean)
      .map((path) => normalizedPath(path));

  const userPath = normalizedPath(argvConfigPath() ?? join(agentDir(), "mcp.json"));
  const paths: string[] = [];
  if (normalizedPath(GENERIC_GLOBAL_CONFIG_PATH) !== userPath) paths.push(GENERIC_GLOBAL_CONFIG_PATH);
  paths.push(userPath, resolve(cwd, ".mcp.json"), resolve(cwd, ".pi", "mcp.json"));
  return paths;
}

export function mcpAccessRulePaths(): string[] {
  const override = process.env.PI_MCP_ACCESS_RULES?.trim();
  if (override)
    return override
      .split(delimiter)
      .filter(Boolean)
      .map((path) => normalizedPath(path));

  return [join(agentDir(), LOCAL_ACCESS_FILE)];
}

function settingsFrom(path: string): JsonObject | undefined {
  const json = readJson(path);
  const settings = json?.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as JsonObject) : undefined;
}

function configuredServerNames(path: string): string[] {
  const json = readJson(path);
  const servers = json?.mcpServers ?? json?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers as JsonObject);
}

export function allConfiguredServers(cwd: string): Set<string> {
  const servers = new Set<string>();
  for (const path of mcpConfigPaths(cwd)) {
    for (const server of configuredServerNames(path)) servers.add(server);
  }
  return servers;
}

export function effectiveToolPrefix(cwd: string): "server" | "none" | "short" {
  let prefix: "server" | "none" | "short" = "server";
  for (const path of mcpConfigPaths(cwd)) {
    const value = settingsFrom(path)?.toolPrefix;
    if (value === "server" || value === "none" || value === "short") prefix = value;
  }
  return prefix;
}

function serverList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((server): server is string => typeof server === "string" && server.trim().length > 0)
    .map((server) => server.trim());
  return names.length > 0 ? [...new Set(names)] : [];
}

function firstServerList(rule: JsonObject, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const list = serverList(rule[key]);
    if (list) return list;
  }
  return undefined;
}

function directoryRuleFrom(path: string, value: unknown, source: string): DirectoryRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rule = value as JsonObject;
  return {
    path,
    allow: firstServerList(rule, ["allow", "allowed", "allowServers", "allowedServers"]),
    block: firstServerList(rule, ["block", "blocked", "blockServers", "blockedServers"]),
    source,
  };
}

function localRulesFrom(path: string): DirectoryRule[] {
  const json = readJson(path);
  if (!json) return [];

  const rules: DirectoryRule[] = [];
  const directories = json.directories;
  if (directories && typeof directories === "object" && !Array.isArray(directories)) {
    for (const [dir, value] of Object.entries(directories as JsonObject)) {
      const rule = directoryRuleFrom(dir, value, path);
      if (rule) rules.push(rule);
    }
  }

  if (Array.isArray(json.rules)) {
    for (const item of json.rules) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rule = item as JsonObject;
      const dir =
        typeof rule.path === "string"
          ? rule.path
          : typeof rule.cwd === "string"
            ? rule.cwd
            : typeof rule.dir === "string"
              ? rule.dir
              : undefined;
      if (!dir) continue;
      rules.push({
        path: dir,
        allow: firstServerList(rule, ["allow", "allowed", "allowServers", "allowedServers"]),
        block: firstServerList(rule, ["block", "blocked", "blockServers", "blockedServers"]),
        source: path,
      });
    }
  }

  return rules;
}

function legacyRulesFromMcpConfig(cwd: string): DirectoryRule[] {
  const rules: DirectoryRule[] = [];
  for (const path of mcpConfigPaths(cwd)) {
    const blockedByCwd = settingsFrom(path)?.blockedServersByCwd;
    if (!blockedByCwd || typeof blockedByCwd !== "object" || Array.isArray(blockedByCwd)) continue;

    for (const [dir, servers] of Object.entries(blockedByCwd as JsonObject)) {
      const block = serverList(servers);
      if (block) rules.push({ path: dir, block, source: `${path}#settings.blockedServersByCwd` });
    }
  }
  return rules;
}

function matchingRules(cwd: string): DirectoryRule[] {
  return [...mcpAccessRulePaths().flatMap(localRulesFrom), ...legacyRulesFromMcpConfig(cwd)]
    .filter((rule) => isSameOrDescendant(cwd, rule.path))
    .sort((a, b) => normalizedPath(a.path).length - normalizedPath(b.path).length);
}

export function getMcpAccessDecision(cwd: string, configuredServers = allConfiguredServers(cwd)): McpAccessDecision {
  const matchedRules = matchingRules(cwd);
  let allowedServers: Set<string> | undefined;
  const explicitlyBlocked = new Set<string>();

  for (const rule of matchedRules) {
    if (rule.allow) allowedServers = new Set(rule.allow);
    for (const server of rule.block ?? []) explicitlyBlocked.add(server);
  }

  const blockedServers = new Set(explicitlyBlocked);
  if (allowedServers) {
    for (const server of configuredServers) {
      if (!allowedServers.has(server)) blockedServers.add(server);
    }
  }

  return { allowedServers, blockedServers, matchedRules, configuredServers };
}

export function namesList(names: Iterable<string>): string {
  return [...names].sort().join(", ");
}
