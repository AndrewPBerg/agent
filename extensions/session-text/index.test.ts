import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { VIM_LEADER_EVENT } from "../vim-leader/protocol";
import sessionText from "./index";

const { openSessionTextBrowser } = vi.hoisted(() => ({
  openSessionTextBrowser: vi.fn(async () => {}),
}));

vi.mock("./browser", () => ({ openSessionTextBrowser }));

beforeEach(() => {
  openSessionTextBrowser.mockClear();
});

describe("session text extension", () => {
  it("registers the command and opens from leader-space", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    sessionText(pi);

    expect(pi.commands.get("session-text")?.description).toContain("canonical session text");
    await pi.events.get("session_start")?.[0]({}, ctx);
    pi.events.emit(VIM_LEADER_EVENT, { sequence: " ", action: "session-text" });
    await vi.waitFor(() => expect(openSessionTextBrowser).toHaveBeenCalledWith(ctx));

    await pi.commands.get("session-text")?.handler("", ctx);
    expect(openSessionTextBrowser).toHaveBeenCalledTimes(2);
  });

  it("does not reopen from leader after session shutdown", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    sessionText(pi);

    await pi.events.get("session_start")?.[0]({}, ctx);
    await Promise.all((pi.events.get("session_shutdown") ?? []).map((handler) => handler({}, ctx)));
    pi.events.emit(VIM_LEADER_EVENT, { sequence: " ", action: "session-text" });

    expect(openSessionTextBrowser).not.toHaveBeenCalled();
  });
});
