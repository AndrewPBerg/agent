import { describe, expect, it } from "vitest";
import { addOne } from "./subject";

describe("ts-vitest fixture", () => {
  it("executes code under test", () => {
    expect(addOne(1)).toBe(2);
  });
});
