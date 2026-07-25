import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: mocks.completeSimple,
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class SessionManager {
    static list = vi.fn(async () => []);
    static open = vi.fn();
  }
  class SettingsManager {
    static create(_cwd: string, agentDir: string) {
      return {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
        getSessionDir: () => join(agentDir, "sessions"),
      };
    }
  }
  return {
    getAgentDir: () => join(tmpdir(), "pi-agent"),
    SessionManager,
    SettingsManager,
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Key: {
    escape: "escape",
    up: "up",
    down: "down",
    enter: "enter",
    backspace: "backspace",
    ctrl: (key: string) => `ctrl+${key}`,
  },
  matchesKey: (input: string, key: string) => input === key,
  truncateToWidth: (value: string, width: number) => value.slice(0, width),
  visibleWidth: (value: string) => value.length,
  Text: class Text {
    constructor(public text: string) {}
  },
}));

import { generateSessionTitleNow } from "./auto-title";
import sessionNaming from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  mocks.completeSimple.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createPi() {
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  const commands = new Map<string, any>();
  return {
    events,
    commands,
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      events.set(name, [...(events.get(name) ?? []), handler]);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    getSessionName: vi.fn(() => undefined),
    setSessionName: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ code: 0, stdout: "" })),
  };
}

describe("session naming runtime", () => {
  it("loads the full extension and registers naming plus session-management surfaces", async () => {
    const pi = createPi();
    await sessionNaming(pi as never);

    expect(pi.events.has("before_agent_start")).toBe(true);
    expect(pi.events.has("turn_end")).toBe(true);
    expect(pi.commands.has("rename")).toBe(true);
    expect(pi.commands.has("sessions")).toBe(true);
  });

  it("exits cleanly when the sessions overlay is unavailable outside TUI mode", async () => {
    const pi = createPi();
    await sessionNaming(pi as never);
    const ctx = {
      cwd: tmpdir(),
      waitForIdle: vi.fn(async () => {}),
      ui: { custom: vi.fn(async () => undefined) },
    };

    await expect(pi.commands.get("sessions").handler("", ctx)).resolves.toBeUndefined();
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
  });

  it("uses Codex Spark to generate and persist a normalized title", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-session-naming-"));
    temporaryDirectories.push(cwd);
    const pi = createPi();
    const spark = {
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark",
      api: "openai-codex-responses",
      contextWindow: 128_000,
    };
    const branch = [
      {
        type: "message",
        message: { role: "user", content: "Investigate refresh token failures" },
      },
    ];
    const ctx = {
      cwd,
      hasUI: false,
      isIdle: () => true,
      model: spark,
      modelRegistry: {
        find: vi.fn((provider: string, id: string) => (provider === spark.provider && id === spark.id ? spark : undefined)),
        getAvailable: vi.fn(() => [spark]),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "1" } })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        getEntries: vi.fn(() => []),
        getSessionFile: vi.fn(() => join(cwd, "session.jsonl")),
      },
      getContextUsage: vi.fn(() => ({ tokens: 100 })),
      ui: { setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
    };
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "```\nfix(auth): refresh token failures\n```" }],
    });

    const result = await generateSessionTitleNow(pi as never, ctx as never);

    expect(result).toEqual({ title: "fix(auth): refresh token failures", temporary: false });
    expect(mocks.completeSimple).toHaveBeenCalledOnce();
    expect(mocks.completeSimple.mock.calls[0][0]).toBe(spark);
    expect(mocks.completeSimple.mock.calls[0][1].messages[0].content).toContain("[user] Investigate refresh token failures");
    expect(mocks.completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 80, apiKey: "test-key" });
    expect(mocks.completeSimple.mock.calls[0][2]).not.toHaveProperty("temperature");
    expect(pi.setSessionName).toHaveBeenCalledWith("fix(auth): refresh token failures");
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-extensions-session-title",
      expect.objectContaining({ model: "openai-codex/gpt-5.3-codex-spark", temporary: false }),
    );
  });
});
