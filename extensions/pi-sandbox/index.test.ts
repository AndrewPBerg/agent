import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import piSandbox, { restoredState } from "./index";
import { protectedPathReason } from "./policy";
import { runSandboxedProcess } from "./runner";

async function startExtension(entries: any[] = []) {
  const pi = createMockPi();
  piSandbox(pi);
  const ctx = createMockContext({ sessionManager: { getEntries: () => entries } });
  await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
  return { pi, ctx };
}

describe("pi-sandbox state and policy", () => {
  it("defaults to enabled and persists an explicit per-session toggle", async () => {
    const { pi, ctx } = await startExtension();
    const command = pi.commands.get("is_sandboxed");

    await command.handler("false", ctx);
    expect(pi.entries).toEqual([{ customType: "pi-sandbox-state", data: { enabled: false } }]);
    expect(restoredState(pi.entries)).toBe(false);
    expect(restoredState([])).toBe(true);

    const hostToolResult = await pi.events.get("tool_call")![0]({ toolName: "bugrun_debug", input: {} }, ctx);
    expect(hostToolResult).toBeUndefined();
  });

  it("blocks protected direct paths and host-process tools while enabled", async () => {
    const { pi, ctx } = await startExtension();
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
  });

  it("resolves symlink escapes before allowing direct file access", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
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
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-bwrap-"));
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
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-output-"));
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
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-missing-"));
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
