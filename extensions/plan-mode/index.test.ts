import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import planMode, { __planModeTest } from "./index";

describe("plan-mode", () => {
  it("enters read-only planning mode and blocks writes", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    planMode(pi);
    const ctx = createMockContext();

    await pi.commands.get("plan").handler("add login tests", ctx);

    expect(pi.activeTools).toContain("read");
    expect(pi.activeTools).toContain("bash");
    expect(pi.activeTools).toContain("plan_mode_question");
    expect(pi.activeTools).not.toContain("edit");
    expect(pi.activeTools).not.toContain("write");
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("add login tests"));

    const blockWrite = await pi.events.get("tool_call")![0]({ toolName: "write", input: { path: "x", content: "y" } });
    expect(blockWrite?.block).toBe(true);

    const blockBash = await pi.events.get("tool_call")![0]({ toolName: "bash", input: { command: "rm -rf tmp" } });
    expect(blockBash?.block).toBe(true);
  });

  it("detects a proposed plan and continues in the current context via a global plan file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-plan-mode-"));
    const oldPiHome = process.env.PI_HOME;
    process.env.PI_HOME = join(tmp, "global-pi");
    try {
      const pi = createMockPi();
      pi.sendUserMessage = vi.fn();
      planMode(pi);
      const ctx = createMockContext({ cwd: tmp, waitForIdle: vi.fn() });

      await pi.commands.get("plan").handler("do the thing", ctx);
      pi.activeTools = ["read", "bash"]; // prove continue restores captured tools, not current plan tools

      await pi.events.get("agent_end")![0](
        {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "<proposed_plan>\n# Plan\n## Summary\nDo it\n## Test Plan\nRun tests\n</proposed_plan>" }],
            },
          ],
        },
        ctx,
      );

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Plan ready"), "info");
      await pi.commands.get("plan").handler("continue", ctx);

      expect(pi.activeTools).toEqual(["read", "bash", "edit", "write"]);
      const prompt = vi.mocked(pi.sendUserMessage).mock.calls.at(-1)?.[0] as string;
      expect(prompt).toContain("Implement the approved plan from");
      expect(prompt).toContain("Read that file first");
      expect(prompt).not.toContain("Do it");
      const latest = pi.entries.at(-1)?.data;
      expect(latest.planFile).toContain(join("global-pi", "plans"));
      expect(latest.planFile).not.toContain(join(tmp, ".pi", "plans"));
      expect(await readFile(latest.planFile, "utf8")).toContain("Do it");
    } finally {
      if (oldPiHome === undefined) delete process.env.PI_HOME;
      else process.env.PI_HOME = oldPiHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("saves the plan globally before starting a fresh implementation session", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-plan-mode-"));
    const oldPiHome = process.env.PI_HOME;
    process.env.PI_HOME = join(tmp, "global-pi");
    try {
      const pi = createMockPi();
      pi.sendUserMessage = vi.fn();
      planMode(pi);
      const replacementSend = vi.fn();
      const ctx = createMockContext({
        cwd: tmp,
        waitForIdle: vi.fn(),
        newSession: vi.fn(async ({ withSession }) => {
          await withSession({ sendUserMessage: replacementSend });
          return { cancelled: false };
        }),
      });

      await pi.commands.get("plan").handler("fresh implement", ctx);
      await pi.events.get("agent_end")![0](
        {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "<proposed_plan>\n# Fresh Plan\n## Summary\nFresh\n## Test Plan\nFocused check\n</proposed_plan>" },
              ],
            },
          ],
        },
        ctx,
      );

      await pi.commands.get("plan").handler("clear-context", ctx);

      expect(ctx.newSession).toHaveBeenCalled();
      const kickoff = replacementSend.mock.calls.at(-1)?.[0] as string;
      expect(kickoff).toContain("Read that file first");
      expect(kickoff).toContain("durable source of truth");
      expect(kickoff).not.toContain("# Fresh Plan");
      const latest = pi.entries.at(-1)?.data;
      expect(latest.planFile).toContain(join("global-pi", "plans"));
      const saved = await readFile(latest.planFile, "utf8");
      expect(saved).toContain("# Fresh Plan");
    } finally {
      if (oldPiHome === undefined) delete process.env.PI_HOME;
      else process.env.PI_HOME = oldPiHome;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("extracts tagged plans and allows read-only planning commands", () => {
    expect(__planModeTest.extractProposedPlan("x<proposed_plan>\n# P\n</proposed_plan>")).toBe("# P");
    expect(__planModeTest.isSafePlanningCommand("supp -n tree -d 2 && rg foo")).toBe(true);
    expect(__planModeTest.isSafePlanningCommand('mkdir -p .yosoi && uvx yosoi search "pi plan mode" --json > .yosoi/search.json')).toBe(
      true,
    );
    expect(__planModeTest.isSafePlanningCommand("rg foo > out.txt")).toBe(false);
    expect(__planModeTest.isSafePlanningCommand('uvx yosoi search "x" --json > notes/search.json')).toBe(false);
    expect(__planModeTest.isSafePlanningCommand('uvx yosoi fetch "https://example.com" --output /tmp/fetch --json')).toBe(false);
  });
});
