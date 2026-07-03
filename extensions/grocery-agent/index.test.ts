import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import extension from "./index";

function setup() {
  const pi = createMockPi();
  extension(pi as any);
  return pi;
}

describe("grocery-agent extension", () => {
  it("registers /grocery and grocery_plan", () => {
    const pi = setup();

    expect(pi.commands.has("grocery")).toBe(true);
    expect(pi.tools.has("grocery_plan")).toBe(true);
  });

  it("/grocery plan starts a background agent request without changing the text input", async () => {
    const pi = setup();
    const sendUserMessage = vi.spyOn(pi, "sendUserMessage");
    const ctx = createMockContext({ cwd: "/tmp/project" });

    await pi.commands.get("grocery").handler("plan Korean honey BBQ meal prep", ctx);

    expect(sendUserMessage).toHaveBeenCalledWith("Use Grocery Agent for plan. Seed/request: Korean honey BBQ meal prep");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("keeps Grocery Agent vertically agnostic while allowing discovery capabilities", async () => {
    const pi = setup();
    const ctx = createMockContext();

    const prompt = await pi.tools
      .get("grocery_plan")
      .execute("tool-1", { request: "banana oatmeal muffins and egg bake", mode: "plan" }, undefined, undefined, ctx);

    const text = prompt.content[0].text;
    expect(text).toContain("available discovery/research capabilities");
    expect(text).not.toContain("Use Yosoi");
    expect(text).not.toContain("uvx yosoi");
  });

  it("grocery_plan tool returns the happy-path meal-prep guidance", async () => {
    const pi = setup();
    const ctx = createMockContext({ cwd: "/tmp/project" });

    const result = await pi.tools.get("grocery_plan").execute(
      "tool-1",
      {
        request: "I need meal prep for the week: Korean honey BBQ, banana oatmeal muffins, egg bake, and cottage cheese pasta with spinach",
      },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("Korean honey BBQ");
    expect(text).toContain("banana oatmeal muffins");
    expect(text).toContain("cottage cheese pasta with spinach");
    expect(text).toContain("Spices / Condiments");
    expect(text).toContain('Build a small "knowns / unknowns" planning model');
    expect(text).toContain("Ask only derived questions. Do not use a fixed questionnaire.");
    expect(text).toContain("Question memory:");
    expect(text).not.toContain("Does this lineup sound right?");
    expect(result.details.workspace).toBe("/tmp/project/grocery-agent");
  });
});
