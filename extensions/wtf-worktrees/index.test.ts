import { describe, expect, it } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import wtfWorktrees from "./index";

describe("wtf-worktrees", () => {
  it("blocks raw git worktree add", async () => {
    const pi = createMockPi();
    wtfWorktrees(pi);

    const result = await pi.events.get("tool_call")![0]({
      toolName: "bash",
      input: { command: "git worktree add ../trial" },
    });

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("wtf new");
  });

  it("does not keyword-block dotenv usage", async () => {
    const pi = createMockPi();
    wtfWorktrees(pi);

    const result = await pi.events.get("tool_call")![0]({
      toolName: "bash",
      input: { command: 'python -c "from dotenv import load_dotenv; load_dotenv()"' },
    });

    expect(result).toBeUndefined();
  });
});
