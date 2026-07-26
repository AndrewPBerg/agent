import { describe, expect, it, vi } from "vitest";
import flameframeUi from "../flameframe";
import { INLINE_MODE_EVENT, type InlineModeUpdate } from "../lib/inline-modes";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { VIM_LEADER_EVENT } from "../vim-leader/protocol";

describe("FlameFrame leader mapping", () => {
  it("opens the session browser for leader-f", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    flameframeUi(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "f", action: "flameframe" });

    await vi.waitFor(() =>
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No FlameFrame packs are registered"), "info"),
    );
  });

  it("does not render a persistent session shelf", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    flameframeUi(pi);

    await pi.events.get("session_start")?.[0]({}, ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("restores one persistent FF count from processed session videos", async () => {
    const pi = createMockPi();
    const updates: InlineModeUpdate[] = [];
    pi.events.on(INLINE_MODE_EVENT, (update) => updates.push(update as InlineModeUpdate));
    const ctx = createMockContext();
    ctx.sessionManager.getBranch.mockReturnValue([
      {
        type: "custom",
        customType: "flameframe-pack",
        data: { version: 1, pack: { packPath: "/tmp/video.frameflame" } },
      },
    ]);
    flameframeUi(pi);

    await pi.events.get("session_start")?.[0]({}, ctx);

    expect(updates.at(-1)?.state).toMatchObject({ label: "FF", detail: "1", priority: 110 });
  });

  it("keeps FF processing visible until all parallel FlameFrame tools finish", async () => {
    const pi = createMockPi();
    const updates: InlineModeUpdate[] = [];
    pi.events.on(INLINE_MODE_EVENT, (update) => updates.push(update as InlineModeUpdate));
    const ctx = createMockContext();
    flameframeUi(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    const start = pi.events.get("tool_execution_start")?.[0];
    const end = pi.events.get("tool_execution_end")?.[0];
    await start?.({ toolCallId: "ff-1", toolName: "flameframe_inspect", args: {} }, ctx);
    await start?.({ toolCallId: "ff-2", toolName: "flameframe_process", args: {} }, ctx);
    await end?.({ toolCallId: "ff-1", toolName: "flameframe_inspect", result: {}, isError: false }, ctx);
    expect(updates.at(-1)?.state).toMatchObject({ label: "FF", detail: "processing" });

    await end?.({ toolCallId: "ff-2", toolName: "flameframe_process", result: {}, isError: false }, ctx);
    expect(updates.at(-1)).toEqual({ id: "flameframe", state: undefined });
  });

  it("shows one breathing FF inline status while a FlameFrame tool runs", async () => {
    const pi = createMockPi();
    const updates: InlineModeUpdate[] = [];
    pi.events.on(INLINE_MODE_EVENT, (update) => updates.push(update as InlineModeUpdate));
    const ctx = createMockContext();
    flameframeUi(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);
    ctx.ui.setStatus.mockClear();

    await pi.events.get("tool_execution_start")?.[0]({ toolCallId: "ff-1", toolName: "flameframe_process", args: {} }, ctx);
    expect(updates.at(-1)?.state).toMatchObject({ label: "FF", detail: "processing", priority: 110 });
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(updates.at(-1)?.state?.frames?.[0]?.icon).toBe("");

    await pi.events.get("tool_execution_end")?.[0]({ toolCallId: "ff-1", toolName: "flameframe_process", result: {}, isError: false }, ctx);
    expect(updates.at(-1)).toEqual({ id: "flameframe", state: undefined });
  });
});
