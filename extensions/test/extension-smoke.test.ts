import { describe, expect, it } from "vitest";
import { createMockPi } from "./mocks/pi-coding-agent";

const extensionNames = [
  "codex-goal",
  "codex-status",
  "copy-full",
  "bugrun",
  "combinations",
  "flameframe",
  "inline-details",
  "fork-awareness",
  "loop",
  "network-resume",
  "omarchy-agent-notify",
  "omarchy-system-theme",
  "orchestrator-run",
  "plan-mode",
  "pi-sandbox",
  "qa",
  "shortbreath",
  "subagent-mailbox",
  "supp-first",
  "vim-leader",
  "wtf-worktrees",
  "yosoi-workflows",
] as const;

describe("extensions", () => {
  it.each(extensionNames)("%s loads and registers Pi hooks", async (name) => {
    const mod = await import(`../${name}/index.ts`);
    const pi = createMockPi();

    await mod.default(pi);

    const registrationCount = pi.events.size + pi.commands.size + pi.tools.size;
    expect(registrationCount).toBeGreaterThan(0);
  });
});
