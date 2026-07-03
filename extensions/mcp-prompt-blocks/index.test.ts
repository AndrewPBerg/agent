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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-prompt-blocks-"));
    oldConfigOverride = process.env.PI_MCP_PROMPT_BLOCK_CONFIGS;
  });

  afterEach(() => {
    if (oldConfigOverride === undefined) delete process.env.PI_MCP_PROMPT_BLOCK_CONFIGS;
    else process.env.PI_MCP_PROMPT_BLOCK_CONFIGS = oldConfigOverride;
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
