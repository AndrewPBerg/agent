import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import mcpPromptBlocks from "./index";

function beforeAgentStart(pi: ReturnType<typeof createMockPi>) {
  const handler = pi.events.get("before_agent_start")?.[0];
  expect(handler).toBeDefined();
  return handler!;
}

function event(cwd: string, tools = ["mcp"]) {
  return {
    systemPrompt: "base prompt",
    systemPromptOptions: {
      cwd,
      selectedTools: tools,
    },
  };
}

describe("mcp-prompt-blocks", () => {
  let dir: string;
  let oldConfigOverride: string | undefined;
  let oldAccessConfigOverride: string | undefined;
  let oldAccessRulesOverride: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-prompt-blocks-"));
    oldConfigOverride = process.env.PI_MCP_PROMPT_BLOCK_CONFIGS;
    oldAccessConfigOverride = process.env.PI_MCP_ACCESS_GUARD_CONFIGS;
    oldAccessRulesOverride = process.env.PI_MCP_ACCESS_RULES;
  });

  afterEach(() => {
    if (oldConfigOverride === undefined) delete process.env.PI_MCP_PROMPT_BLOCK_CONFIGS;
    else process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = oldConfigOverride;
    if (oldAccessConfigOverride === undefined) delete process.env.PI_MCP_ACCESS_GUARD_CONFIGS;
    else process.env.PI_MCP_ACCESS_GUARD_CONFIGS = oldAccessConfigOverride;
    if (oldAccessRulesOverride === undefined) delete process.env.PI_MCP_ACCESS_RULES;
    else process.env.PI_MCP_ACCESS_RULES = oldAccessRulesOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not inject when the mcp tool is inactive", async () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { linear: {} } }));
    process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = config;

    const pi = createMockPi();
    mcpPromptBlocks(pi);

    const result = await beforeAgentStart(pi)(event(dir, ["read", "bash"]));

    expect(result).toBeUndefined();
  });

  it("does not inject when linear is not configured", async () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { jira: {} } }));
    process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = config;

    const pi = createMockPi();
    mcpPromptBlocks(pi);

    const result = await beforeAgentStart(pi)(event(dir));

    expect(result).toBeUndefined();
  });

  it("injects the Linear block when mcp is active and linear is configured", async () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { linear: {} } }));
    process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = config;

    const pi = createMockPi();
    mcpPromptBlocks(pi);

    const result = await beforeAgentStart(pi)(event(dir));

    expect(result?.systemPrompt).toContain("base prompt");
    expect(result?.systemPrompt).toContain("MCP-active prompt blocks");
    expect(result?.systemPrompt).toContain("Linear MCP and CAS/PRS");
    expect(result?.systemPrompt).toContain("PRS is for personal boards");
  });

  it("does not inject a block when the server is blocked by local access rules for the cwd", async () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { linear: {} } }));
    process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = config;
    process.env.PI_MCP_ACCESS_GUARD_CONFIGS = config;

    const rules = join(dir, "mcp-access.local.json");
    writeFileSync(rules, JSON.stringify({ version: 1, directories: { [dir]: { block: ["linear"] } } }));
    process.env.PI_MCP_ACCESS_RULES = rules;

    const pi = createMockPi();
    mcpPromptBlocks(pi);

    const result = await beforeAgentStart(pi)(event(join(dir, "repo")));

    expect(result).toBeUndefined();
  });

  it("adds project prompt blocks from the current directory", async () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { linear: {} } }));
    process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = config;

    const promptDir = join(dir, ".pi", "mcp-prompts");
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "linear.md"), "## Project Linear rules\n\nUse the project triage label.");

    const pi = createMockPi();
    mcpPromptBlocks(pi);

    const result = await beforeAgentStart(pi)(event(dir));

    expect(result?.systemPrompt).toContain("Linear MCP and CAS/PRS");
    expect(result?.systemPrompt).toContain("Project Linear rules");
    expect(result?.systemPrompt).toContain("Use the project triage label.");
  });
});
