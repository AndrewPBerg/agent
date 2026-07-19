import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import loop, { parseLoopDsl } from "./index";

describe("loop extension", () => {
  it("parses an objective followed by repeated same-session commands", () => {
    expect(parseLoopDsl("ship auth | qa make it clean loop 3")).toEqual([
      { prompt: "ship auth" },
      { prompt: "/qa make it clean" },
      { prompt: "/qa make it clean" },
      { prompt: "/qa make it clean" },
    ]);
  });

  it("rejects empty stages and invalid repeat counts", () => {
    expect(parseLoopDsl("ship | | qa")).toBeNull();
    expect(parseLoopDsl("ship | qa loop 0")).toBeNull();
    expect(parseLoopDsl("ship | qa loop 26")).toBeNull();
  });

  it("advances only after the current agent run settles", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    loop(pi);
    const ctx = createMockContext({ isIdle: vi.fn(() => true) });

    await pi.commands.get("loop").handler("ship auth | qa loop 2", ctx);
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("ship auth");

    const settled = pi.events.get("agent_settled")?.[0];
    await settled?.({}, ctx);
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("/qa");

    await settled?.({}, ctx);
    expect(pi.sendUserMessage).toHaveBeenLastCalledWith("/qa");

    await settled?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop complete", "info");
  });

  it("stops an active pipeline", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    loop(pi);
    const ctx = createMockContext({ isIdle: vi.fn(() => true) });

    await pi.commands.get("loop").handler("ship | qa", ctx);
    await pi.commands.get("loop").handler("stop", ctx);
    await pi.events.get("agent_settled")?.[0]({}, ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop stopped", "info");
  });
});
