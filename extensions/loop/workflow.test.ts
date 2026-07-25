import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAILBOX_CANCEL_RUN_EVENT,
  MAILBOX_SPAWN_REQUEST_EVENT,
  MAILBOX_TERMINAL_EVENT,
  type MailboxSpawnRequest,
} from "../subagent-mailbox/protocol";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import { loadLoopConfig, parseLoopConfig, selectStressProfiles } from "./config";
import { completeLoopArguments, parseInlineWorkflow } from "./dsl";
import { LoopEngine } from "./engine";
import type { LoopConfig } from "./schemas";

const emptyConfig: LoopConfig = {
  version: 1,
  defaults: { prMode: "draft" },
  workflows: {},
  stressProfiles: {},
};

function setupEngine() {
  const pi = createMockPi();
  pi.sendUserMessage = vi.fn();
  (pi as any).exec = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return { stdout: "", code: 1 };
    if (args[0] === "branch") return { stdout: "feature/lp\n", code: 0 };
    return { stdout: "", code: 0 };
  });
  const ctx = createMockContext();
  const engine = new LoopEngine(pi as any, emptyConfig);
  return { ctx, engine, pi };
}

describe("loop workflow authoring", () => {
  it("parses the gated inline workflow", () => {
    const parsed = parseInlineWorkflow("qa until clean max 3 | stress auto | pr draft if passed");
    expect(parsed).toMatchObject({
      success: true,
      workflow: {
        stages: [
          { type: "qa", maxAttempts: 3 },
          { type: "stress", profile: "auto" },
          { type: "pr", mode: "draft", when: "passed" },
        ],
      },
    });
  });

  it("returns full-prefix contextual completions", () => {
    expect(completeLoopArguments("qa until clean max 3 | st", ["qa-pr"], ["nimbal-dagster"])).toContainEqual(
      expect.objectContaining({ value: "qa until clean max 3 | stress auto" }),
    );
    expect(completeLoopArguments("qa-", ["qa-pr"], [])).toContainEqual(expect.objectContaining({ value: "qa-pr" }));
  });

  it("loads the shipped qa-pr workflow without repo-specific stress profiles", () => {
    const config = parseLoopConfig(readFileSync(new URL("../../loops/qa-pr.yaml", import.meta.url), "utf8"));
    expect(config.workflows["qa-pr"].stages.map((stage) => stage.type)).toEqual(["qa", "stress", "pr"]);
    expect(config.stressProfiles).toEqual({});
    expect(config.workflows["qa-pr"].stages[2]).toMatchObject({ type: "pr", mode: "draft" });
  });

  it("does not let a project profile-only file reset a global PR default", () => {
    const root = mkdtempSync(join(tmpdir(), "lp-config-"));
    const previousPiHome = process.env.PI_HOME;
    try {
      process.env.PI_HOME = join(root, "home");
      const globalLoops = join(process.env.PI_HOME, "agent", "loops");
      const project = join(root, "project");
      const projectLoops = join(project, ".pi", "loops");
      mkdirSync(globalLoops, { recursive: true });
      mkdirSync(projectLoops, { recursive: true });
      writeFileSync(join(globalLoops, "defaults.yaml"), "version: 1\ndefaults:\n  prMode: ready\n");
      writeFileSync(
        join(projectLoops, "stress.yaml"),
        "version: 1\nstressProfiles:\n  runtime:\n    agent: reviewer\n    task: stress it\n",
      );

      const loaded = loadLoopConfig(createMockContext({ cwd: project, isProjectTrusted: () => true }));
      expect(loaded.defaults.prMode).toBe("ready");
      expect(loaded.stressProfiles).toHaveProperty("runtime");
    } finally {
      if (previousPiHome === undefined) delete process.env.PI_HOME;
      else process.env.PI_HOME = previousPiHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates YAML and selects every matching automatic stress profile", () => {
    const config = parseLoopConfig(`
version: 1
defaults:
  prMode: ready
workflows:
  qa-pr:
    stages:
      - type: qa
      - type: pr
stressProfiles:
  repo:
    match:
      cwdBasename: nimbal
    agent: reviewer
    task: repo stress
  frontend:
    match:
      fileExtensions: [.tsx]
    agent: reviewer
    task: browser stress
`);
    expect(config.workflows["qa-pr"].stages[0]).toMatchObject({ type: "qa", maxAttempts: 3 });
    expect(config.workflows["qa-pr"].stages[1]).toMatchObject({ type: "pr", mode: "ready" });
    expect(selectStressProfiles(config.stressProfiles, "auto", "nimbal", ["src/App.tsx"]).map((item) => item.id)).toEqual([
      "frontend",
      "repo",
    ]);
  });
});

describe("loop workflow engine", () => {
  it("retries QA after a fix and completes only after a clean report", async () => {
    const { ctx, engine, pi } = setupEngine();
    await engine.start({ stages: [{ type: "qa", maxAttempts: 2 }] }, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    engine.report({ status: "fixed", summary: "fixed edge case", evidence: ["pytest focused"] });
    await engine.onAgentSettled(ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(engine.currentRun()).toMatchObject({ status: "running", attempt: 2 });

    engine.report({ status: "clean", summary: "clean on rerun", evidence: ["pytest focused"] });
    await engine.onAgentSettled(ctx);
    expect(engine.currentRun()).toMatchObject({ status: "completed", currentStage: 1 });
  });

  it("blocks a gated stage that settles without a typed report", async () => {
    const { ctx, engine } = setupEngine();
    await engine.start({ stages: [{ type: "qa", maxAttempts: 2 }] }, ctx);
    await engine.onAgentSettled(ctx);
    expect(engine.currentRun()).toMatchObject({
      status: "blocked",
      blocker: expect.stringContaining("without calling report_loop_stage"),
    });
  });

  it("refuses automatic PR creation from a protected branch", async () => {
    const { ctx, engine, pi } = setupEngine();
    (pi as any).exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "branch") return { stdout: "main\n", code: 0 };
      if (args[0] === "rev-parse") return { stdout: "", code: 1 };
      return { stdout: "", code: 0 };
    });

    await engine.start({ stages: [{ type: "pr", mode: "draft", when: "passed" }] }, ctx);
    expect(engine.currentRun()).toMatchObject({
      status: "blocked",
      blocker: expect.stringContaining("protected branch"),
    });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("waits for every selected stress profile before advancing", async () => {
    const { ctx, pi } = setupEngine();
    pi.registerTool({ name: "spawn_agent" });
    const requests: MailboxSpawnRequest[] = [];
    pi.events.on(MAILBOX_SPAWN_REQUEST_EVENT, (request) => requests.push(request as MailboxSpawnRequest));
    const engine = new LoopEngine(pi as any, {
      ...emptyConfig,
      stressProfiles: {
        first: { match: { fileExtensions: [] }, agent: "reviewer", task: "first" },
        second: { match: { fileExtensions: [] }, agent: "reviewer", task: "second" },
      },
    });

    await engine.start({ stages: [{ type: "stress", profile: "auto" }] }, ctx);
    expect(requests).toHaveLength(2);
    expect(engine.currentRun()).toMatchObject({ status: "waiting", pendingRequestIds: expect.any(Array) });

    const complete = (request: MailboxSpawnRequest) =>
      pi.events.emit(MAILBOX_TERMINAL_EVENT, {
        correlation: request.correlation,
        job: {
          id: request.correlation.requestId,
          agent: request.agent,
          task: request.task,
          cwd: request.cwd,
          status: "completed",
          startedAt: Date.now(),
          output: '<lp_result>{"status":"passed","summary":"stress passed","evidence":["focused run"]}</lp_result>',
        },
      });
    complete(requests[0]);
    expect(engine.currentRun()?.status).toBe("waiting");
    complete(requests[1]);
    await vi.waitFor(() => expect(engine.currentRun()?.status).toBe("completed"));
    expect(engine.currentRun()?.evidence).toHaveLength(2);
  });

  it("cancels owned mailbox work when a run stops", async () => {
    const { ctx, engine, pi } = setupEngine();
    const cancelled = vi.fn();
    pi.events.on(MAILBOX_CANCEL_RUN_EVENT, cancelled);
    await engine.start({ stages: [{ type: "qa", maxAttempts: 2 }] }, ctx);

    engine.stop();
    expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ owner: "loop", runId: engine.currentRun()?.id }));
  });

  it("blocks force pushes while a PR stage is active", async () => {
    const { ctx, engine } = setupEngine();
    await engine.start({ stages: [{ type: "pr", mode: "prepare", when: "passed" }] }, ctx);
    expect(engine.guardToolCall({ toolName: "bash", input: { command: "git push --force origin feature" } })).toMatchObject({
      block: true,
    });
  });
});
