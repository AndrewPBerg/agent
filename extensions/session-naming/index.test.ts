import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseTitleModelRef } from "./model-selection";
import { shouldCreateInitialTitlePending } from "./title-scheduling";
import { normalizeTitle } from "./title-utils";

describe("session naming", () => {
  it("uses Codex Spark as the repository default naming model", async () => {
    const config = await readFile(new URL("./config.ts", import.meta.url), "utf8");
    expect(config).toContain('model: "openai-codex/gpt-5.3-codex-spark"');
    expect(parseTitleModelRef("openai-codex/gpt-5.3-codex-spark")).toEqual({
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark",
      thinking: undefined,
    });
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

    expect(
      shouldCreateInitialTitlePending({
        pending: false,
        generating: false,
        titleGenerationEnabled: true,
        hasTemporaryTitle: false,
        shouldSkip: true,
      }),
    ).toBe(false);
  });

  it("normalizes model output into a bounded session title", () => {
    expect(
      normalizeTitle("```\nfix(auth): refresh token flow\n```", {
        maxLength: 52,
        scopeMaxLength: 12,
        useTags: true,
        tags: ["fix"],
      }),
    ).toBe("fix(auth): refresh token flow");
  });
});
