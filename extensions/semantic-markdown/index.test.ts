import { Markdown } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import semanticMarkdownExtension from "./index";

const theme = new Proxy({}, { get: () => (text: string) => text });

function render(text: string): string[] {
  return new Markdown(text, 0, 0, theme).render(80).map((line) => line.trimEnd());
}

describe("semantic markdown presentation", () => {
  const pi = createMockPi();

  beforeAll(() => {
    semanticMarkdownExtension(pi as never);
  });

  it("patches built-in Markdown instances with semantic rendering", () => {
    expect(render("# Heading\n\n![diagram](https://example.com/a.png)")).toEqual([
      "Heading",
      "",
      "Image: diagram (https://example.com/a.png)",
    ]);
  });

  it("renders details and MDX-like wrappers without dropping malformed tags", () => {
    expect(render("<details><summary>More</summary>Body **text**</details>")).toEqual(["▾ More", "  Body text"]);
    expect(render("<Callout>Custom **content**</Callout>")).toEqual(["Custom content"]);
    expect(render("<A><B>crossed</A></B>")).toEqual(["<A><B>crossed</A></B>"]);
  });

  it("registers a branch-persistent source/semantic command", async () => {
    const command = pi.commands.get("presentation");
    const ctx = createMockContext({
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
        theme: { fg: (_name: string, text: string) => text },
      },
    });

    await command.handler("source", ctx);
    expect(pi.entries.at(-1)).toEqual({
      customType: "pi.markdown-presentation",
      data: { version: 1, presentation: "source" },
    });
    expect(render("### Heading")[0]).toContain("### Heading");

    await command.handler("semantic", ctx);
    expect(render("### Heading")).toEqual(["  Heading"]);
  });
});
