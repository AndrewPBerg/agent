import { afterEach, describe, expect, it, vi } from "vitest";
import { INLINE_MODE_EVENT } from "../lib/inline-modes";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import vimLeader from "../vim-leader";
import inlineDetails, { renderInlineFooter } from "./index";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `[${text}]`,
  bold: (text: string) => text,
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: `${process.env.HOME}/projects/pi`,
    mode: "tui",
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, contextWindow: 400_000 },
    getContextUsage: vi.fn(() => ({ tokens: 24_000, contextWindow: 400_000, percent: 6 })),
    sessionManager: {
      getSessionName: vi.fn(() => "inline-details"),
      getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
      getSessionId: vi.fn(() => "session-1"),
      getEntries: vi.fn(() => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 10_000, output: 2_000, cacheRead: 8_000, cacheWrite: 500, cost: { total: 0.12 } },
          },
        },
      ]),
    },
    ...overrides,
  } as any;
}

function footerData() {
  return {
    getGitBranch: vi.fn(() => "main"),
    getExtensionStatuses: vi.fn(() => new Map([["yosoi", "yosoi 3\n1 running"]])),
    getAvailableProviderCount: vi.fn(() => 4),
    onBranchChange: vi.fn(() => vi.fn()),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("inline details", () => {
  it("keeps only directory, name, model, reasoning, and context inline", () => {
    const pi = createMockPi() as any;
    pi.getThinkingLevel = vi.fn(() => "high");

    const line = renderInlineFooter(pi, context(), theme as any, 120);

    expect(line).toContain("~/projects/pi · inline-details");
    expect(line).toContain("gpt-5.6-sol · high · ctx 24k/400k");
    expect(line).not.toContain("↑");
    expect(line).not.toContain("$");
  });

  it("renders inter-extension mode events as compact footer pills", async () => {
    const pi = createMockPi() as any;
    pi.getThinkingLevel = vi.fn(() => "high");
    let footer: { render(width: number): string[] } | undefined;
    const ctx = context({
      ui: {
        setFooter: vi.fn((factory) => {
          footer = factory({ requestRender: vi.fn() }, theme, footerData());
          return footer;
        }),
      },
    });
    inlineDetails(pi);
    await pi.events.get("session_start")?.[0]?.({}, ctx);

    pi.events.emit(INLINE_MODE_EVENT, { id: "test", state: { icon: "", label: "YS", detail: "FETCH", tone: "accent" } });
    const line = footer!.render(120)[0];

    expect(line).toContain("gpt-5.6-sol · high ·  YS FETCH · ctx 24k/400k");
    expect(line).not.toContain("[  YS FETCH ]");
    expect(line).toContain("~/projects/pi · inline-details");
  });

  it("stays within narrow widths and does not claim reasoning without a model", () => {
    const pi = createMockPi() as any;
    pi.getThinkingLevel = vi.fn(() => "high");
    const ctx = context({
      cwd: `${process.env.HOME}/${"deep/".repeat(20)}project`,
      model: undefined,
      sessionManager: {
        ...context().sessionManager,
        getSessionName: vi.fn(() => "a very long session name that must be truncated"),
      },
    });

    for (const width of [0, 1, 8, 20, 40, 80]) {
      expect(renderInlineFooter(pi, ctx, theme as any, width).length).toBeLessThanOrEqual(width);
    }
    expect(renderInlineFooter(pi, ctx, theme as any, 80)).toContain("no-model · n/a");
  });

  it("opens the details modal with leader-d and closes with q", async () => {
    const pi = createMockPi() as any;
    pi.getThinkingLevel = vi.fn(() => "high");

    let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
    let modal: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    let closeModal: (() => void) | undefined;
    const requestRender = vi.fn();
    const data = footerData();
    const ctx = context({
      ui: {
        setFooter: vi.fn((factory) => factory({ requestRender }, theme, data)),
        onTerminalInput: vi.fn((handler) => {
          terminalInput = handler;
          return vi.fn();
        }),
        getEditorText: vi.fn(() => ""),
        pasteToEditor: vi.fn(),
        notify: vi.fn(),
        custom: vi.fn(
          (factory) =>
            new Promise<void>((resolve) => {
              closeModal = resolve;
              modal = factory({ terminal: { rows: 24 }, requestRender }, theme, {}, resolve);
            }),
        ),
      },
    });

    inlineDetails(pi);
    vimLeader(pi);
    for (const handler of pi.events.get("session_start") ?? []) await handler({}, ctx);

    expect(terminalInput?.(" ")).toEqual({ consume: true });
    expect(terminalInput?.("d")).toEqual({ consume: true });
    await vi.waitFor(() => expect(modal).toBeDefined());

    const firstPage = modal!.render(100);
    expect(firstPage.length).toBeLessThanOrEqual(Math.floor(24 * 0.88));
    expect(firstPage.join("\n")).toContain("Git branch");
    expect(firstPage.join("\n")).toContain("Input tokens");

    modal!.handleInput("G");
    expect(requestRender).toHaveBeenCalled();
    const lastPage = modal!.render(100).join("\n");
    expect(lastPage).toContain("Extension status");
    expect(lastPage).toContain("yosoi 3 1 running");

    modal!.handleInput("q");
    await vi.waitFor(() => expect(closeModal).toBeDefined());
  });

  it("keeps leader handling out of the editor buffer", async () => {
    vi.useFakeTimers();
    const pi = createMockPi() as any;
    pi.getThinkingLevel = vi.fn(() => "high");
    let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
    const pasteToEditor = vi.fn();
    let editorText = "";
    const ctx = context({
      ui: {
        setFooter: vi.fn(),
        onTerminalInput: vi.fn((handler) => {
          terminalInput = handler;
          return vi.fn();
        }),
        getEditorText: vi.fn(() => editorText),
        pasteToEditor,
        notify: vi.fn(),
        custom: vi.fn(),
      },
    });

    inlineDetails(pi);
    vimLeader(pi);
    for (const handler of pi.events.get("session_start") ?? []) await handler({}, ctx);

    terminalInput?.(" ");
    expect(terminalInput?.("x")).toEqual({ data: "x" });

    editorText = "draft";
    expect(terminalInput?.(" ")).toBeUndefined();

    editorText = "";
    expect(terminalInput?.(" ")).toEqual({ consume: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasteToEditor).not.toHaveBeenCalled();

    pasteToEditor.mockClear();
    terminalInput?.(" ");
    for (const handler of pi.events.get("session_shutdown") ?? []) await handler({}, ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect(pasteToEditor).not.toHaveBeenCalled();
  });
});
