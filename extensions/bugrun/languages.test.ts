import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGenericRunnerCommand, parseLanguage, runGenericDebug } from "./languages";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localJsDebugAdapter = resolve(repoRoot, "bin/js-debug-adapter");
const hasJsDebugAdapter =
  existsSync(localJsDebugAdapter) || spawnSync("sh", ["-lc", "command -v js-debug-adapter"], { stdio: "ignore" }).status === 0;

describe("bugrun language adapters", () => {
  it("defaults language to python for compatibility", () => {
    expect(parseLanguage(undefined)).toBe("python");
    expect(parseLanguage("rust")).toBe("rust");
    expect(() => parseLanguage("ruby")).toThrow("Unsupported Bugrun language");
  });

  it("builds Rust cargo test commands", async () => {
    await expect(
      buildGenericRunnerCommand({ language: "rust", cwd: "/repo", test: "cart_discount", testArgs: ["--lib"] }),
    ).resolves.toEqual({
      command: "cargo",
      args: ["test", "--lib", "cart_discount"],
      adapter: "lldb-dap",
      note: "Rust cargo test via lldb-dap/CodeLLDB-compatible DAP",
    });
  });

  it("builds Go Delve DAP commands", async () => {
    const command = await buildGenericRunnerCommand({ language: "go", cwd: "/repo", test: "./cart", testArgs: ["-run", "TestDiscount"] });

    expect(command.command).toBe("dlv");
    expect(command.args).toEqual(["dap", "--listen=127.0.0.1:0"]);
    expect(command.adapter).toBe("dlv");
  });

  it("rejects empty command overrides", async () => {
    await expect(buildGenericRunnerCommand({ language: "ts", cwd: "/repo", test: "ignored", command: "''" })).rejects.toThrow(
      "must include an executable",
    );
  });

  it("builds TypeScript/Node test commands and accepts command overrides", async () => {
    await expect(buildGenericRunnerCommand({ language: "ts", cwd: "/repo", test: "cart.test.ts" })).resolves.toMatchObject({
      command: "js-debug-adapter",
      args: [],
      adapter: "js-debug-adapter",
    });

    await expect(
      buildGenericRunnerCommand({ language: "ts", cwd: "/repo", test: "ignored", command: "pnpm vitest cart.test.ts" }),
    ).resolves.toEqual({
      command: "pnpm",
      args: ["vitest", "cart.test.ts"],
      adapter: "js-debug-adapter",
      note: "User-supplied Bugrun command",
    });
  });

  (hasJsDebugAdapter ? it : it.skip)(
    "captures Vitest TS breakpoints from worker debug sessions",
    async () => {
      const result = await runGenericDebug({
        language: "ts",
        cwd: repoRoot,
        test: "extensions/bugrun/fixtures/ts-vitest/sample.test.ts",
        breakpoints: [{ path: "extensions/bugrun/fixtures/ts-vitest/subject.ts", line: 2 }],
        adapter: existsSync(localJsDebugAdapter) ? localJsDebugAdapter : undefined,
        maxHits: 1,
        timeoutMs: 30_000,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.frame.path).toBe(resolve(repoRoot, "extensions/bugrun/fixtures/ts-vitest/subject.ts"));
      expect(result.hits[0]?.frame.line).toBe(2);
    },
    35_000,
  );

  (hasJsDebugAdapter ? it : it.skip)("does not emit uncaught exceptions when an in-flight TS debug run is aborted", async () => {
    const controller = new AbortController();
    const uncaught: unknown[] = [];
    const handler = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", handler);

    try {
      const run = runGenericDebug(
        {
          language: "ts",
          cwd: repoRoot,
          test: "extensions/bugrun/fixtures/ts-vitest/sample.test.ts",
          breakpoints: [{ path: "extensions/bugrun/fixtures/ts-vitest/subject.ts", line: 2 }],
          adapter: existsSync(localJsDebugAdapter) ? localJsDebugAdapter : undefined,
          maxHits: 1,
          timeoutMs: 30_000,
        },
        controller.signal,
      ).catch((error: unknown) => error);

      setTimeout(() => controller.abort(), 25);
      await run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", handler);
    }

    expect(uncaught).toEqual([]);
  });
});
