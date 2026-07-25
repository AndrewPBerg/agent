import { afterEach, describe, expect, it, vi } from "vitest";
import { getInlineModes, setInlineMode } from "../lib/inline-modes";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { VIM_LEADER_EVENT } from "../vim-leader/protocol";
import extension from "./index";

function setup() {
  const pi = createMockPi();
  extension(pi as any);
  return pi;
}

afterEach(() => setInlineMode("yosoi", undefined));

describe("yosoi-workflows extension", () => {
  it("starts with the dashboard and inline pill off", () => {
    const pi = setup();
    const ctx = createMockContext();

    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("yosoi-dashboard", undefined);
    expect(getInlineModes()).toEqual([]);
  });

  it("registers /yosoi and the short /ys alias", () => {
    const pi = setup();

    expect(pi.commands.has("yosoi")).toBe(true);
    expect(pi.commands.has("ys")).toBe(true);
  });

  it("prefills workflows with global Pi skill paths", async () => {
    const pi = setup();
    const ctx = createMockContext();

    await pi.commands.get("ys").handler("fetch https://example.com", ctx);

    expect(ctx.ui.setEditorText).toHaveBeenCalledWith(expect.stringContaining("~/.pi/agent/skills/yosoi-web-workflows/SKILL.md"));
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith(expect.not.stringContaining(".agents/skills"));
  });

  it("toggles the detailed dashboard with /ys show", async () => {
    const pi = setup();
    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    vi.clearAllMocks();

    await pi.commands.get("ys").handler("show", ctx);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("yosoi-dashboard", expect.any(Function));

    await pi.commands.get("ys").handler("show", ctx);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("yosoi-dashboard", undefined);
  });

  it("toggles the detailed dashboard and zero-run pill with leader-y", () => {
    const pi = setup();
    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    vi.clearAllMocks();

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "y" });

    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("yosoi-dashboard", expect.any(Function));
    expect(getInlineModes()[0]?.state).toMatchObject({ label: "YS", detail: "0", icon: "" });
  });

  it("animates a globe pill while Yosoi runs and settles to a count", async () => {
    const pi = setup();
    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    pi.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "run-1", input: { command: "uvx yosoi fetch https://example.com --json" } },
      ctx,
    );

    const running = getInlineModes()[0]?.state;
    expect(running).toMatchObject({ label: "YS", detail: "FETCH", intervalMs: 140 });
    expect(running?.frames?.map((frame) => frame.icon)).toEqual(["", "", "", ""]);

    await pi.events.get("tool_result")?.[0]?.(
      { toolName: "bash", toolCallId: "run-1", content: [{ type: "text", text: '{"status":"ok"}' }], isError: false },
      ctx,
    );

    expect(getInlineModes()[0]?.state).toMatchObject({ label: "YS", detail: "1", icon: "", tone: "success" });
    expect(getInlineModes()[0]?.state.frames).toBeUndefined();
  });
});
