import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, allConfiguredServers, effectiveToolPrefix, getMcpAccessDecision, namesList } from "./rules";

type JsonObject = Record<string, unknown>;
type McpInput = {
  tool?: unknown;
  args?: unknown;
  server?: unknown;
  connect?: unknown;
  describe?: unknown;
  search?: unknown;
  action?: unknown;
};

function readJson(path: string): JsonObject | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function getServerPrefix(serverName: string, mode: "server" | "none" | "short"): string {
  if (mode === "none") return "";
  if (mode === "short") {
    const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return short || "mcp";
  }
  return serverName.replace(/-/g, "_");
}

function formatToolName(toolName: string, serverName: string, prefix: "server" | "none" | "short"): string {
  const p = getServerPrefix(serverName, prefix);
  return p ? `${p}_${toolName}` : toolName;
}

function resourceNameToToolName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "resource"
  );
}

function blockedDirectToolNames(cwd: string, blockedServers: Set<string>, allowedServers?: Set<string>): Set<string> {
  const blocked = new Set<string>();
  const cachePath = process.env.PI_MCP_ACCESS_GUARD_CACHE?.trim() || join(agentDir(), "mcp-cache.json");
  const cache = readJson(cachePath);
  const servers = cache?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return blocked;

  const blockedFromCache = new Set(blockedServers);
  if (allowedServers) {
    for (const serverName of Object.keys(servers as JsonObject)) {
      if (!allowedServers.has(serverName)) blockedFromCache.add(serverName);
    }
  }

  const prefix = effectiveToolPrefix(cwd);
  for (const serverName of blockedFromCache) {
    const entry = (servers as JsonObject)[serverName];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const tools = (entry as JsonObject).tools;
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        const name = tool && typeof tool === "object" && !Array.isArray(tool) ? (tool as JsonObject).name : undefined;
        if (typeof name === "string") blocked.add(formatToolName(name, serverName, prefix));
      }
    }

    const resources = (entry as JsonObject).resources;
    if (Array.isArray(resources)) {
      for (const resource of resources) {
        const name = resource && typeof resource === "object" && !Array.isArray(resource) ? (resource as JsonObject).name : undefined;
        if (typeof name === "string") blocked.add(formatToolName(`get_${resourceNameToToolName(name)}`, serverName, prefix));
      }
    }
  }

  return blocked;
}

function asMcpInput(value: unknown): McpInput {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as McpInput) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function blockReason(blockedServers: Set<string>, allowedServers?: Set<string>): string {
  if (blockedServers.size > 0) return `MCP server access blocked for this cwd: ${namesList(blockedServers)}`;
  return `MCP server access allowlisted for this cwd: ${namesList(allowedServers ?? [])}`;
}

function targetBlockReason(target: string | undefined, blockedServers: Set<string>, allowedServers?: Set<string>): string | undefined {
  if (!target) return undefined;
  if (blockedServers.has(target)) return `MCP server "${target}" is blocked for this cwd`;
  if (allowedServers && !allowedServers.has(target)) return `MCP server "${target}" is not allowed for this cwd`;
  return undefined;
}

function blockedProxyReason(
  input: McpInput,
  blockedServers: Set<string>,
  configuredServers: Set<string>,
  allowedServers?: Set<string>,
): string | undefined {
  const server = stringValue(input.server);
  const connect = stringValue(input.connect);
  const targetReason =
    targetBlockReason(server, blockedServers, allowedServers) ?? targetBlockReason(connect, blockedServers, allowedServers);
  if (targetReason) return targetReason;

  const action = stringValue(input.action);
  if (action === "ui-messages") return `${blockReason(blockedServers, allowedServers)}; ui-messages can include blocked server sessions`;

  if (server) return undefined;

  if (stringValue(input.tool)) {
    return `${blockReason(blockedServers, allowedServers)}; specify an allowed server explicitly for MCP tool calls`;
  }

  if (stringValue(input.search) || stringValue(input.describe)) {
    return `${blockReason(blockedServers, allowedServers)}; cross-server search/describe is disabled here`;
  }

  if (!server && !connect && !action && !stringValue(input.tool) && !stringValue(input.search) && !stringValue(input.describe)) {
    return `${blockReason(blockedServers, allowedServers)}; cross-server MCP status is disabled here`;
  }

  if (action?.startsWith("auth-") && !server && configuredServers.size > 0) {
    return `${blockReason(blockedServers, allowedServers)}; auth actions must target an allowed server explicitly`;
  }

  return undefined;
}

export default function mcpAccessGuard(pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const decision = getMcpAccessDecision(cwd);
    if (decision.blockedServers.size === 0 && !decision.allowedServers) return undefined;

    if (event.toolName === "mcp") {
      const reason = blockedProxyReason(
        asMcpInput(event.input),
        decision.blockedServers,
        allConfiguredServers(cwd),
        decision.allowedServers,
      );
      if (reason) return { block: true, reason };
      return undefined;
    }

    const directTools = blockedDirectToolNames(cwd, decision.blockedServers, decision.allowedServers);
    if (directTools.has(event.toolName)) {
      return {
        block: true,
        reason: `${blockReason(decision.blockedServers, decision.allowedServers)}; blocked direct MCP tool "${event.toolName}"`,
      };
    }

    return undefined;
  });
}
