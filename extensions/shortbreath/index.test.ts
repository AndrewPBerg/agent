import { describe, expect, it } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import shortbreath from "./index";

describe("shortbreath", () => {
  it("appends concise instructions when enabled", () => {
    const pi = createMockPi();
    shortbreath(pi);

    const beforeAgentStart = pi.events.get("before_agent_start")?.[0];
    expect(beforeAgentStart).toBeDefined();

    const result = beforeAgentStart!({ systemPrompt: "base" });
    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("SHORTBREATH MODE");
  });

  it("toggles off and persists state", async () => {
    const pi = createMockPi();
    shortbreath(pi);
    const ctx = createMockContext();

    await pi.commands.get("shortbreath").handler("off", ctx);

    expect(pi.entries).toEqual([{ customType: "shortbreath", data: { state: "off" } }]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("shortbreath off", "info");

    const beforeAgentStart = pi.events.get("before_agent_start")?.[0];
    expect(beforeAgentStart!({ systemPrompt: "base" })).toBeUndefined();
  });
});
