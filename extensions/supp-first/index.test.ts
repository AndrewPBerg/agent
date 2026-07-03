import { describe, expect, it } from "vitest";
import { createMockPi } from "../test/mocks/pi-coding-agent";
import suppFirst from "./index";

describe("supp-first", () => {
  it("blocks unbounded supp tree JSON", async () => {
    const pi = createMockPi();
    suppFirst(pi);

    const result = await pi.events.get("tool_call")![0]({
      toolName: "bash",
      input: { command: "supp -n tree --json" },
    });

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("unbounded `supp tree --json`");
  });

  it("allows bypassed commands", async () => {
    const pi = createMockPi();
    suppFirst(pi);

    const result = await pi.events.get("tool_call")![0]({
      toolName: "bash",
      input: { command: "SUPP_OK=1 supp tree --json" },
    });

    expect(result).toBeUndefined();
  });
});
