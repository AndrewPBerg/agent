import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync }));

import { copySessionText } from "./clipboard";

beforeEach(() => {
  spawnSync.mockReset();
});

describe("session text clipboard", () => {
  it("passes exact text to the first available clipboard helper", async () => {
    spawnSync.mockReturnValue({ status: 0 });

    await copySessionText("printf '\t%s' \"hello\"\n😀");

    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ input: "printf '\t%s' \"hello\"\n😀", timeout: 5_000 }),
    );
  });

  it("falls back to OSC 52 for bounded payloads", async () => {
    spawnSync.mockReturnValue({ status: 1 });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await copySessionText("line\n😀");
      const sequence = String(write.mock.calls[0]?.[0]);
      expect(sequence.startsWith("\u001b]52;c;")).toBe(true);
      expect(sequence.endsWith("\u0007")).toBe(true);
      expect(Buffer.from(sequence.slice(7, -1), "base64").toString()).toBe("line\n😀");
    } finally {
      write.mockRestore();
    }
  });

  it("rejects oversized OSC 52 payloads when no helper works", async () => {
    spawnSync.mockReturnValue({ status: 1 });

    await expect(copySessionText("x".repeat(80_000))).rejects.toThrow("No clipboard helper available");
  });
});
