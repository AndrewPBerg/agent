import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import extension from "./index";

function setup() {
  const pi = createMockPi();
  extension(pi as any);
  return pi;
}

describe("yosoi-workflows extension", () => {
  it("does not render or track runs before a YoSoi skill is loaded", async () => {
    const pi = setup();
    const ctx = createMockContext();

    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();

    const toolCall = pi.events.get("tool_call")?.[0];
    toolCall?.({ toolName: "bash", toolCallId: "run-1", input: { command: "uvx yosoi fetch https://example.com --json" } }, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("does not activate from before_agent_start loaded skill inventory", async () => {
    const pi = setup();
    const ctx = createMockContext();

    pi.events.get("before_agent_start")?.[0]?.({ systemPromptOptions: { skills: [{ name: "yosoi-fetch" }] } }, ctx);

    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("activates when a YoSoi skill file is read", async () => {
    const pi = setup();
    const ctx = createMockContext();

    pi.events.get("tool_call")?.[0]?.({ toolName: "read", toolCallId: "read-1", input: { path: "/x/yosoi-fetch/SKILL.md" } }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("yosoi", "yosoi 0");
  });

  it("tracks uvx yosoi commands after activation", async () => {
    const pi = setup();
    const ctx = createMockContext();
    pi.events.get("tool_call")?.[0]?.({ toolName: "read", toolCallId: "read-1", input: { path: "/x/yosoi-web-workflows/SKILL.md" } }, ctx);
    vi.clearAllMocks();

    pi.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "run-1", input: { command: "uvx yosoi fetch https://example.com --json" } },
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("yosoi", "yosoi 1/1 running");
  });

  it("explicit /skill:yosoi input activates dashboard helpers", async () => {
    const pi = setup();
    const ctx = createMockContext();

    pi.events.get("input")?.[0]?.({ text: "/skill:yosoi-fetch", images: [], source: "interactive" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("yosoi", "yosoi 0");
  });

  it("/yosoi command activates dashboard helpers explicitly", async () => {
    const pi = setup();
    const ctx = createMockContext();

    await pi.commands.get("yosoi").handler("dashboard", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("yosoi", "yosoi 0");
  });
});
