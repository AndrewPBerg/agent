import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import codexGoal from "./index";

function contextWithBranch(branch: unknown[]) {
  const base = createMockContext();
  return createMockContext({
    ui: {
      ...base.ui,
      onTerminalInput: vi.fn(() => vi.fn()),
    },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
    sessionManager: {
      ...base.sessionManager,
      getBranch: vi.fn(() => branch),
    },
  });
}

describe("codex goal compaction continuity", () => {
  it("restores an active goal across a compaction entry and queues the next Pi turn", async () => {
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    codexGoal(pi);

    const initialContext = contextWithBranch([]);
    await pi.commands.get("goal").handler("finish the acceptance checks", initialContext);

    const persisted = pi.entries.at(-1);
    expect(persisted?.customType).toBe("codex-goal");
    expect(persisted?.data.goal.status).toBe("active");

    const compactedBranch = [
      { type: "custom", customType: persisted!.customType, data: persisted!.data },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "goal-1",
        summary: "Earlier work compacted",
        firstKeptEntryId: "goal-1",
        tokensBefore: 100_000,
      },
    ];
    const resumedContext = contextWithBranch(compactedBranch);
    await pi.events.get("session_start")?.[0]?.({ reason: "startup" }, resumedContext);

    vi.mocked(pi.sendMessage).mockClear();
    await pi.events.get("agent_end")?.[0]?.({}, resumedContext);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "codex-goal-event",
        details: expect.objectContaining({
          kind: "continuation",
          goal: expect.objectContaining({ objective: "finish the acceptance checks", status: "active" }),
        }),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("deduplicates continuation requests while one is already queued", async () => {
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    codexGoal(pi);

    const ctx = contextWithBranch([]);
    await pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    await pi.commands.get("goal").handler("finish once", ctx);
    vi.mocked(pi.sendMessage).mockClear();

    const agentEnd = pi.events.get("agent_end")?.[0];
    agentEnd?.({}, ctx);
    agentEnd?.({}, ctx);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(pi.sendMessage).toHaveBeenCalledOnce();
  });
});
