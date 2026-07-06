import { describe, expect, it, vi } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import qa, { buildQaPrompt } from "./index";

describe("qa extension", () => {
  it("registers the qa command", () => {
    const pi = createMockPi();
    qa(pi);

    expect(pi.commands.has("qa")).toBe(true);
  });

  it("queues a QA prompt for the current diff", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    qa(pi);

    await pi.commands.get("qa").handler("");

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("QA YOUR worked-on diff"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("staged, unstaged, and untracked changes"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("edge cases"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Tech debt pass"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("debt introduced or worsened"));
  });

  it("includes optional focus text", () => {
    const prompt = buildQaPrompt("focus the auth retry path");

    expect(prompt).toContain("Focus requested by user");
    expect(prompt).toContain("focus the auth retry path");
  });
});
