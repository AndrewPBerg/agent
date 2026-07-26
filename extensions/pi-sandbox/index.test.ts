import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAILBOX_EXTERNAL_JOB_EVENT } from "../subagent-mailbox/protocol";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import piSandbox, { createPiSandbox, restoredBashYieldMs, restoredState } from "./index";
import { protectedPathReason } from "./policy";
import { runSandboxedProcess } from "./runner";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startExtension(entries: any[] = []) {
  const pi = createMockPi();
  piSandbox(pi);
  const ctx = createMockContext({ sessionManager: { getEntries: () => entries } });
  await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
  return { pi, ctx };
}

describe("automatic bash yielding", () => {
  function yieldingSetup() {
    const pi = createMockPi();
    pi.sendMessage = vi.fn();
    const externalJobs: any[] = [];
    pi.events.on(MAILBOX_EXTERNAL_JOB_EVENT, (event) => externalJobs.push(event));
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let resolveCommand: ((result: any) => void) | undefined;
    let childSignal: AbortSignal | undefined;
    const execute = vi.fn((_id, _params, signal: AbortSignal, onUpdate) => {
      childSignal = signal;
      onUpdate?.({ content: [{ type: "text", text: "partial output" }], details: undefined });
      return new Promise((resolve, reject) => {
        resolveCommand = resolve;
        signal.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true });
      });
    });
    const createTool = vi.fn(() => ({ name: "bash", label: "bash", description: "bash", parameters: {}, execute }));
    let now = 1_000;
    createPiSandbox(pi, {
      createBashTool: createTool as any,
      now: () => now,
      setTimer: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length as any;
      }) as typeof setTimeout,
      clearTimer: vi.fn() as any,
    });
    const ctx = createMockContext();
    const start = async () => pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    const fireTimer = (delay: number) => {
      const timer = timers.find((candidate) => candidate.delay === delay);
      if (!timer) throw new Error(`Missing timer ${delay}`);
      timer.callback();
    };
    return {
      pi,
      ctx,
      start,
      externalJobs,
      commandStarted: () => resolveCommand !== undefined,
      resolveCommand: (result: any) => resolveCommand?.(result),
      childSignal: () => childSignal,
      fireTimer,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  it("keeps fast bash calls synchronous and unchanged", async () => {
    const setup = yieldingSetup();
    await setup.start();
    const expected = { content: [{ type: "text", text: "done" }], details: undefined };
    const call = setup.pi.tools.get("bash").execute("call-fast", { command: "true" }, undefined, undefined, setup.ctx);
    await vi.waitFor(() => expect(setup.commandStarted()).toBe(true));
    setup.resolveCommand(expected);

    await expect(call).resolves.toEqual(expected);
    expect(setup.externalJobs).toEqual([]);
    expect(setup.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("yields a slow command, detaches it from the parent turn, and pushes terminal output", async () => {
    const setup = yieldingSetup();
    await setup.start();
    const parent = new AbortController();
    const call = setup.pi.tools.get("bash").execute("call-slow", { command: "pnpm test" }, parent.signal, vi.fn(), setup.ctx);
    await vi.waitFor(() => setup.fireTimer(10_000));

    const yielded = await call;
    expect(yielded.content[0].text).toContain("Background job: bash-1000-1");
    expect(yielded.content[0].text).toContain("partial output");
    expect(setup.externalJobs.at(-1)?.job).toMatchObject({ id: "bash-1000-1", kind: "bash", status: "running" });

    parent.abort();
    expect(setup.childSignal()?.aborted).toBe(false);
    setup.setNow(2_000);
    setup.resolveCommand({ content: [{ type: "text", text: "42 tests passed" }], details: undefined });
    await vi.waitFor(() => expect(setup.externalJobs.at(-1)?.job.status).toBe("completed"));
    setup.fireTimer(250);

    expect(setup.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "bash-mailbox", content: expect.stringContaining("42 tests passed") }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("pins the yield threshold for an in-flight command when configuration changes", async () => {
    const setup = yieldingSetup();
    await setup.start();
    const call = setup.pi.tools.get("bash").execute("call-pinned", { command: "sleep 60" }, undefined, undefined, setup.ctx);
    await setup.pi.commands.get("bash-yield").handler("off", setup.ctx);
    await vi.waitFor(() => setup.fireTimer(10_000));

    const yielded = await call;
    expect(yielded.content[0].text).toContain("still running after 10 seconds");
    await setup.pi.events.get("session_shutdown")![0]({ reason: "quit" }, setup.ctx);
  });

  it("supports session-scoped yield configuration and targeted cancellation", async () => {
    expect(restoredBashYieldMs([{ customType: "bash-mailbox-config", data: { version: 1, yieldMs: null } }])).toBeUndefined();
    const setup = yieldingSetup();
    await setup.start();
    await setup.pi.commands.get("bash-yield").handler("3", setup.ctx);
    const call = setup.pi.tools.get("bash").execute("call-stop", { command: "sleep 60" }, undefined, undefined, setup.ctx);
    await vi.waitFor(() => setup.fireTimer(3_000));
    await call;

    await setup.pi.commands.get("bash-stop").handler("bash-1000-1", setup.ctx);
    await vi.waitFor(() => expect(setup.externalJobs.at(-1)?.job.status).toBe("cancelled"));
    expect(setup.childSignal()?.aborted).toBe(true);
  });
});

describe("pi-sandbox state and policy", () => {
  it("defaults to disabled and persists an explicit per-session toggle", async () => {
    const { pi, ctx } = await startExtension();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-sandbox", "sandbox: off (host tools)");
    expect(restoredState([])).toBe(false);
    const command = pi.commands.get("is_sandboxed");
    const toggle = pi.commands.get("sandboxed");
    const toolCall = pi.events.get("tool_call")![0];

    expect(command.getArgumentCompletions("f")).toEqual([{ value: "false", label: "false" }]);
    const hostToolResult = await toolCall({ toolName: "bugrun_debug", input: {} }, ctx);
    expect(hostToolResult).toBeUndefined();

    await toggle.handler("", ctx);
    expect(restoredState(pi.entries)).toBe(true);
    await toggle.handler("", ctx);
    expect(restoredState(pi.entries)).toBe(false);

    await command.handler("true", ctx);
    expect(pi.entries).toHaveLength(3);
    expect(restoredState(pi.entries)).toBe(true);
    const enabledResult = await toolCall({ toolName: "bugrun_debug", input: {} }, ctx);
    expect(enabledResult?.block).toBe(true);

    await command.handler("false", ctx);
    expect(restoredState(pi.entries)).toBe(false);

    await command.handler("not-a-boolean", ctx);
    expect(restoredState(pi.entries)).toBe(false);
  });

  it("blocks protected direct paths and host-process tools while enabled", async () => {
    const { pi, ctx } = await startExtension([{ customType: "pi-sandbox-state", data: { enabled: true } }]);
    const toolCall = pi.events.get("tool_call")![0];

    const envResult = await toolCall({ toolName: "read", input: { path: ".env.local" } }, ctx);
    expect(envResult?.block).toBe(true);

    const sourceResult = await toolCall({ toolName: "read", input: { path: "load_dotenv.py" } }, ctx);
    expect(sourceResult).toBeUndefined();
    const exampleResult = await toolCall({ toolName: "read", input: { path: ".env.example" } }, ctx);
    expect(exampleResult).toBeUndefined();

    const hostToolResult = await toolCall({ toolName: "bugrun_debug", input: {} }, ctx);
    expect(hostToolResult?.block).toBe(true);
    expect(hostToolResult?.reason).toContain("/is_sandboxed false");

    const subagentResult = await toolCall({ toolName: "spawn_agent", input: { agent: "reviewer", task: "review" } }, ctx);
    expect(subagentResult?.block).toBe(true);
    expect(subagentResult?.reason).toContain("starts host processes");
  });

  it("rechecks direct reads at execution time after tool preflight", async () => {
    const root = await temporaryRoot("pi-sandbox-race-");
    const target = join(root, ".env.secret");
    const link = join(root, "safe-looking.txt");
    await writeFile(target, "secret");

    const pi = createMockPi();
    piSandbox(pi);
    const ctx = createMockContext({
      cwd: root,
      sessionManager: {
        getEntries: () => [{ customType: "pi-sandbox-state", data: { enabled: true } }],
      },
    });
    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    const preflight = await pi.events.get("tool_call")![0]({ toolName: "read", input: { path: link } }, ctx);
    expect(preflight).toBeUndefined();

    await symlink(target, link);
    await expect(pi.tools.get("read").execute("read-race", { path: link }, undefined, undefined, ctx)).rejects.toThrow(
      "Sandbox blocked access",
    );
  });

  it("resolves symlink escapes before allowing direct file access", async () => {
    const root = await temporaryRoot("pi-sandbox-policy-");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(home, ".ssh", "id_ed25519"), "private");
    await symlink(join(home, ".ssh", "id_ed25519"), join(workspace, "apparently-safe.txt"));

    await expect(protectedPathReason("apparently-safe.txt", workspace, home)).resolves.toBeDefined();
  });
});

describe("Bubblewrap integration", () => {
  it("keeps ordinary development writable while masking dotenv, SSH, and inherited secrets", async () => {
    const root = await temporaryRoot("pi-sandbox-bwrap-");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".ssh"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(home, ".ssh", "id_ed25519"), "SSH_PRIVATE_SECRET");
    await writeFile(join(workspace, ".env"), "DOTENV_SECRET=visible-on-host\n");
    await writeFile(join(workspace, ".env.local"), "DOTENV_LOCAL_SECRET=visible-on-host\n");
    await writeFile(join(workspace, "ordinary.txt"), "ordinary");

    const result = await runSandboxedProcess({
      executable: "/usr/bin/bash",
      args: [
        "-lc",
        `cat ordinary.txt
/usr/bin/python - <<'PY'
import os
from pathlib import Path
assert Path(".env").read_text() == ""
assert Path(".env.local").read_text() == ""
assert not Path.home().joinpath(".ssh", "id_ed25519").exists()
assert "PI_SANDBOX_TEST_SECRET" not in os.environ
Path("generated.txt").write_text("written")
PY`,
      ],
      cwd: workspace,
      home,
      env: { ...process.env, PI_SANDBOX_TEST_SECRET: "INHERITED_SECRET" },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("ordinary");
    expect(result.stdout).not.toContain("DOTENV_SECRET");
    expect(result.stdout).not.toContain("SSH_PRIVATE_SECRET");
    expect(result.stdout).not.toContain("INHERITED_SECRET");
    await expect(readFile(join(workspace, "generated.txt"), "utf8")).resolves.toBe("written");

    await writeFile(join(workspace, ".env.dynamic"), "DYNAMIC_SECRET=visible-on-host\n");
    const repeat = await runSandboxedProcess({
      executable: "/usr/bin/python",
      args: ["-c", 'from pathlib import Path; assert Path(".env.dynamic").read_text() == ""'],
      cwd: workspace,
      home,
    });
    expect(repeat.exitCode, repeat.stderr).toBe(0);
  }, 20_000);

  it("bounds captured output and can stop an output flood", async () => {
    const root = await temporaryRoot("pi-sandbox-output-");
    const bounded = await runSandboxedProcess({
      executable: "/usr/bin/python",
      args: ["-c", 'print("x" * 100_000)'],
      cwd: root,
      home: root,
      captureLimitBytes: 1_024,
    });
    expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(1_024);
    expect(bounded.outputLimitReached).toBe(false);

    const flooded = await runSandboxedProcess({
      executable: "/usr/bin/yes",
      args: [],
      cwd: root,
      home: root,
      captureLimitBytes: 1_024,
      maxOutputBytes: 4_096,
      timeout: 5,
    });
    expect(flooded.outputLimitReached).toBe(true);
    expect(Buffer.byteLength(flooded.stdout)).toBeLessThanOrEqual(1_024);
  }, 20_000);

  it("fails closed when Bubblewrap is unavailable", async () => {
    const root = await temporaryRoot("pi-sandbox-missing-");
    await expect(
      runSandboxedProcess({
        executable: "/usr/bin/true",
        args: [],
        cwd: root,
        home: root,
        bwrapPath: join(root, "missing-bwrap"),
      }),
    ).rejects.toThrow();
  });
});
