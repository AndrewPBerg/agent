import { describe, expect, it } from "vitest";
import { createMockPi } from "./mocks/pi-coding-agent";

const extensionNames = [
  "codex-goal",
  "codex-status",
  "copy-full",
  "bugrun",
  "combinations",
  "flameframe",
  "loop",
  "omarchy-agent-notify",
  "omarchy-system-theme",
  "orchestrator-run",
  "plan-mode",
  "pi-sandbox",
  "qa",
  "shortbreath",
  "supp-first",
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
