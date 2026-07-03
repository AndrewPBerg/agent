import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import bugrun from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const cartPath = join(here, "fixtures", "python-shop", "src", "shop", "cart.py");
describe("bugrun extension", () => {
  it("registers the bugrun command, tool, and policy hook", () => {
    const pi = createMockPi();
    bugrun(pi);

    expect(pi.tools.has("bugrun_debug")).toBe(true);
    expect(pi.commands.has("bugrun")).toBe(true);
    expect(pi.events.get("before_agent_start")?.length).toBe(1);
  });

  it("queues the fixture debugging prompt", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    bugrun(pi);

    await pi.commands.get("bugrun").handler("fixture", createMockContext());

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("bugrun_debug"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("tests/test_cart.py::test_discount_total"));
  });

  it("treats natural language requests as exploratory debugging prompts", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    bugrun(pi);
    const ctx = createMockContext({ cwd: "/repo" });

    await pi.commands.get("bugrun").handler("native.py in relation to pydantic Graph", ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("runtime code-flow microscope"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Mode: explore"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("native.py in relation to pydantic Graph"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("DAP breakpoints/stack/locals"));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("bugrun", "bugrun:explore");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("bugrun-panel", expect.any(Function), { placement: "belowEditor" });
  });

  it("supports explicit pointed bugrun intent modes", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    bugrun(pi);
    const ctx = createMockContext({ cwd: "/repo" });

    await pi.commands.get("bugrun").handler("harden fbv2 runtime abstraction boundaries", ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Mode: harden"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("fbv2 runtime abstraction boundaries"));
    expect(pi.sendUserMessage).not.toHaveBeenCalledWith(expect.stringContaining("harden fbv2 runtime"));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("bugrun", "bugrun:harden");
  });

  it("asks for a target instead of queuing a prompt for a bare intent", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    bugrun(pi);
    const ctx = createMockContext({ cwd: "/repo" });

    await pi.commands.get("bugrun").handler("harden", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /bugrun harden <question-or-pytest-target>", "info");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("treats a lone production file as exploratory, not a pytest target", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    bugrun(pi);

    await pi.commands.get("bugrun").handler("native.py", createMockContext({ cwd: "/repo" }));

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("runtime code-flow microscope"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("native.py"));
  });

  it("clears Bugrun UI without queueing an agent prompt", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    bugrun(pi);
    const ctx = createMockContext();

    await pi.commands.get("bugrun").handler("clear", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("bugrun", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("bugrun-panel", undefined);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Bugrun cleared.", "info");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("exposes multi-language bugrun_debug parameters", () => {
    const pi = createMockPi();
    bugrun(pi);

    const schema = JSON.stringify(pi.tools.get("bugrun_debug").parameters);

    expect(schema).toContain("language");
    expect(schema).toContain("rust");
    expect(schema).toContain("go");
    expect(schema).toContain("ts");
    expect(schema).toContain("command");
    expect(schema).toContain("testArgs");
  });

  it("validates non-Python breakpoints before adapter checks", async () => {
    const pi = createMockPi();
    bugrun(pi);

    await expect(
      pi.tools
        .get("bugrun_debug")
        .execute("tool", { language: "rust", test: "cart_discount" }, new AbortController().signal, undefined, createMockContext()),
    ).rejects.toThrow("requires at least one breakpoint");
  });

  it("surfaces clear in help and completions", async () => {
    const pi = createMockPi();
    bugrun(pi);
    const command = pi.commands.get("bugrun");
    const ctx = createMockContext();

    expect(command.getArgumentCompletions("cl")).toEqual([{ value: "clear", label: "clear" }]);
    expect(command.getArgumentCompletions("ha")).toEqual([{ value: "harden", label: "harden" }]);

    await command.handler("help", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/bugrun clear"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("--language rust"), "info");
  });

  it("renders a source-centered trace panel without using tool content", () => {
    const pi = createMockPi();
    bugrun(pi);

    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const component = pi.tools.get("bugrun_debug").renderResult(
      {
        content: [{ type: "text", text: "compact agent summary only" }],
        details: {
          result: {
            cwd: join(here, "fixtures", "python-shop"),
            test: "tests/test_cart.py::test_discount_total",
            command: "python3",
            args: [],
            breakpoints: [{ path: cartPath, line: 9 }],
            hits: [
              {
                reason: "breakpoint",
                threadId: 1,
                frame: { id: 1, name: "price_after_discount", path: cartPath, line: 9 },
                stack: [
                  { id: 1, name: "price_after_discount", path: cartPath, line: 9 },
                  { id: 2, name: "test_discount_total", path: join(here, "fixtures", "python-shop", "tests", "test_cart.py"), line: 4 },
                ],
                locals: [{ name: "total", value: "20.0", type: "float" }],
              },
            ],
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 12,
          },
        },
      },
      {},
      theme,
    );

    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Bugrun Trace");
    expect(rendered).toContain("price_after_discount");
    expect(rendered).toContain("▶");
    expect(rendered).toContain("return total");
    expect(rendered).toContain("total = 20.0");
    expect(rendered).not.toContain("compact agent summary only");
  });

  it("adds concise bugrun policy to the system prompt", () => {
    const pi = createMockPi();
    bugrun(pi);

    const hook = pi.events.get("before_agent_start")?.[0];
    const result = hook!({ systemPrompt: "base" });

    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("automatic runtime-flow toolbelt option");
    expect(result.systemPrompt).toContain("runtime DAP evidence");
    expect(result.systemPrompt).toContain("Rust, Go, or TypeScript");
    expect(result.systemPrompt).toContain("how one file/module connects to another");
    expect(result.systemPrompt).toContain("solve (bug fix), explore (mental model), harden (abstraction QA), or lab");
  });
});
