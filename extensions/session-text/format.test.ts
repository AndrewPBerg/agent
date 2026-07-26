import { describe, expect, it } from "vitest";
import {
  estimateSessionEntriesClipboardBytes,
  sessionEntriesClipboardText,
  sessionEntriesDocumentChunks,
  sessionEntriesDocumentText,
  sessionEntryClipboardText,
} from "./format";

function entry(value: Record<string, unknown>): any {
  return {
    id: "entry-1",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    ...value,
  };
}

function message(value: Record<string, unknown>): any {
  return entry({ type: "message", message: value });
}

describe("session text formatting", () => {
  it("preserves source whitespace while excluding thinking and images", () => {
    const value = message({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "printf '\t%s' \"hello\"\n\n" },
        { type: "image", mimeType: "image/png", data: "base64-secret" },
        { type: "text", text: "cat <<'EOF'\nαβ\nEOF\n" },
      ],
    });

    expect(sessionEntryClipboardText(value)).toBe("printf '\t%s' \"hello\"\n\ncat <<'EOF'\nαβ\nEOF\n");
  });

  it("does not invent whitespace between stored text blocks", () => {
    const value = message({
      role: "assistant",
      content: [
        { type: "text", text: "printf 'left" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: " right'" },
      ],
    });

    expect(sessionEntryClipboardText(value)).toBe("printf 'left right'");
  });

  it("copies bash commands without prose or output", () => {
    const toolCall = message({
      role: "assistant",
      content: [
        { type: "text", text: "I will run it." },
        {
          type: "toolCall",
          id: "tool-1",
          name: "bash",
          arguments: { command: "cat <<'EOF'\n$HOME\nEOF\n", timeout: 30 },
        },
      ],
    });
    const execution = message({
      role: "bashExecution",
      command: "printf '%s\\n' \"$PATH\"",
      output: "not copied",
    });

    expect(sessionEntryClipboardText(toolCall)).toBe("cat <<'EOF'\n$HOME\nEOF\n");
    expect(sessionEntryClipboardText(execution)).toBe("printf '%s\\n' \"$PATH\"");
  });

  it("unwraps only a sole complete fenced block", () => {
    const fenced = message({
      role: "assistant",
      content: [{ type: "text", text: "\n```bash\nprintf 'ok'\n\n```\n" }],
    });
    const mixed = message({
      role: "assistant",
      content: [{ type: "text", text: "Run this:\n\n```bash\nprintf 'ok'\n```\n" }],
    });

    expect(sessionEntryClipboardText(fenced)).toBe("printf 'ok'\n\n");
    expect(sessionEntryClipboardText(mixed)).toBe("Run this:\n\n```bash\nprintf 'ok'\n```\n");
  });

  it("leaves malformed fences unchanged", () => {
    const value = message({
      role: "assistant",
      content: [{ type: "text", text: "```bash\necho open\n" }],
    });
    expect(sessionEntryClipboardText(value)).toBe("```bash\necho open\n");
  });

  it("removes terminal controls from source, output, and readable documents", () => {
    const output = message({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "\u001b[31mred\u001b[0m\n\u001b]0;title\u0007\tindent\n" }],
    });
    const source = message({
      role: "assistant",
      content: [{ type: "text", text: "\u001b]52;c;payload\u0007printf 'safe'\n" }],
    });

    expect(sessionEntryClipboardText(output)).toBe("red\n\tindent\n");
    expect(sessionEntryClipboardText(source)).toBe("printf 'safe'\n");
    expect(sessionEntriesDocumentText([source])).not.toContain("\u001b");
    expect(sessionEntriesDocumentText([source], "raw")).not.toContain("\u001b");
  });

  it("joins selections with only required boundary newlines and estimates UTF-8 bytes", () => {
    const values = [
      message({ role: "user", content: "first" }),
      message({ role: "user", content: "second\n" }),
      entry({ type: "custom", customType: "hidden", data: { secret: true } }),
      message({ role: "user", content: "\nthird" }),
    ];
    const text = "first\nsecond\n\nthird";

    expect(sessionEntriesClipboardText(values)).toBe(text);
    expect(estimateSessionEntriesClipboardBytes(values)).toBeGreaterThanOrEqual(Buffer.byteLength(text));
  });

  it("keeps raw JSON explicit and readable documents clean", () => {
    const value = entry({
      type: "custom",
      customType: "diagnostic",
      data: { enabled: true, text: "line\n😀\ud800", omitted: undefined, values: [undefined, Number.NaN] },
    });
    const second = entry({ id: "entry-2", type: "label", label: "release" });
    const readable = sessionEntriesDocumentText([value]);
    const singleRaw = sessionEntriesDocumentText([value], "raw");
    const multipleRaw = sessionEntriesDocumentText([value, second], "raw");

    expect(readable).toContain("Use raw view to inspect extension state.");
    expect(readable).not.toContain('"enabled"');
    expect(singleRaw).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(multipleRaw).toBe(`${JSON.stringify([value, second], null, 2)}\n`);
    expect(JSON.parse(singleRaw)).toEqual(JSON.parse(JSON.stringify(value)));
    expect(JSON.parse(multipleRaw)).toEqual(JSON.parse(JSON.stringify([value, second])));
  });

  it("streams large raw JSON without producing a full-size chunk", () => {
    const value = entry({ type: "custom", customType: "large", data: { text: `${'a\\"\n'.repeat(300_000)}😀` } });
    const chunks = [...sessionEntriesDocumentChunks([value], "raw")];

    expect(chunks.join("")).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
  });

  it("chunks large Unicode documents without corrupting surrogate pairs", () => {
    const text = `${"a".repeat(64 * 1024 - 1)}😀tail`;
    const value = message({ role: "user", content: text });
    const chunks = [...sessionEntriesDocumentChunks([value])];

    expect(chunks.join("")).toBe(sessionEntriesDocumentText([value]));
    expect(chunks.join("")).not.toContain("�");
  });
});
