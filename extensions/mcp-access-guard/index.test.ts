import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import mcpAccessGuard from "./index";

function toolCall(pi: ReturnType<typeof createMockPi>) {
  const handler = pi.events.get("tool_call")?.[0];
  expect(handler).toBeDefined();
  return handler!;
}

describe("mcp-access-guard", () => {
  let dir: string;
  let oldConfigs: string | undefined;
  let oldCache: string | undefined;
  let oldRules: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-access-guard-"));
    oldConfigs = process.env.PI_MCP_ACCESS_GUARD_CONFIGS;
    oldCache = process.env.PI_MCP_ACCESS_GUARD_CACHE;
    oldRules = process.env.PI_MCP_ACCESS_RULES;
  });

  afterEach(() => {
    if (oldConfigs === undefined) delete process.env.PI_MCP_ACCESS_GUARD_CONFIGS;
    else process.env.PI_MCP_ACCESS_GUARD_CONFIGS = oldConfigs;
    if (oldCache === undefined) delete process.env.PI_MCP_ACCESS_GUARD_CACHE;
    else process.env.PI_MCP_ACCESS_GUARD_CACHE = oldCache;
    if (oldRules === undefined) delete process.env.PI_MCP_ACCESS_RULES;
    else process.env.PI_MCP_ACCESS_RULES = oldRules;
    rmSync(dir, { recursive: true, force: true });
  });

  function configure() {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { linear: {}, jira: {} } }));
    process.env.PI_MCP_ACCESS_GUARD_CONFIGS = config;

    const rules = join(dir, "mcp-access.local.json");
    writeFileSync(
      rules,
      JSON.stringify({
        version: 1,
        directories: {
          [join(dir, "Work")]: { block: ["linear"] },
        },
      }),
    );
    process.env.PI_MCP_ACCESS_RULES = rules;
  }

  it("blocks proxy calls to a blocked server under the configured cwd", () => {
    configure();
    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "mcp", input: { server: "linear" } }, createMockContext({ cwd: join(dir, "Work", "repo") }));

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain('"linear" is blocked');
  });

  it("allows proxy calls to non-blocked servers under the configured cwd", () => {
    configure();
    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "mcp", input: { server: "jira" } }, createMockContext({ cwd: join(dir, "Work", "repo") }));

    expect(result).toBeUndefined();
  });

  it("treats allow rules as a directory server allowlist even for unknown explicit targets", () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { jira: {} } }));
    process.env.PI_MCP_ACCESS_GUARD_CONFIGS = config;

    const rules = join(dir, "mcp-access.local.json");
    writeFileSync(rules, JSON.stringify({ version: 1, directories: { [join(dir, "Work")]: { allow: ["jira"] } } }));
    process.env.PI_MCP_ACCESS_RULES = rules;

    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "mcp", input: { server: "linear" } }, createMockContext({ cwd: join(dir, "Work") }));

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain('"linear" is not allowed');
  });

  it("blocks ambiguous proxy tool calls where a blocked server is configured", () => {
    configure();
    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "mcp", input: { tool: "list_issues" } }, createMockContext({ cwd: join(dir, "Work") }));

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("specify an allowed server explicitly");
  });

  it("does not block outside the configured cwd", () => {
    configure();
    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "mcp", input: { server: "linear" } }, createMockContext({ cwd: join(dir, "Other") }));

    expect(result).toBeUndefined();
  });

  it("blocks direct MCP tools excluded by allowlist-only rules", () => {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { jira: {} } }));
    process.env.PI_MCP_ACCESS_GUARD_CONFIGS = config;

    const rules = join(dir, "mcp-access.local.json");
    writeFileSync(rules, JSON.stringify({ version: 1, directories: { [join(dir, "Work")]: { allow: ["jira"] } } }));
    process.env.PI_MCP_ACCESS_RULES = rules;

    const cache = join(dir, "mcp-cache.json");
    writeFileSync(
      cache,
      JSON.stringify({
        version: 1,
        servers: {
          linear: { tools: [{ name: "list_issues" }], resources: [] },
        },
      }),
    );
    process.env.PI_MCP_ACCESS_GUARD_CACHE = cache;

    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "linear_list_issues", input: {} }, createMockContext({ cwd: join(dir, "Work") }));

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain('blocked direct MCP tool "linear_list_issues"');
  });

  it("blocks direct MCP tools from blocked servers", () => {
    configure();
    const cache = join(dir, "mcp-cache.json");
    writeFileSync(
      cache,
      JSON.stringify({
        version: 1,
        servers: {
          linear: { tools: [{ name: "list_issues" }], resources: [{ name: "Docs" }] },
        },
      }),
    );
    process.env.PI_MCP_ACCESS_GUARD_CACHE = cache;

    const pi = createMockPi();
    mcpAccessGuard(pi);

    const result = toolCall(pi)({ toolName: "linear_list_issues", input: {} }, createMockContext({ cwd: join(dir, "Work") }));

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain('blocked direct MCP tool "linear_list_issues"');
  });
});
