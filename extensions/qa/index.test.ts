import { describe, expect, it, vi } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import qa, { buildBrowserQaPrompt, buildQaPrompt } from "./index";

describe("qa extension", () => {
  it("registers the qa command", () => {
    const pi = createMockPi();
    qa(pi);

    expect(pi.commands.has("qa")).toBe(true);
  });

  it("queues a QA prompt for the current diff", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    qa(pi);

    await pi.commands.get("qa").handler("");

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("QA YOUR worked-on diff"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("staged, unstaged, and untracked changes"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("edge cases"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Tech debt pass"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("debt introduced or worsened"));
  });

  it("includes optional focus text", () => {
    const prompt = buildQaPrompt("focus the auth retry path");

    expect(prompt).toContain("Focus requested by user");
    expect(prompt).toContain("focus the auth retry path");
  });

  it("registers the browser QA command and tool", () => {
    const pi = createMockPi();
    qa(pi);

    expect(pi.commands.has("browser-qa")).toBe(true);
    expect(pi.tools.has("browser_qa_run")).toBe(true);
  });

  it("queues a browser QA prompt that delegates mechanics to VoidCrawl and Yosoi", async () => {
    const pi = createMockPi();
    pi.sendUserMessage = vi.fn();
    qa(pi);

    await pi.commands.get("browser-qa").handler("https://app.local/settings verify save button stays disabled");

    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Launch a selector-backed browser QA run"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("/browser-qa https://app.local/settings"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("browser_qa_run"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("VoidCrawl/Yosoi A3"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Do not install, import, scaffold, or run Playwright"));
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining(".yosoi/browser-qa/app-local-settings"));
  });

  it("builds browser QA prompt with read-only safety gates", () => {
    const prompt = buildBrowserQaPrompt("http://localhost:5173/login check keyboard selectors");

    expect(prompt).toContain("Default to read-only navigation");
    expect(prompt).toContain("Do not submit forms");
    expect(prompt).toContain("BROWSER_QA_APPROVED=1");
    expect(prompt).toContain("Never include credentials");
  });

  it("accepts a safe browser QA tool handoff", async () => {
    const pi = createMockPi();
    qa(pi);

    const result = await pi.tools.get("browser_qa_run").execute("browser-qa-1", {
      targetUrl: "https://app.local/settings",
      scenario: "settings page selector smoke",
      selectors: ["role=button[name='Save']", "[data-testid='settings-form']"],
      allowedActions: ["navigate", "inspect", "screenshot"],
      blockedActions: ["submit", "save", "delete"],
      evidencePath: ".yosoi/browser-qa/app-local-settings",
    });

    expect(result.content[0].text).toContain("Browser QA handoff accepted");
    expect(result.content[0].text).toContain("Use VoidCrawl/Yosoi A3");
    expect(result.details.selectors).toContain("[data-testid='settings-form']");
  });

  it("rejects sensitive browser QA tool handoffs without explicit approval", async () => {
    const pi = createMockPi();
    qa(pi);

    await expect(
      pi.tools.get("browser_qa_run").execute("browser-qa-1", {
        targetUrl: "https://app.local/settings",
        scenario: "settings save path",
        selectors: ["role=button[name='Save']"],
        allowedActions: ["navigate", "save settings"],
        blockedActions: ["delete"],
        evidencePath: ".yosoi/browser-qa/app-local-settings",
      }),
    ).rejects.toThrow("Sensitive browser QA actions require explicit BROWSER_QA_APPROVED=1");
  });

  it("blocks Playwright browser QA commands", async () => {
    const pi = createMockPi();
    qa(pi);

    const result = await pi.events.get("tool_call")![0]({
      toolName: "bash",
      input: { command: "pnpm add -D @playwright/test && npx playwright test" },
    });

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("VoidCrawl/Yosoi A3");
  });

  it("blocks sensitive Yosoi browser QA shell actions without approval", async () => {
    const pi = createMockPi();
    qa(pi);

    const result = await pi.events.get("tool_call")![0]({
      toolName: "bash",
      input: { command: "uvx yosoi a3 browser-qa https://app.local/settings --selector '#save' --action submit" },
    });

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("BROWSER_QA_APPROVED=1");
  });
});
