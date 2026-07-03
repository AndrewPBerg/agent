import { describe, expect, it } from "vitest";
import { parseOrchestratedRun, parseReviewGate } from "./schemas";

describe("orchestrator-run schemas", () => {
  it("accepts valid review gate details", () => {
    expect(
      parseReviewGate({
        verdict: "pass",
        scopeMatch: "yes",
        repoDirectionMatch: "unclear",
        verificationQuality: "strong",
        summary: "Looks good",
        blockers: [],
        requiredFixes: [],
        createdAt: "2026-07-03T00:00:00.000Z",
      })?.verdict,
    ).toBe("pass");
  });

  it("rejects invalid run status instead of trusting JSON casts", () => {
    expect(parseOrchestratedRun({ id: "run", status: "surprise" })).toBeUndefined();
  });
});
