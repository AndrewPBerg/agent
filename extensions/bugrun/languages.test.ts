import { describe, expect, it } from "vitest";
import { buildGenericRunnerCommand, parseLanguage } from "./languages";

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
});
