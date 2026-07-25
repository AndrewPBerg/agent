import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import vimLeader from "./index";
import { VIM_LEADER_EVENT } from "./protocol";

afterEach(() => {
  vi.useRealTimers();
});

describe("vim leader", () => {
  it("dispatches mailbox and details sequences from an empty editor", async () => {
    const pi = createMockPi();
    const invoked: string[] = [];
    pi.events.on(VIM_LEADER_EVENT, (data) => invoked.push((data as { sequence: string }).sequence));
    let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
    const ctx = createMockContext({
      ui: {
        onTerminalInput: vi.fn((handler) => {
          terminalInput = handler;
          return vi.fn();
        }),
        getEditorText: vi.fn(() => ""),
        pasteToEditor: vi.fn(),
      },
    });

    vimLeader(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("m")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("d")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("y")).toEqual({ consume: true });
    expect(invoked).toEqual(["m", "d", "y"]);
  });

  it("never mutates the editor buffer asynchronously", async () => {
    vi.useFakeTimers();
    const pi = createMockPi();
    let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
    const pasteToEditor = vi.fn();
    const getEditorText = vi.fn(() => "");
    const ctx = createMockContext({
      ui: {
        onTerminalInput: vi.fn((handler) => {
          terminalInput = handler;
          return vi.fn();
        }),
        getEditorText,
        pasteToEditor,
      },
    });

    vimLeader(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    terminalInput?.(" ");
    expect(terminalInput?.("x")).toEqual({ data: "x" });

    terminalInput?.(" ");
    await vi.advanceTimersByTimeAsync(500);
    expect(pasteToEditor).not.toHaveBeenCalled();
    expect(terminalInput?.("x")).toBeUndefined();

    getEditorText.mockReturnValue("prompt");
    expect(terminalInput?.(" ")).toBeUndefined();
  });
});
