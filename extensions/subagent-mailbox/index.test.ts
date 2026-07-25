import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { VIM_LEADER_EVENT } from "../vim-leader/protocol";
import { __subagentMailboxTest, createSubagentMailbox } from "./index";
import { MAILBOX_SPAWN_REQUEST_EVENT, MAILBOX_TERMINAL_EVENT } from "./protocol";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function assistantEvent(text: string) {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
    },
  });
}

function setup(
  discoverAgents = vi.fn(async () => [{ name: "reviewer", description: "Review code", systemPrompt: "", tools: ["read", "bash"] }]),
) {
  const pi = createMockPi();
  pi.sendMessage = vi.fn();
  const child = new FakeChild();
  const runtime = createSubagentMailbox(pi, {
    now: vi.fn().mockReturnValueOnce(1000).mockReturnValue(2000),
    discoverAgents,
    resolvePiInvocation: vi.fn(() => ({ command: "pi", args: ["--mode", "json"] })),
    spawnProcess: vi.fn(() => child as unknown as ChildProcess),
  });
  const ctx = createMockContext();
  return { child, ctx, pi, runtime };
}

describe("push-based subagent mailbox", () => {
  it("returns from spawn_agent before the child completes, then pushes completion", async () => {
    const { child, ctx, pi } = setup();

    const result = await pi.tools
      .get("spawn_agent")
      .execute("call-1", { agent: "reviewer", task: "review the diff" }, undefined, undefined, ctx);

    expect(result.details.job).toMatchObject({ id: "agent-1000-1", status: "running" });
    expect(pi.sendMessage).not.toHaveBeenCalled();

    child.stdout.write(`${assistantEvent("review complete")}\n`);
    child.emit("close", 0);

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-mailbox",
        content: expect.stringContaining("review complete"),
        details: { job: expect.objectContaining({ status: "completed" }) },
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("kills running children on session shutdown without reactivating the old session", async () => {
    const { child, ctx, pi } = setup();
    await pi.tools.get("spawn_agent").execute("call-1", { agent: "reviewer", task: "review the diff" }, undefined, undefined, ctx);

    await pi.events.get("session_shutdown")?.[0]({}, ctx);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    ctx.sessionManager.getBranch.mockReturnValue([]);
    await pi.events.get("session_start")?.[0]({}, ctx);
    child.emit("close", null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("marks a zero-exit child without an assistant event as failed", async () => {
    const { child, ctx, pi } = setup();
    await pi.tools.get("spawn_agent").execute("call-1", { agent: "reviewer", task: "emit malformed output" }, undefined, undefined, ctx);

    child.stdout.write("not-json\n");
    child.emit("close", 0);

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
    const listed = await pi.tools.get("list_agents").execute("call-list", {}, undefined, undefined, ctx);
    expect(listed.details.jobs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("without a valid assistant message"),
    });
  });

  it("reserves capacity across concurrent spawn requests", async () => {
    const { ctx, pi } = setup();
    await pi.commands.get("subagent-cap").handler("1", ctx);
    const spawn = pi.tools.get("spawn_agent");

    const first = spawn.execute("call-1", { agent: "reviewer", task: "first" }, undefined, undefined, ctx);
    const second = spawn.execute("call-2", { agent: "reviewer", task: "second" }, undefined, undefined, ctx);

    await expect(second).rejects.toThrow("at most 1");
    await expect(first).resolves.toMatchObject({ details: { job: { status: "running" } } });
  });

  it("shows launching work as pending, then retains it in previous session history", async () => {
    type Definition = { name: string; description: string; systemPrompt: string; tools: string[] };
    let resolveAgents: ((agents: Definition[]) => void) | undefined;
    const discovery = new Promise<Definition[]>((resolve) => {
      resolveAgents = resolve;
    });
    const { child, ctx, pi, runtime } = setup(vi.fn(() => discovery));
    const spawn = pi.tools
      .get("spawn_agent")
      .execute("call-pending", { agent: "reviewer", task: "pending task" }, undefined, undefined, ctx);

    await vi.waitFor(() => expect([...runtime.jobs.values()][0]?.status).toBe("launching"));
    let rendered = "";
    ctx.ui.custom = vi.fn(async (factory) => {
      const component = factory(
        { requestRender: vi.fn() },
        { fg: (_color: string, value: string) => value, bold: (value: string) => value },
        {},
        vi.fn(),
      );
      rendered = component.render(90).join("\n");
      component.dispose();
    });
    await pi.commands.get("subagents").handler("", ctx);
    expect(rendered).toContain("0 active · 1 pending");
    expect(rendered).toContain("Pending");
    expect(rendered).toContain("launching  reviewer");

    resolveAgents?.([{ name: "reviewer", description: "Review code", systemPrompt: "", tools: ["read", "bash"] }]);
    await spawn;
    child.stdout.write(`${assistantEvent("finished result")}\n`);
    child.emit("close", 0);
    await vi.waitFor(() => expect([...runtime.jobs.values()][0]?.status).toBe("completed"));

    await pi.commands.get("subagents").handler("", ctx);
    expect(rendered).toContain("Previous");
    expect(rendered).toContain("completed  reviewer");
    expect(rendered).toContain("finished result");
  });

  it("defaults to six concurrent agents and supports a session-scoped cap", async () => {
    const { ctx, pi } = setup();
    const spawn = pi.tools.get("spawn_agent");

    for (let index = 0; index < 6; index += 1) {
      await spawn.execute(`call-${index}`, { agent: "reviewer", task: `review ${index}` }, undefined, undefined, ctx);
    }
    await expect(spawn.execute("call-6", { agent: "reviewer", task: "overflow" }, undefined, undefined, ctx)).rejects.toThrow("at most 6");

    await pi.commands.get("subagent-cap").handler("8", ctx);
    expect(pi.entries.at(-1)).toEqual({ customType: "subagent-mailbox-config", data: { version: 1, cap: 8 } });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Subagent cap set to 8", "info");

    await spawn.execute("call-7", { agent: "reviewer", task: "review 7" }, undefined, undefined, ctx);
    await spawn.execute("call-8", { agent: "reviewer", task: "review 8" }, undefined, undefined, ctx);
    await expect(spawn.execute("call-9", { agent: "reviewer", task: "overflow" }, undefined, undefined, ctx)).rejects.toThrow("at most 8");
  });

  it("opens the live mailbox monitor with leader-m and closes with q", async () => {
    const { child, ctx, pi } = setup();
    await pi.events.get("session_start")?.[0]({}, ctx);
    await pi.tools.get("spawn_agent").execute("call-1", { agent: "reviewer", task: "inspect me" }, undefined, undefined, ctx);

    let rendered: string[] = [];
    let component: { render: (width: number) => string[]; handleInput: (data: string) => void; dispose: () => void } | undefined;
    const requestRender = vi.fn();
    const closed = vi.fn();
    ctx.ui.custom = vi.fn(
      (factory, options) =>
        new Promise<void>((resolve) => {
          component = factory(
            { requestRender },
            { fg: (_color: string, value: string) => value, bold: (value: string) => value },
            {},
            () => {
              closed();
              resolve();
            },
          );
          rendered = component!.render(90);
          expect(options).toMatchObject({ overlay: true, overlayOptions: { anchor: "center", width: "80%" } });
        }),
    );

    pi.events.emit(VIM_LEADER_EVENT, { sequence: "m", action: "mailbox" });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));

    expect(rendered.join("\n")).toContain("Mailbox monitor · 1 active · 0 pending · cap 6");
    expect(rendered.join("\n")).toContain("Active");
    expect(rendered.join("\n")).toContain("inspect me");
    expect(rendered.every((line) => line.length <= 90)).toBe(true);

    child.stdout.write(`${assistantEvent("done")}\n`);
    child.emit("close", 0);
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    component?.handleInput("q");
    expect(closed).toHaveBeenCalledOnce();
    component?.dispose();
  });

  it("restores persisted job snapshots and fails orphaned running jobs", async () => {
    const { ctx, pi } = setup();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    ctx.sessionManager.getBranch.mockReturnValue([
      {
        type: "custom",
        customType: "subagent-mailbox",
        data: {
          version: 1,
          job: {
            id: "old-complete",
            agent: "reviewer",
            task: "completed task",
            cwd: "/repo",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            usage,
          },
        },
      },
      {
        type: "custom",
        customType: "subagent-mailbox",
        data: {
          version: 1,
          job: {
            id: "old-running",
            agent: "reviewer",
            task: "orphaned task",
            cwd: "/repo",
            status: "running",
            startedAt: 3,
            usage,
          },
        },
      },
    ]);

    await pi.events.get("session_start")?.[0]({}, ctx);
    const listed = await pi.tools.get("list_agents").execute("call-list", {}, undefined, undefined, ctx);

    expect(listed.details.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "old-complete", status: "completed" }),
        expect.objectContaining({
          id: "old-running",
          status: "failed",
          error: "Subagent process was not recoverable after session restore.",
        }),
      ]),
    );
  });

  it("restores the cap from the current session and rejects invalid command syntax", async () => {
    const { ctx, pi } = setup();
    ctx.sessionManager.getBranch.mockReturnValue([{ type: "custom", customType: "subagent-mailbox-config", data: { version: 1, cap: 9 } }]);

    await pi.events.get("session_start")?.[0]({}, ctx);
    const listed = await pi.tools.get("list_agents").execute("call-list", {}, undefined, undefined, ctx);
    expect(listed.details.cap).toBe(9);

    await pi.commands.get("subagent-cap").handler(":: 9", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /subagent-cap <int> (1-32)", "warning");
    expect(pi.entries).toHaveLength(0);
  });

  it("runs correlated event-owned jobs without pushing a competing mailbox turn", async () => {
    const { child, ctx, pi } = setup();
    const terminal = vi.fn();
    pi.events.on(MAILBOX_TERMINAL_EVENT, terminal);
    await pi.events.get("session_start")?.[0]({}, ctx);

    pi.events.emit(MAILBOX_SPAWN_REQUEST_EVENT, {
      correlation: { owner: "loop", runId: "run-1", stageId: "stress", attempt: 1, requestId: "req-1" },
      agent: "reviewer",
      task: "stress the diff",
      cwd: ctx.cwd,
      delivery: "event",
    });
    await vi.waitFor(async () => {
      const listed = await pi.tools.get("list_agents").execute("call-list", {}, undefined, undefined, ctx);
      expect(listed.details.jobs).toHaveLength(1);
    });

    child.stdout.write(`${assistantEvent('<lp_result>{"status":"passed","summary":"ok","evidence":[]}</lp_result>')}\n`);
    child.emit("close", 0);

    await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1));
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        correlation: expect.objectContaining({ requestId: "req-1" }),
        job: expect.objectContaining({ status: "completed", delivery: "event" }),
      }),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("parses simple YAML agent definitions", () => {
    expect(
      __subagentMailboxTest.parseAgentDefinition(`---
name: qa
description: Stress the diff
tools: read, bash
model: test/model
---
Stay read-only.`),
    ).toEqual({
      name: "qa",
      description: "Stress the diff",
      tools: ["read", "bash"],
      model: "test/model",
      systemPrompt: "Stay read-only.",
    });
  });
});
