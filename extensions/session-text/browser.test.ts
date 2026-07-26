import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  flattenSessionTreeRows,
  openSessionTextBrowser,
  sessionEntryKind,
  sessionEntryPreview,
  sessionEntrySearchText,
  VimSessionTreeComponent,
  type VimSessionTreeRow,
} from "./browser";

function row(id: string, value: Record<string, unknown>): VimSessionTreeRow {
  return {
    id,
    entry: { id, parentId: null, timestamp: new Date(0).toISOString(), ...value } as never,
    depth: 0,
    isActiveBranch: false,
    isLeaf: false,
    summary: `row ${id}`,
  };
}

function messageRow(id: string, message: Record<string, unknown>): VimSessionTreeRow {
  return row(id, { type: "message", message });
}

function rows(count: number): VimSessionTreeRow[] {
  return Array.from({ length: count }, (_, index) => messageRow(`entry-${index}`, { role: "user", content: `row ${index}` }));
}

function treeNode(id: string, children: unknown[] = []) {
  return {
    entry: {
      type: "custom",
      id,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: "test",
    },
    children,
  } as never;
}

function createComponent(
  done: ConstructorParameters<typeof VimSessionTreeComponent>[3] = () => {},
  componentRows = rows(4),
  copyText?: ConstructorParameters<typeof VimSessionTreeComponent>[5],
  clipboardWarningBytes?: ConstructorParameters<typeof VimSessionTreeComponent>[6],
) {
  const tui = { terminal: { rows: 30 }, requestRender: vi.fn() } as never;
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as never;
  return new VimSessionTreeComponent(tui, theme, componentRows, done, undefined, copyText, clipboardWarningBytes);
}

describe("session text browser", () => {
  it("keeps linear turns flat and indents actual branch fan-out", () => {
    const roots = [treeNode("a", [treeNode("b", [treeNode("d")]), treeNode("c")])];
    const flattened = flattenSessionTreeRows(roots, new Set(), "d");

    expect(flattened.map((item) => [item.id, item.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["d", 2],
      ["c", 1],
    ]);
  });

  it("does not emit stored terminal controls while rendering rows", () => {
    const unsafe = messageRow("unsafe-\u001b[31mid", { role: "user", content: "\u001b]52;c;payload\u0007safe text" });
    unsafe.summary = "user: \u001b]52;c;payload\u0007safe text";
    const component = createComponent(() => {}, [unsafe]);
    const rendered = component.render(120).join("\n");

    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("safe text");
  });

  it("distinguishes executable bash rows from command output", () => {
    const command = messageRow("command", {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-bash", name: "bash", arguments: { command: "pwd" } }],
    }).entry;
    const output = messageRow("output", {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "/tmp" }],
    }).entry;

    expect(sessionEntryKind(command).label).toBe("BASH");
    expect(sessionEntryKind(output).label).toBe("OUT");
  });

  it("leaves search mode on escape", () => {
    const actions: unknown[] = [];
    const component = createComponent((action) => actions.push(action));

    component.handleInput("/");
    component.handleInput("r");
    component.handleInput("\u001b");
    component.handleInput("q");

    expect(actions).toEqual([{ kind: "cancel" }]);
    expect(component.getSearchQuery()).toBe("r");
  });

  it("treats regex metacharacters literally instead of running unsafe patterns", () => {
    const longValue = messageRow("long", { role: "user", content: `${"a".repeat(10_000)}!` }).entry;
    const literalValue = messageRow("literal", { role: "user", content: "contains (a+)+$ safely" }).entry;

    expect(sessionEntryPreview(longValue, "(a+)+$")).toBeUndefined();
    expect(sessionEntryPreview(literalValue, "(a+)+$")).toContain("(a+)+$");
  });

  it("searches hidden tool arguments and returns source previews", () => {
    const value = messageRow("assistant-read", {
      role: "assistant",
      content: [
        { type: "text", text: "checking file" },
        { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/target.ts" } },
      ],
    }).entry;

    expect(sessionEntrySearchText(value)).toContain("src/target.ts");
    expect(sessionEntryPreview(value, "target")).toContain("target.ts");
  });

  it("yanks selected canonical text instead of diagnostic JSON", async () => {
    const copied: string[] = [];
    const component = createComponent(
      () => {},
      rows(4),
      async (text) => {
        copied.push(text);
      },
    );

    component.handleInput("v");
    component.handleInput("2");
    component.handleInput("j");
    component.handleInput("y");
    await vi.waitFor(() => expect(copied).toHaveLength(1));

    expect(copied).toEqual(["row 0\nrow 1\nrow 2"]);
    expect(component.render(120).join("\n")).toContain("3 entries yanked");
  });

  it("closes the overlay before requesting confirmation for oversized copies", async () => {
    const actions: unknown[] = [];
    const copyText = vi.fn(async () => {});
    const component = createComponent(
      (action) => actions.push(action),
      [messageRow("large", { role: "user", content: "larger than limit" })],
      copyText,
      4,
    );

    component.handleInput("v");
    component.handleInput("y");
    await vi.waitFor(() => expect(actions).toHaveLength(1));

    expect(copyText).not.toHaveBeenCalled();
    expect(actions).toEqual([expect.objectContaining({ kind: "confirmLargeCopy", entryIds: ["large"], estimatedBytes: 17 })]);
  });

  it("asks for large-copy confirmation only after the browser overlay closes", async () => {
    const events: string[] = [];
    const value = messageRow("large", { role: "user", content: "payload" }).entry;
    let customCalls = 0;
    const custom = vi.fn(async () => {
      customCalls += 1;
      events.push(`custom-${customCalls}`);
      if (customCalls > 1) return { kind: "cancel" };
      return {
        kind: "confirmLargeCopy",
        entryIds: ["large"],
        estimatedBytes: 33 * 1024 * 1024,
        state: {
          filter: { showFiles: false, showBash: false, showAll: false },
          selectedId: "large",
          mode: "visual",
          searchQuery: "",
          scrollOffset: 0,
        },
      };
    });
    const confirm = vi.fn(async () => {
      events.push("confirm");
      return false;
    });

    await openSessionTextBrowser({
      mode: "tui",
      hasUI: true,
      sessionManager: {
        getBranch: () => [value],
        getTree: () => [{ entry: value, children: [] }],
        getLeafId: () => "large",
        getEntry: () => value,
      },
      ui: { custom, confirm, notify: vi.fn() },
    } as never);

    expect(events).toEqual(["custom-1", "confirm", "custom-2"]);
  });

  it("writes a read-only raw document and removes it after the editor exits", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "session-text-browser-test-"));
    const editor = join(sandbox, "capture-editor");
    const capture = join(sandbox, "capture.json");
    writeFileSync(
      editor,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[2];
fs.writeFileSync(process.env.SESSION_TEXT_CAPTURE, JSON.stringify({
  path,
  mode: fs.statSync(path).mode & 0o777,
  content: fs.readFileSync(path, "utf8"),
}));
`,
    );
    chmodSync(editor, 0o755);

    const previousEditor = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    const previousCapture = process.env.SESSION_TEXT_CAPTURE;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.EDITOR = editor;
    delete process.env.VISUAL;
    process.env.SESSION_TEXT_CAPTURE = capture;

    try {
      const value = messageRow("raw-entry", { role: "user", content: "exact source" }).entry;
      const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
      let customCalls = 0;
      await openSessionTextBrowser({
        mode: "tui",
        hasUI: true,
        sessionManager: {
          getBranch: () => [value],
          getTree: () => [{ entry: value, children: [] }],
          getLeafId: () => "raw-entry",
          getEntry: () => value,
        },
        ui: {
          notify: vi.fn(),
          confirm: vi.fn(),
          custom: async () => {
            customCalls += 1;
            return customCalls === 1
              ? {
                  kind: "openExternal",
                  entryIds: ["raw-entry"],
                  mode: "raw",
                  tui,
                  state: {
                    filter: { showFiles: false, showBash: false, showAll: false },
                    selectedId: "raw-entry",
                    mode: "normal",
                    searchQuery: "",
                    scrollOffset: 0,
                  },
                }
              : { kind: "cancel" };
          },
        },
      } as never);

      const result = JSON.parse(readFileSync(capture, "utf8"));
      expect(result.path).toMatch(/\.json$/);
      expect(result.mode).toBe(0o444);
      expect(JSON.parse(result.content)).toEqual(value);
      expect(existsSync(result.path)).toBe(false);
      expect(tui.stop).toHaveBeenCalledOnce();
      expect(tui.start).toHaveBeenCalledOnce();
    } finally {
      stdout.mockRestore();
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
      if (previousCapture === undefined) delete process.env.SESSION_TEXT_CAPTURE;
      else process.env.SESSION_TEXT_CAPTURE = previousCapture;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects terminal components outside TUI mode", async () => {
    const notify = vi.fn();
    const custom = vi.fn();
    await openSessionTextBrowser({ mode: "rpc", hasUI: true, ui: { notify, custom } } as never);

    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Session text browser is only available in TUI mode", "warning");
  });

  it("opens readable documents by default and raw JSON explicitly", () => {
    const actions: any[] = [];
    const readable = createComponent((action) => actions.push(action));
    readable.handleInput("\r");

    const raw = createComponent((action) => actions.push(action));
    raw.handleInput("V");
    raw.handleInput("j");
    raw.handleInput("R");

    expect(actions).toEqual([
      expect.objectContaining({ kind: "openExternal", mode: "readable", entryIds: ["entry-0"] }),
      expect.objectContaining({ kind: "openExternal", mode: "raw", entryIds: ["entry-0", "entry-1"] }),
    ]);
  });
});
