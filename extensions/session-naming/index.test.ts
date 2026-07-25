import { describe, expect, it, vi } from "vitest";
import { parseTitleModelRef, shouldSkipAutoTitleCandidateForContext } from "./model-selection";
import { formatSessionTranscript } from "./session-transcript";
import { filterSessionTitleMessagesFromContext, SESSION_TITLE_MESSAGE_TYPE } from "./title-context";
import { shouldCreateInitialTitlePending } from "./title-scheduling";
import { BUILTIN_TITLE_TAGS, ISO_FALLBACK_RE, isTrivialInput, normalizeTitle } from "./title-utils";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/pi-agent",
  SettingsManager: class SettingsManager {},
}));

const tagNames = BUILTIN_TITLE_TAGS.map((tag) => tag.name);

describe("session naming", () => {
  it("uses Codex Spark as the repository default naming model", async () => {
    const { DEFAULT_SESSION_NAMING_CONFIG } = await import("./config");
    expect(DEFAULT_SESSION_NAMING_CONFIG.session.titleGeneration.model).toBe("openai-codex/gpt-5.3-codex-spark");
    expect(parseTitleModelRef(DEFAULT_SESSION_NAMING_CONFIG.session.titleGeneration.model)).toEqual({
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark",
      thinking: undefined,
    });
  });

  it.each(["auto", "deepseek/", "deepseek/model:huge"])("rejects invalid naming model reference %s", (value) => {
    expect(parseTitleModelRef(value)).toBeUndefined();
  });

  it("only schedules an initial title for an enabled unnamed idle session", () => {
    expect(
      shouldCreateInitialTitlePending({
        pending: false,
        generating: false,
        titleGenerationEnabled: true,
        hasTemporaryTitle: false,
        shouldSkip: false,
      }),
    ).toBe(true);

    for (const blocked of [
      { pending: true, generating: false, titleGenerationEnabled: true, hasTemporaryTitle: false, shouldSkip: false },
      { pending: false, generating: true, titleGenerationEnabled: true, hasTemporaryTitle: false, shouldSkip: false },
      { pending: false, generating: false, titleGenerationEnabled: false, hasTemporaryTitle: false, shouldSkip: false },
      { pending: false, generating: false, titleGenerationEnabled: true, hasTemporaryTitle: true, shouldSkip: false },
      { pending: false, generating: false, titleGenerationEnabled: true, hasTemporaryTitle: false, shouldSkip: true },
    ]) {
      expect(shouldCreateInitialTitlePending(blocked)).toBe(false);
    }
  });

  it.each(["", "hello", "hi!", "test", "ok", "?", "thanks"])("treats %j as too little context for a permanent title", (input) => {
    expect(isTrivialInput(input)).toBe(true);
  });

  it("normalizes quoted, fenced, ANSI-colored, and TUI-decorated model output", () => {
    const options = { maxLength: 52, scopeMaxLength: 12, useTags: true, tags: tagNames };
    expect(normalizeTitle('"fix(auth): refresh token flow"', options)).toBe("fix(auth): refresh token flow");
    expect(normalizeTitle("```\nfix(auth): refresh token flow\n```", options)).toBe("fix(auth): refresh token flow");
    expect(normalizeTitle("\u001b[32mfix(auth): refresh token flow\u001b[0m", options)).toBe("fix(auth): refresh token flow");
    expect(normalizeTitle("fix(auth): refresh\u202E token\u2066 flow", options)).toBe("fix(auth): refresh token flow");
    expect(normalizeTitle("fix(auth): refresh\u2028token flow", options)).toBe("fix(auth): refresh token flow");
    expect(normalizeTitle("fix(auth): refresh token flow╻▄▄▄▄", options)).toBe("fix(auth): refresh token flow");
  });

  it.each([
    "plain untagged output",
    "fix(scope-with-hyphen): invalid scope",
    "unknown(auth): unsupported tag",
    "fix(auth): description far too long for limit",
  ])("falls back safely for malformed model output %j", (output) => {
    expect(
      normalizeTitle(output, {
        maxLength: output.includes("far too long") ? 8 : 52,
        scopeMaxLength: 12,
        useTags: true,
        tags: tagNames,
      }),
    ).toMatch(ISO_FALLBACK_RE);
  });

  it("bounds forced Codex Spark use against its context window", () => {
    expect(
      shouldSkipAutoTitleCandidateForContext({
        forceCurrentContextCheck: true,
        currentContextTokens: 128_001,
        candidateContextWindow: 128_000,
      }),
    ).toBe(true);
    expect(
      shouldSkipAutoTitleCandidateForContext({
        forceCurrentContextCheck: true,
        currentContextTokens: 128_000,
        candidateContextWindow: 128_000,
      }),
    ).toBe(false);
  });

  it("limits transcript messages and can omit potentially sensitive tool output", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "first user" } },
      { type: "message", message: { role: "toolResult", toolName: "read", content: "SECRET_TOOL_OUTPUT" } },
      { type: "message", message: { role: "assistant", content: "assistant reply" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "latest user" }] } },
    ] as any[];

    const transcript = formatSessionTranscript(branch, { maxMessageCount: 2, includeTools: false });
    expect(transcript).toBe("[assistant] assistant reply\n[user] latest user");
    expect(transcript).not.toContain("SECRET_TOOL_OUTPUT");
  });

  it("removes its display-only update messages from model context", () => {
    const messages = [
      { role: "user", content: "keep" },
      { role: "custom", customType: SESSION_TITLE_MESSAGE_TYPE, content: "drop" },
      { role: "custom", customType: "other", content: "keep too" },
    ];
    expect(filterSessionTitleMessagesFromContext(messages)).toEqual([messages[0], messages[2]]);
  });
});
