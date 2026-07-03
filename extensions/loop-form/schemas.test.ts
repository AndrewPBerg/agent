import { describe, expect, it } from "vitest";
import { defaultConfig, parseActiveLoop, parseLoopConfig } from "./schemas";

describe("loop-form schemas", () => {
  it("normalizes loop config defaults and iteration bounds", () => {
    expect(
      parseLoopConfig({
        objective: "ship it",
        mode: "test-fix",
        maxIterations: "999",
        autonomy: "full-auto",
      }),
    ).toEqual({
      ...defaultConfig,
      objective: "ship it",
      mode: "test-fix",
      maxIterations: 25,
      autonomy: "full-auto",
    });
  });

  it("rejects invalid persisted loop state", () => {
    expect(parseActiveLoop({ version: 2, status: "wat" })).toBeUndefined();
  });
});
