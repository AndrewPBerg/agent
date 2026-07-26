import { describe, expect, it, vi } from "vitest";
import { INLINE_MODE_EVENT, type InlineModeState, type InlineModeUpdate } from "../lib/inline-modes";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { VIM_LEADER_EVENT } from "../vim-leader/protocol";
import extension from "./index";

const inlineModes = new WeakMap<object, Map<string, InlineModeState>>();

function setup() {
  const pi = createMockPi();
  const modes = new Map<string, InlineModeState>();
  inlineModes.set(pi, modes);
  pi.events.on(INLINE_MODE_EVENT, (data) => {
    const update = data as InlineModeUpdate;
    if (update.state) modes.set(update.id, update.state);
    else modes.delete(update.id);
  });
  extension(pi as any);
  return pi;
}

function yosoiMode(pi: object): InlineModeState | undefined {
  return inlineModes.get(pi)?.get("yosoi");
}

describe("yosoi-workflows extension", () => {
  it("starts with the dashboard and inline pill off", () => {
    const pi = setup();
    const ctx = createMockContext();

    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("yosoi-dashboard", undefined);
    expect(yosoiMode(pi)).toBeUndefined();
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

  it("toggles the detailed dashboard with leader-y", () => {
    const pi = setup();
    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    vi.clearAllMocks();

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "y", action: "yosoi" });

    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("yosoi-dashboard", expect.any(Function));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Yosoi dashboard shown", "info");
    expect(yosoiMode(pi)).toMatchObject({ label: "YS", detail: "0", icon: "" });
  });

  it("animates a globe pill while Yosoi runs and settles to a count", async () => {
    const pi = setup();
    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    pi.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "run-1", input: { command: "uvx yosoi fetch https://example.com --json" } },
      ctx,
    );

    const running = yosoiMode(pi);
    expect(running).toMatchObject({ label: "YS", detail: undefined, intervalMs: 16, tone: "accent" });
    expect(running?.frames).toHaveLength(60);
    expect(running?.frames?.every((frame) => frame.icon === "")).toBe(true);
    expect(running?.frames?.[0]?.color).toEqual([70, 78, 92]);
    expect(running?.frames?.[30]?.color).toEqual([74, 210, 255]);

    pi.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "run-2", input: { command: "uvx yosoi search cats --json" } }, ctx);
    expect(yosoiMode(pi)).toMatchObject({ label: "YS", detail: "2", intervalMs: 16 });

    for (const toolCallId of ["run-1", "run-2"]) {
      await pi.events.get("tool_result")?.[0]?.(
        { toolName: "bash", toolCallId, content: [{ type: "text", text: '{"status":"ok"}' }], isError: false },
        ctx,
      );
    }

    expect(yosoiMode(pi)).toMatchObject({ label: "YS", detail: "2", icon: "", tone: "success" });
    expect(yosoiMode(pi)?.frames).toBeUndefined();
  });
});
