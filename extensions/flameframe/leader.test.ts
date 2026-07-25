import { describe, expect, it, vi } from "vitest";
import flameframeUi from "../flameframe";
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
});
