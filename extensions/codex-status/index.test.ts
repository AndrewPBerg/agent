import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { VIM_LEADER_EVENT } from "../vim-leader/protocol";
import codexStatus from "./index";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

async function flushAsyncWork() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("codex status leader mapping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ plan_type: "pro", rate_limit: {} }),
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("toggles usage with leader-u and auto-closes after seven seconds", async () => {
    const pi = createMockPi();
    const setWidget = vi.fn();
    const ctx = createMockContext({ ui: { ...createMockContext().ui, setWidget } });
    codexStatus(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "u", action: "usage" });
    await flushAsyncWork();
    expect(setWidget).toHaveBeenLastCalledWith("codex-status", expect.any(Function), { placement: "aboveEditor" });

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "u", action: "usage" });
    expect(setWidget).toHaveBeenLastCalledWith("codex-status", undefined);

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "u", action: "usage" });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(setWidget).toHaveBeenLastCalledWith("codex-status", expect.any(Function), { placement: "aboveEditor" });
    await vi.advanceTimersByTimeAsync(1);
    expect(setWidget).toHaveBeenLastCalledWith("codex-status", undefined);
  });
});
