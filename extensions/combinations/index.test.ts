import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import combinationsExtension, { parseCombinationYaml, renderCombinationPrompt, selectCombinationCards } from "./index";

const sampleYaml = `
id: qa-plus-bugrun
description: Pair QA and BugRun.
priority: 10
when:
  prompts: [qa, review]
  fileExtensions: [.py]
  tools: [bugrun_debug]
guidance: |
  Use BugRun when Python QA depends on runtime state.
preferredTools: [supp.diff-context, bugrun.runtime-evidence]
obligations:
  - inspect diff
  - run focused check
`;

describe("combinations extension", () => {
  afterEach(() => {
    delete process.env.PI_COMBINATIONS_DIRS;
  });

  it("parses combination YAML into a typed card", () => {
    const card = parseCombinationYaml(sampleYaml, "qa-plus-bugrun.yaml");

    expect(card.id).toBe("qa-plus-bugrun");
    expect(card.when.fileExtensions).toEqual([".py"]);
    expect(card.preferredTools).toContain("bugrun.runtime-evidence");
  });

  it("defaults optional trigger lists to empty arrays", () => {
    const card = parseCombinationYaml("id: always-on\nguidance: Always-on guidance.\n");

    expect(card.when).toEqual({ prompts: [], fileExtensions: [], tools: [] });
    expect(selectCombinationCards([card], { prompt: "anything", changedFiles: [], activeTools: [] })).toHaveLength(1);
  });

  it("selects qa-plus-bugrun only for QA prompts with Python changes and BugRun available", () => {
    const card = parseCombinationYaml(sampleYaml);

    expect(
      selectCombinationCards([card], {
        prompt: "QA the current diff",
        changedFiles: ["src/cart.py"],
        activeTools: ["bugrun_debug"],
      }).map((item) => item.id),
    ).toEqual(["qa-plus-bugrun"]);

    expect(
      selectCombinationCards([card], {
        prompt: "QA the current diff",
        changedFiles: ["src/cart.ts"],
        activeTools: ["bugrun_debug"],
      }),
    ).toEqual([]);

    expect(
      selectCombinationCards([card], {
        prompt: "QA the current diff",
        changedFiles: ["src/cart.py"],
        activeTools: [],
      }),
    ).toEqual([]);
  });

  it("renders compact agent guidance instead of YAML", () => {
    const prompt = renderCombinationPrompt([parseCombinationYaml(sampleYaml)]);

    expect(prompt).toContain("COMBINATIONS:");
    expect(prompt).toContain("qa-plus-bugrun");
    expect(prompt).toContain("Use BugRun when Python QA depends on runtime state");
    expect(prompt).not.toContain("fileExtensions:");
  });

  it("selects the grocery-plus-yosoi card for realistic meal prep prompts", async () => {
    const yaml = await readFile("combinations/grocery-plus-yosoi.yaml", "utf8");
    const card = parseCombinationYaml(yaml, "combinations/grocery-plus-yosoi.yaml");

    const selected = selectCombinationCards([card], {
      prompt: "I need meal prep for the week, Korean honey BBQ, banana oatmeal muffins, egg bake, and cottage cheese pasta with spinach",
      changedFiles: [],
      activeTools: ["bash"],
    });

    expect(selected.map((item) => item.id)).toEqual(["grocery-plus-yosoi"]);
    expect(renderCombinationPrompt(selected)).toContain("Yosoi-first web workflows as the discovery layer");
  });

  it("loads YAML on session start and injects selected guidance before the agent starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-combinations-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "qa-plus-bugrun.yaml"), sampleYaml, "utf8");
    process.env.PI_COMBINATIONS_DIRS = root;

    const pi = createMockPi();
    pi.allTools.push({ name: "bugrun_debug" });
    pi.activeTools.push("bugrun_debug");
    (pi as any).exec = vi.fn(async () => ({ stdout: " M src/cart.py\n" }));
    combinationsExtension(pi as any);

    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    const result = await pi.events.get("before_agent_start")?.[0]?.({ prompt: "QA this worked-on diff", systemPrompt: "base" }, ctx);

    expect(result.systemPrompt).toContain("COMBINATIONS:");
    expect(result.systemPrompt).toContain("qa-plus-bugrun");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("combinations", "combos:qa-plus-bugrun");
  });

  it("does not inject guidance for tools that are installed but inactive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-combinations-"));
    await writeFile(join(root, "qa-plus-bugrun.yaml"), sampleYaml, "utf8");
    process.env.PI_COMBINATIONS_DIRS = root;

    const pi = createMockPi();
    pi.allTools.push({ name: "bugrun_debug" });
    (pi as any).exec = vi.fn(async () => ({ stdout: " M src/cart.py\n" }));
    combinationsExtension(pi as any);

    const ctx = createMockContext();
    pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    const result = await pi.events.get("before_agent_start")?.[0]?.({ prompt: "QA this worked-on diff", systemPrompt: "base" }, ctx);

    expect(result).toBeUndefined();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("combinations", undefined);
  });
});
