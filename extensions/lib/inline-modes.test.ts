import { afterEach, describe, expect, it, vi } from "vitest";
import { getInlineModes, inlineModeAnimationInterval, setInlineMode, subscribeInlineModes } from "./inline-modes";

const ids = ["test-low", "test-high"];

afterEach(() => {
  for (const id of ids) setInlineMode(id, undefined);
});

describe("inline modes", () => {
  it("publishes multiple prioritized extension modes", () => {
    setInlineMode("test-low", { label: "LOW", priority: 1 });
    setInlineMode("test-high", { label: "HIGH", priority: 10 });

    expect(getInlineModes().map(({ id }) => id)).toEqual(["test-high", "test-low"]);
  });

  it("notifies the footer and exposes the fastest animation interval", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInlineModes(listener);

    setInlineMode("test-low", {
      label: "LOW",
      frames: [{ icon: "a" }, { icon: "b" }],
      intervalMs: 200,
    });
    setInlineMode("test-high", {
      label: "HIGH",
      frames: [{ icon: "a" }, { icon: "b" }],
      intervalMs: 100,
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(inlineModeAnimationInterval()).toBe(100);

    unsubscribe();
    setInlineMode("test-high", undefined);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
