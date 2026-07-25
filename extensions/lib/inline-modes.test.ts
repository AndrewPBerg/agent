import { describe, expect, it, vi } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import { INLINE_MODE_EVENT, type InlineModeState, inlineModeAnimationInterval, publishInlineMode, sortedInlineModes } from "./inline-modes";

describe("inline modes", () => {
  it("publishes updates over Pi's inter-extension event bus", () => {
    const pi = createMockPi();
    const listener = vi.fn();
    pi.events.on(INLINE_MODE_EVENT, listener);

    publishInlineMode(pi as any, "test", { label: "TEST" });

    expect(listener).toHaveBeenCalledWith({ id: "test", state: { label: "TEST" } });
  });

  it("sorts modes and exposes the fastest animation interval", () => {
    const states = new Map<string, InlineModeState>([
      ["test-low", { label: "LOW", priority: 1, frames: [{ icon: "a" }, { icon: "b" }], intervalMs: 200 }],
      ["test-high", { label: "HIGH", priority: 10, frames: [{ icon: "a" }, { icon: "b" }], intervalMs: 100 }],
    ]);

    const modes = sortedInlineModes(states);

    expect(modes.map(({ id }) => id)).toEqual(["test-high", "test-low"]);
    expect(inlineModeAnimationInterval(modes)).toBe(100);
  });
});
