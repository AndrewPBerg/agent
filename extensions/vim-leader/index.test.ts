import { afterEach, describe, expect, it, vi } from "vitest";
import { LEADER_MAPPINGS } from "../../leader-mappings";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import vimLeader, { createVimLeader } from "./index";
import { VIM_LEADER_EVENT, type VimLeaderInvocation } from "./protocol";

afterEach(() => {
  vi.useRealTimers();
});

describe("vim leader", () => {
  it("dispatches top-level mappings from an empty editor", async () => {
    const pi = createMockPi();
    const invoked: VimLeaderInvocation[] = [];
    pi.events.on(VIM_LEADER_EVENT, (data) => invoked.push(data as VimLeaderInvocation));
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
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("m")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("d")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("y")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("f")).toEqual({ consume: true });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("u")).toEqual({ consume: true });
    expect(invoked).toEqual([
      { sequence: " ", action: "session-text" },
      { sequence: "m", action: "mailbox" },
      { sequence: "d", action: "details" },
      { sequence: "y", action: "yosoi" },
      { sequence: "f", action: "flameframe" },
      { sequence: "u", action: "usage" },
    ]);
    expect(LEADER_MAPPINGS).toEqual({
      " ": "session-text",
      f: "flameframe",
      m: "mailbox",
      r: "reload",
      u: "usage",
      y: "yosoi",
      d: "details",
    });
  });

  it("only starts leader sequences in normal or visual Vim modes", async () => {
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
      },
    });

    vimLeader(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    pi.events.emit("vim-mode:update", { mode: "insert" });
    expect(terminalInput?.(" ")).toBeUndefined();
    expect(terminalInput?.("m")).toBeUndefined();

    pi.events.emit("vim-mode:update", { mode: "normal" });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("m")).toEqual({ consume: true });

    pi.events.emit("vim-mode:update", { mode: "visual" });
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("m")).toEqual({ consume: true });
    expect(invoked).toEqual(["m", "m"]);
  });

  it("ignores Kitty key releases between leader and command", async () => {
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
      },
    });

    vimLeader(pi);
    await pi.events.get("session_start")?.[0]({}, ctx);

    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("\u001b[32;1:3u")).toBeUndefined();
    expect(terminalInput?.("m")).toEqual({ consume: true });
    expect(terminalInput?.("\u001b[109;1:3u")).toBeUndefined();
    expect(invoked).toEqual(["m"]);
  });

  it("submits the built-in reload command for leader-r", async () => {
    const pi = createMockPi();
    const submitEditor = vi.fn();
    let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
    const setEditorText = vi.fn();
    const ctx = createMockContext({
      ui: {
        onTerminalInput: vi.fn((handler) => {
          terminalInput = handler;
          return vi.fn();
        }),
        getEditorText: vi.fn(() => ""),
        setEditorText,
      },
    });

    createVimLeader(pi, { submitEditor, defer: (callback) => callback() });
    await pi.events.get("session_start")?.[0]({}, ctx);

    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("\u001b[32;1:3u")).toBeUndefined();
    expect(terminalInput?.("r")).toEqual({ consume: true });
    expect(setEditorText).toHaveBeenCalledWith("/reload");
    expect(submitEditor).toHaveBeenCalledOnce();
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
