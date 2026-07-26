import { describe, expect, it, vi } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import { INLINE_MODE_EVENT, publishInlineMode, smoothBreathingFrames } from "./inline-modes";

describe("inline modes", () => {
  it("publishes updates over Pi's inter-extension event bus", () => {
    const pi = createMockPi();
    const listener = vi.fn();
    pi.events.on(INLINE_MODE_EVENT, listener);

    publishInlineMode(pi as any, "test", { label: "TEST" });

    expect(listener).toHaveBeenCalledWith({ id: "test", state: { label: "TEST" } });
  });

  it("builds a fixed-glyph cosine color breath", () => {
    const frames = smoothBreathingFrames("", [10, 20, 30], [110, 120, 130], 60);

    expect(frames).toHaveLength(60);
    expect(frames.every((frame) => frame.icon === "")).toBe(true);
    expect(frames[0]?.color).toEqual([10, 20, 30]);
    expect(frames[30]?.color).toEqual([110, 120, 130]);
    expect(frames.at(-1)?.color).toEqual([10, 20, 30]);
  });
});
