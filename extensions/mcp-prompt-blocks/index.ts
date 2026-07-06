import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMcpAccessDecision } from "../mcp-access-guard/rules";

type JsonObject = Record<string, unknown>;

const BLOCKS: Record<string, string> = {
  linear: "linear.md",
};

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
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

function configuredServerNames(path: string): string[] {
  const json = readJson(path);
  const servers = json?.mcpServers ?? json?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers as JsonObject);
}

function mcpConfigPaths(cwd: string): string[] {
  const override = process.env.PI_MCP_PROMPT_BLOCK_CONFIGS?.trim();
  if (override)
    return override
      .split(delimiter)
      .filter(Boolean)
      .map((path) => resolve(path));

  return [
    join(agentDir(), "mcp.json"),
    join(homedir(), ".config", "mcp", "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ];
}

function hasConfiguredServer(server: string, cwd: string): boolean {
  const configured = new Set(mcpConfigPaths(cwd).flatMap(configuredServerNames));
  if (!configured.has(server)) return false;
  return !getMcpAccessDecision(cwd, configured).blockedServers.has(server);
}

function hasMcpTool(event: Parameters<Parameters<ExtensionAPI["on"]>[1]>[0]): boolean {
  const tools = event.systemPromptOptions?.selectedTools ?? [];
  return Array.isArray(tools) && tools.includes("mcp");
}

function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);

  for (let i = 0; i < 12; i += 1) {
    dirs.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.reverse();
}

function readIfPresent(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  return text ? text : undefined;
}

function promptBlocksFor(server: string, cwd: string): string[] {
  const extensionDir = dirname(fileURLToPath(import.meta.url));
  const blockFile = BLOCKS[server];
  if (!blockFile) return [];

  const blocks: string[] = [];
  const bundled = readIfPresent(join(extensionDir, "blocks", blockFile));
  if (bundled) blocks.push(bundled);

  for (const dir of ancestorDirs(cwd)) {
    for (const candidate of [join(dir, ".pi", "mcp-prompts", blockFile), join(dir, ".mcp-prompts", blockFile)]) {
      const projectBlock = readIfPresent(candidate);
      if (projectBlock) blocks.push(projectBlock);
    }
  }

  return blocks;
}

export default function mcpPromptBlocks(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (!hasMcpTool(event)) return undefined;

    const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
    const blocks = Object.keys(BLOCKS).flatMap((server) => {
      if (!hasConfiguredServer(server, cwd)) return [];
      return promptBlocksFor(server, cwd);
    });

    if (blocks.length === 0) return undefined;

    const addition = `\n\n# MCP-active prompt blocks\n\n${blocks.join("\n\n")}`;
    if (event.systemPrompt.includes(addition.trim())) return undefined;

    return { systemPrompt: event.systemPrompt + addition };
  });
}
