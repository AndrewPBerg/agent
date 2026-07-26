import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { copySessionText } from "./clipboard";
import {
  estimateSessionEntriesClipboardBytes,
  SESSION_CLIPBOARD_WARNING_BYTES,
  type SessionDocumentMode,
  sessionEntriesClipboardText,
  sessionEntriesDocumentChunks,
} from "./format";

const TREE_COMMAND_MODE = "NORMAL";
const TREE_VERTICAL_CHROME_ROWS = 4;
const TREE_OVERLAY_MARGIN_ROWS = 2;
const FALLBACK_VISIBLE_ROWS = 30;
const TREE_SEARCH_QUERY_MAX_LENGTH = 256;
const TREE_SEARCH_SUBJECT_MAX_LENGTH = 50_000;
const FILE_TOOL_NAMES = new Set(["create", "read", "update", "write", "edit"]);

export type VimSessionTreeRow = {
  id: string;
  entry: SessionEntry;
  depth: number;
  label?: string;
  isActiveBranch: boolean;
  isLeaf: boolean;
  summary: string;
};

type VimSessionTreeNode = {
  entry: SessionEntry;
  children: VimSessionTreeNode[];
  label?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanTerminalText(text: string): string {
  return stripVTControlCharacters(text);
}

function firstLine(text: string): string {
  return cleanTerminalText(text).replace(/\s+/g, " ").trim();
}

function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (isRecord(part) && part.type === "toolCall" && typeof part.name === "string" ? [part.name] : []));
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return firstLine(content).length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && firstLine(part.text).length > 0);
}

function stringifyTextContent(content: unknown, options: { compact?: boolean } = {}): string {
  const compact = options.compact ?? true;
  if (typeof content === "string") return compact ? firstLine(content) : content;
  if (!Array.isArray(content)) return "";

  const text = content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "thinking" && typeof part.thinking === "string") return compact ? "[thinking]" : part.thinking;
      if (part.type === "thinking") return "[thinking]";
      if (part.type === "image") return "[image]";
      if (part.type === "toolCall" && typeof part.name === "string") {
        const args = isRecord(part.arguments) ? JSON.stringify(part.arguments) : "";
        return `[tool:${part.name}]${args ? ` ${args}` : ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join(compact ? " " : "\n");
  return compact ? firstLine(text) : text;
}

function compactSearchText(text: string): string {
  return cleanTerminalText(text).replace(/\s+/g, " ").trim();
}

export function sessionEntrySearchText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message as {
        role?: string;
        content?: unknown;
        command?: string;
        output?: string;
        toolName?: string;
        provider?: string;
        model?: string;
        errorMessage?: string;
      };
      return compactSearchText(
        [
          message.role,
          message.toolName,
          message.provider,
          message.model,
          message.command,
          message.output,
          message.errorMessage,
          stringifyTextContent(message.content, { compact: false }),
        ]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n"),
      );
    }
    case "custom_message":
      return compactSearchText([entry.customType, stringifyTextContent(entry.content, { compact: false })].join("\n"));
    case "compaction":
      return compactSearchText(entry.summary);
    case "branch_summary":
      return compactSearchText(entry.summary);
    case "model_change":
      return compactSearchText(`${entry.provider} ${entry.modelId}`);
    case "thinking_level_change":
      return compactSearchText(String(entry.thinkingLevel));
    case "label":
      return compactSearchText(entry.label ?? "label cleared");
    case "session_info":
      return compactSearchText(entry.name ?? "session name cleared");
    case "custom":
      return compactSearchText(`${entry.customType} ${JSON.stringify(entry.data ?? {})}`);
  }
}

type TreeSearchMatcher = { ok: true; regex: RegExp; query: string } | { ok: false; message: string; query: string };

function compileTreeSearch(query: string, flags = "i"): TreeSearchMatcher | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > TREE_SEARCH_QUERY_MAX_LENGTH) return { ok: false, message: "query too long", query: trimmed };
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { ok: true, regex: new RegExp(escaped, flags), query: trimmed };
}

export function sessionEntryPreview(entry: SessionEntry, query: string): string | undefined {
  const text = sessionEntrySearchText(entry);
  const matcher = compileTreeSearch(query, "i");
  if (!matcher || !matcher.ok || text.length === 0 || text.length > TREE_SEARCH_SUBJECT_MAX_LENGTH) return undefined;
  const match = matcher.regex.exec(text);
  if (!match?.[0] && match?.index === undefined) return undefined;
  const firstMatch = match.index;
  const endOfMatch = Math.max(firstMatch + (match[0]?.length ?? 0), firstMatch + 1);
  const start = Math.max(0, firstMatch - 36);
  const end = Math.min(text.length, endOfMatch + 140);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function sessionEntrySummary(entry: SessionEntry): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message as {
        role?: string;
        content?: unknown;
        command?: string;
        toolName?: string;
        provider?: string;
        model?: string;
      };
      const text = stringifyTextContent(message.content);
      if (message.role === "user") return `user: ${text || "(empty)"}`;
      if (message.role === "assistant") return `assistant: ${text || "(tool call)"}`;
      if (message.role === "toolResult") return `tool: ${message.toolName ?? "unknown"}`;
      if (message.role === "bashExecution") return `bash: ${firstLine(message.command ?? "")}`;
      if (message.role === "custom") return `custom: ${text || "(message)"}`;
      return `${message.role ?? "message"}: ${text || "(entry)"}`;
    }
    case "custom_message":
      return `custom: ${stringifyTextContent(entry.content) || entry.customType}`;
    case "compaction":
      return `compact: ${firstLine(entry.summary)}`;
    case "branch_summary":
      return `branch: ${firstLine(entry.summary)}`;
    case "model_change":
      return `model: ${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return `thinking: ${entry.thinkingLevel}`;
    case "label":
      return entry.label ? `label: ${entry.label}` : "label: cleared";
    case "session_info":
      return `name: ${entry.name ?? "(cleared)"}`;
    case "custom":
      return `state: ${entry.customType}`;
  }
}

export function flattenSessionTreeRows(
  roots: readonly VimSessionTreeNode[],
  activeBranchIds: ReadonlySet<string>,
  leafId: string | null,
): VimSessionTreeRow[] {
  const rows: VimSessionTreeRow[] = [];

  const visit = (node: VimSessionTreeNode, depth: number, justBranched: boolean) => {
    rows.push({
      id: node.entry.id,
      entry: node.entry,
      depth,
      label: node.label,
      isActiveBranch: activeBranchIds.has(node.entry.id),
      isLeaf: node.entry.id === leafId,
      summary: sessionEntrySummary(node.entry),
    });

    const hasMultipleChildren = node.children.length > 1;
    const childDepth = hasMultipleChildren ? depth + 1 : justBranched && depth > 0 ? depth + 1 : depth;
    for (const child of node.children) visit(child, childDepth, hasMultipleChildren);
  };

  for (const root of roots) visit(root, 0, roots.length > 1);
  return rows;
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function messageRole(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  return (entry.message as { role?: string }).role;
}

function messageToolName(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  return (entry.message as { toolName?: string }).toolName;
}

function messageToolCalls(entry: SessionEntry): string[] {
  if (entry.type !== "message") return [];
  return toolCallNames((entry.message as { content?: unknown }).content);
}

function isDefaultVisibleRow(row: VimSessionTreeRow): boolean {
  if (row.entry.type !== "message") return false;
  const message = row.entry.message as { role?: string; content?: unknown };
  if (message.role === "user") return true;
  return message.role === "assistant" && hasTextContent(message.content);
}

function isFileToolRow(row: VimSessionTreeRow): boolean {
  const role = messageRole(row.entry);
  if (role === "toolResult") return FILE_TOOL_NAMES.has(messageToolName(row.entry) ?? "");
  return role === "assistant" && messageToolCalls(row.entry).some((name) => FILE_TOOL_NAMES.has(name));
}

function isBashRow(row: VimSessionTreeRow): boolean {
  const role = messageRole(row.entry);
  if (role === "bashExecution") return true;
  if (role === "toolResult") return messageToolName(row.entry) === "bash";
  return role === "assistant" && messageToolCalls(row.entry).includes("bash");
}

function primaryToolName(row: VimSessionTreeRow): string | undefined {
  if (messageRole(row.entry) === "toolResult") return messageToolName(row.entry);
  return messageToolCalls(row.entry)[0];
}

type RowKind = { label: string; color: ThemeColor };

export function sessionEntryKind(entry: SessionEntry): RowKind {
  return rowKind({
    id: entry.id,
    entry,
    depth: 0,
    isActiveBranch: false,
    isLeaf: false,
    summary: sessionEntrySummary(entry),
  });
}

function rowKind(row: VimSessionTreeRow): RowKind {
  const role = messageRole(row.entry);
  const toolName = cleanTerminalText(primaryToolName(row) ?? "") || undefined;
  if (role === "user") return { label: "USR", color: "userMessageText" };
  if (role === "toolResult" && toolName === "bash") return { label: "OUT", color: "toolOutput" };
  if (role === "bashExecution" || toolName === "bash") return { label: "BASH", color: "bashMode" };
  if (toolName === "read") return { label: "READ", color: "syntaxString" };
  if (toolName === "create") return { label: "CREATE", color: "success" };
  if (toolName === "update") return { label: "UPDATE", color: "warning" };
  if (toolName === "write") return { label: "WRITE", color: "toolDiffAdded" };
  if (toolName === "edit") return { label: "EDIT", color: "syntaxKeyword" };
  if (toolName) return { label: toolName.toUpperCase().slice(0, 8), color: "toolTitle" };
  if (role === "assistant") return { label: "AST", color: "success" };
  return { label: "META", color: "dim" };
}

function rowDisplaySummary(row: VimSessionTreeRow): string {
  for (const prefix of ["user: ", "assistant: ", "bash: ", "tool: "]) {
    if (row.summary.startsWith(prefix)) return row.summary.slice(prefix.length);
  }
  return row.summary;
}

function rowSearchText(row: VimSessionTreeRow): string {
  return [row.id, row.label, row.summary, rowDisplaySummary(row), rowKind(row).label, sessionEntrySearchText(row.entry)]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
}

function isPrintableInput(data: string): boolean {
  return [...data].length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 0x7f;
}

type TreeFilterState = {
  showFiles: boolean;
  showBash: boolean;
  showAll: boolean;
};

type VimSessionTreeMode = "normal" | "visual" | "visualLine";

type VimSessionTreeState = {
  filter: TreeFilterState;
  selectedId?: string;
  visualAnchorId?: string;
  mode: VimSessionTreeMode;
  searchQuery: string;
  scrollOffset: number;
};

type VimSessionTreeAction =
  | { kind: "cancel" }
  | {
      kind: "openExternal";
      entryIds: string[];
      mode: SessionDocumentMode;
      tui: TUI;
      state: VimSessionTreeState;
    }
  | {
      kind: "confirmLargeCopy";
      entryIds: string[];
      estimatedBytes: number;
      state: VimSessionTreeState;
    };

export class VimSessionTreeComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly rows: VimSessionTreeRow[];
  private readonly done: (action: VimSessionTreeAction) => void;
  private readonly copyText: (text: string) => Promise<void>;
  private readonly clipboardWarningBytes: number;
  private visibleRows: VimSessionTreeRow[];
  private filter: TreeFilterState = { showFiles: false, showBash: false, showAll: false };
  private selected = 0;
  private visualAnchor: number | undefined;
  private mode: VimSessionTreeMode = "normal";
  private scrollOffset = 0;
  private pendingG = false;
  private countBuffer = "";
  private searchActive = false;
  private searchQuery = "";
  private searchError: string | undefined;
  private statusMessage: string | undefined;
  private yankInProgress = false;

  constructor(
    tui: TUI,
    theme: Theme,
    rows: readonly VimSessionTreeRow[],
    done: (action: VimSessionTreeAction) => void,
    initialState?: VimSessionTreeState,
    copyText: (text: string) => Promise<void> = copySessionText,
    clipboardWarningBytes = SESSION_CLIPBOARD_WARNING_BYTES,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.rows = [...rows];
    if (initialState) {
      this.filter = { ...initialState.filter };
      this.searchQuery = initialState.searchQuery;
      this.mode = initialState.mode;
      this.scrollOffset = initialState.scrollOffset;
    }
    this.visibleRows = this.applyFilter();
    if (initialState?.selectedId) {
      const selected = this.visibleRows.findIndex((row) => row.id === initialState.selectedId);
      if (selected >= 0) this.selected = selected;
    }
    if (initialState?.visualAnchorId) {
      const anchor = this.visibleRows.findIndex((row) => row.id === initialState.visualAnchorId);
      if (anchor >= 0) this.visualAnchor = anchor;
    }
    this.done = done;
    this.copyText = copyText;
    this.clipboardWarningBytes = clipboardWarningBytes;
  }

  getSelectedIndex(): number {
    return this.selected;
  }

  getVisibleIds(): string[] {
    return this.visibleRows.map((row) => row.id);
  }

  getFilterLabel(): string {
    if (this.filter.showAll) return "all";
    const parts = ["chat"];
    if (this.filter.showFiles) parts.push("files");
    if (this.filter.showBash) parts.push("bash");
    return parts.join("+");
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  handleInput(data: string): void {
    if (this.searchActive) {
      this.handleSearchInput(data);
      return;
    }

    if (data === "q") {
      this.done({ kind: "cancel" });
      return;
    }

    if (data === "y" && this.mode !== "normal") {
      void this.yankSelection();
      return;
    }

    if (data === "R") {
      const entryIds = this.selectedEntryIds();
      if (entryIds.length > 0) {
        this.done({
          kind: "openExternal",
          entryIds,
          mode: "raw",
          tui: this.tui,
          state: this.snapshotState(),
        });
      }
      return;
    }

    if (data === "\x1b" || matchesKey(data, "escape")) {
      if (this.mode !== "normal") {
        this.mode = "normal";
        this.visualAnchor = undefined;
        this.tui.requestRender();
      }
      return;
    }

    if (/^[1-9]$/.test(data) || (this.countBuffer && data === "0")) {
      this.countBuffer += data;
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }

    if (data === "f") {
      this.setFilter({ ...this.filter, showAll: false, showFiles: !this.filter.showFiles });
      return;
    }

    if (data === "b") {
      this.setFilter({ ...this.filter, showAll: false, showBash: !this.filter.showBash });
      return;
    }

    if (data === "A") {
      this.setFilter({
        showAll: !this.filter.showAll,
        showFiles: this.filter.showFiles,
        showBash: this.filter.showBash,
      });
      return;
    }

    if (data === "d") {
      this.cycleDensityPreset();
      return;
    }

    if (data === "v" || data === "V") {
      this.mode = data === "v" ? "visual" : "visualLine";
      this.visualAnchor = this.selected;
      this.countBuffer = "";
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }

    if (data === "/") {
      this.searchActive = true;
      this.countBuffer = "";
      this.pendingG = false;
      this.tui.requestRender();
      return;
    }

    if ((data === "n" || data === "N") && this.searchQuery) {
      const count = this.consumeCount();
      this.pendingG = false;
      this.moveBy((data === "n" ? 1 : -1) * count);
      return;
    }

    if (data === "g") {
      if (this.pendingG) {
        const count = this.consumeCount();
        this.pendingG = false;
        this.moveTo(count - 1);
        return;
      }
      this.pendingG = true;
      this.tui.requestRender();
      return;
    }

    const hadPendingG = this.pendingG;
    this.pendingG = false;

    const hadCount = this.countBuffer.length > 0;
    const count = this.consumeCount();

    if (matchesKey(data, "down") || data === "j") {
      this.moveBy(count);
    } else if (matchesKey(data, "up") || data === "k") {
      this.moveBy(-count);
    } else if (data === "G") {
      this.moveTo(hadCount ? count - 1 : this.visibleRows.length - 1);
    } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const entryIds = this.selectedEntryIds();
      if (entryIds.length > 0) {
        this.done({
          kind: "openExternal",
          entryIds,
          mode: "readable",
          tui: this.tui,
          state: this.snapshotState(),
        });
      }
    } else if (hadPendingG) {
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const innerW = Math.max(1, width - 2);
    const viewportRows = this.visibleRowCount();
    this.ensureSelectionVisible(viewportRows);

    const lines: string[] = [];
    const border = (text: string) => this.theme.fg("border", text);
    const title = this.theme.fg("accent", ` Session Text `);
    const titleWidth = visibleWidth(title);
    const left = "─".repeat(Math.max(0, Math.floor((innerW - titleWidth) / 2)));
    const right = "─".repeat(Math.max(0, innerW - visibleWidth(left) - titleWidth));

    lines.push(border(`╭${left}`) + title + border(`${right}╮`));
    lines.push(this.wrapLine(this.statusLine(innerW), innerW));

    const visibleRows = this.visibleRows.slice(this.scrollOffset, this.scrollOffset + viewportRows);
    let bodyLines = 0;
    if (visibleRows.length === 0) {
      lines.push(this.wrapLine(this.theme.fg("dim", " No entries match current filter"), innerW));
      bodyLines += 1;
    }
    for (let index = 0; index < visibleRows.length; index++) {
      const row = visibleRows[index];
      if (!row) continue;
      lines.push(this.wrapLine(this.renderRow(row, innerW, this.scrollOffset + index), innerW));
      bodyLines += 1;
      const selected = this.visibleRows[this.selected]?.id === row.id;
      const preview = selected ? this.renderSelectedPreview(row, innerW) : undefined;
      if (preview && bodyLines < viewportRows) {
        lines.push(this.wrapLine(preview, innerW));
        bodyLines += 1;
      }
    }
    for (let i = Math.max(1, bodyLines); i < viewportRows; i++) lines.push(this.wrapLine("", innerW));

    lines.push(this.wrapLine(this.helpLine(), innerW));
    lines.push(border(`╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  invalidate(): void {}

  private snapshotState(): VimSessionTreeState {
    return {
      filter: { ...this.filter },
      selectedId: this.visibleRows[this.selected]?.id,
      visualAnchorId: this.visualAnchor === undefined ? undefined : this.visibleRows[this.visualAnchor]?.id,
      mode: this.mode,
      searchQuery: this.searchQuery,
      scrollOffset: this.scrollOffset,
    };
  }

  private visualBounds(): { start: number; end: number } | undefined {
    if (this.mode === "normal" || this.visualAnchor === undefined) return undefined;
    return {
      start: Math.min(this.visualAnchor, this.selected),
      end: Math.max(this.visualAnchor, this.selected),
    };
  }

  private isVisuallySelected(index: number): boolean {
    const bounds = this.visualBounds();
    return bounds !== undefined && index >= bounds.start && index <= bounds.end;
  }

  private selectedEntryIds(): string[] {
    const bounds = this.visualBounds();
    if (!bounds) {
      const selected = this.visibleRows[this.selected];
      return selected ? [selected.id] : [];
    }
    return this.visibleRows.slice(bounds.start, bounds.end + 1).map((row) => row.id);
  }

  private wrapLine(content: string, innerW: number): string {
    return `${this.theme.fg("border", "│")}${padToWidth(content, innerW)}${this.theme.fg("border", "│")}`;
  }

  private renderRow(row: VimSessionTreeRow, width: number, rowIndex: number): string {
    const selected = this.visibleRows[this.selected]?.id === row.id;
    const visuallySelected = this.isVisuallySelected(rowIndex);
    const pointer = selected
      ? this.theme.bg("selectedBg", this.theme.fg("accent", "▶"))
      : visuallySelected
        ? this.theme.bg("selectedBg", this.theme.fg("warning", "┃"))
        : " ";
    const branch = row.isLeaf
      ? this.theme.fg("success", "●")
      : row.isActiveBranch
        ? this.theme.fg("accent", "│")
        : this.theme.fg("dim", "·");
    const indent = "  ".repeat(row.depth);
    const label = row.label ? this.theme.fg("warning", ` [${cleanTerminalText(row.label)}]`) : "";
    const id = this.theme.fg("dim", cleanTerminalText(row.id));
    const kind = rowKind(row);
    const badge = this.theme.bold(this.theme.fg(kind.color, kind.label.padEnd(6)));
    const rawSummary = cleanTerminalText(rowDisplaySummary(row));
    const summary = selected || visuallySelected ? this.theme.bold(rawSummary) : rawSummary;
    const preview = sessionEntryPreview(row.entry, this.searchQuery);
    const previewText = preview && !selected ? ` ${this.theme.fg("muted", "⟡")} ${this.highlightPreview(preview)}` : "";
    return truncateToWidth(`${pointer} ${branch} ${indent}${badge} ${id} ${summary}${label}${previewText}`, width, "…", true);
  }

  private renderSelectedPreview(row: VimSessionTreeRow, width: number): string | undefined {
    const preview = sessionEntryPreview(row.entry, this.searchQuery);
    if (!preview) return undefined;
    return truncateToWidth(`    ${this.theme.fg("warning", "match")} ${this.highlightPreview(preview)}`, width, "…", true);
  }

  private highlightPreview(preview: string): string {
    const matcher = compileTreeSearch(this.searchQuery, "gi");
    if (!matcher?.ok) return this.theme.fg("muted", preview);
    const parts: string[] = [];
    let lastIndex = 0;
    for (const match of preview.matchAll(matcher.regex)) {
      const index = match.index ?? 0;
      const matched = match[0] ?? "";
      if (matched.length === 0) continue;
      if (index > lastIndex) parts.push(this.theme.fg("muted", preview.slice(lastIndex, index)));
      parts.push(this.theme.bg("selectedBg", this.theme.fg("warning", this.theme.bold(matched))));
      lastIndex = index + matched.length;
    }
    if (lastIndex < preview.length) parts.push(this.theme.fg("muted", preview.slice(lastIndex)));
    return parts.join("");
  }

  private async yankSelection(): Promise<void> {
    if (this.yankInProgress) return;
    const ids = this.selectedEntryIds();
    const entries = ids
      .map((id) => this.visibleRows.find((row) => row.id === id)?.entry)
      .filter((entry): entry is SessionEntry => Boolean(entry));
    if (entries.length === 0) return;

    this.yankInProgress = true;
    try {
      const estimatedBytes = estimateSessionEntriesClipboardBytes(entries);
      if (estimatedBytes === 0) {
        this.statusMessage = "No copyable text in selection";
        return;
      }
      if (estimatedBytes > this.clipboardWarningBytes) {
        this.done({
          kind: "confirmLargeCopy",
          entryIds: ids,
          estimatedBytes,
          state: this.snapshotState(),
        });
        return;
      }

      await this.copyText(sessionEntriesClipboardText(entries));
      this.statusMessage = `${entries.length} entr${entries.length === 1 ? "y" : "ies"} yanked`;
      this.mode = "normal";
      this.visualAnchor = undefined;
    } catch {
      this.statusMessage = "Clipboard copy failed";
    } finally {
      this.yankInProgress = false;
      this.tui.requestRender();
    }
  }

  private statusLine(width: number): string {
    const selected = this.visibleRows.length > 0 ? this.selected + 1 : 0;
    const total = this.visibleRows.length;
    const modeLabel = this.mode === "normal" ? TREE_COMMAND_MODE : this.mode === "visualLine" ? "V-LINE" : "VISUAL";
    const mode = this.theme.bg("selectedBg", this.theme.fg("accent", ` ${modeLabel} `));
    const pending = this.pendingG ? this.theme.fg("warning", " g") : "";
    const count = this.countBuffer ? this.theme.fg("warning", ` ${this.countBuffer}`) : "";
    const search = this.searchQuery
      ? this.theme.fg(this.searchActive ? "warning" : "muted", ` /${this.searchQuery}`)
      : this.searchActive
        ? this.theme.fg("warning", " /")
        : "";
    const error = this.searchError ? this.theme.fg("error", ` ${this.searchError}`) : "";
    const visualCount = this.mode === "normal" ? "" : this.theme.fg("warning", ` ${this.selectedEntryIds().length} selected`);
    const message = this.statusMessage ? this.theme.fg("success", ` ${this.statusMessage}`) : "";
    return truncateToWidth(
      `${mode} ${selected}/${total} [${this.getFilterLabel()}]${search}${error}${visualCount}${message}${count}${pending}`,
      width,
      "…",
      true,
    );
  }

  private helpLine(): string {
    return this.theme.fg(
      "dim",
      this.searchActive
        ? " literal search in current filter • enter/esc accept • backspace edit • ctrl-u clear"
        : this.mode === "normal"
          ? " j/k • gg/G • v/V visual • / search • enter clean editor • R raw JSON • f files • b bash • d density • A all • q close"
          : " j/k/counts extend • y yank source • enter clean editor • R raw JSON • esc normal • q close",
    );
  }

  private moveBy(delta: number): void {
    this.moveTo(this.selected + delta);
  }

  private moveTo(index: number): void {
    const max = Math.max(0, this.visibleRows.length - 1);
    this.selected = Math.max(0, Math.min(max, index));
    this.tui.requestRender();
  }

  private ensureSelectionVisible(viewportRows: number): void {
    if (this.selected < this.scrollOffset) this.scrollOffset = this.selected;
    if (this.selected >= this.scrollOffset + viewportRows) {
      this.scrollOffset = Math.max(0, this.selected - viewportRows + 1);
    }
  }

  private visibleRowCount(): number {
    const terminalRows = (this.tui as { terminal?: { rows?: unknown } }).terminal?.rows;
    const availableRows =
      typeof terminalRows === "number" ? terminalRows - TREE_OVERLAY_MARGIN_ROWS - TREE_VERTICAL_CHROME_ROWS : FALLBACK_VISIBLE_ROWS;
    return Math.min(Math.max(1, availableRows), Math.max(1, this.visibleRows.length));
  }

  private setFilter(filter: TreeFilterState): void {
    this.filter = filter;
    this.refreshVisibleRows();
    this.pendingG = false;
    this.countBuffer = "";
    this.tui.requestRender();
  }

  private handleSearchInput(data: string): void {
    if (data === "\x1b" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.searchActive = false;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      this.searchActive = false;
      this.tui.requestRender();
      return;
    }

    if (data === "\x15") {
      this.searchQuery = "";
      this.searchError = undefined;
      this.refreshVisibleRows();
      this.tui.requestRender();
      return;
    }

    if (data === "\x17") {
      this.searchQuery = this.searchQuery.trimEnd().replace(/\S+$/, "");
      this.refreshVisibleRows();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "backspace") || data === "\x7f") {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.refreshVisibleRows();
      this.tui.requestRender();
      return;
    }

    if (isPrintableInput(data)) {
      this.searchQuery += data;
      this.refreshVisibleRows();
      this.tui.requestRender();
    }
  }

  private refreshVisibleRows(): void {
    const selectedId = this.visibleRows[this.selected]?.id;
    this.visibleRows = this.applyFilter();
    const sameSelection = selectedId ? this.visibleRows.findIndex((row) => row.id === selectedId) : -1;
    this.selected = sameSelection >= 0 ? sameSelection : Math.min(this.selected, Math.max(0, this.visibleRows.length - 1));
    this.scrollOffset = 0;
  }

  private consumeCount(): number {
    const count = this.countBuffer ? Number.parseInt(this.countBuffer, 10) : 1;
    this.countBuffer = "";
    return Number.isFinite(count) && count > 0 ? count : 1;
  }

  private cycleDensityPreset(): void {
    const current = this.getFilterLabel();
    if (current === "chat") this.setFilter({ showAll: false, showFiles: true, showBash: false });
    else if (current === "chat+files") this.setFilter({ showAll: false, showFiles: true, showBash: true });
    else if (current === "chat+files+bash") this.setFilter({ showAll: true, showFiles: true, showBash: true });
    else this.setFilter({ showAll: false, showFiles: false, showBash: false });
  }

  private applyFilter(): VimSessionTreeRow[] {
    const matcher = compileTreeSearch(this.searchQuery, "i");
    this.searchError = matcher && !matcher.ok ? matcher.message : undefined;
    const categoryFiltered = this.filter.showAll
      ? this.rows
      : this.rows.filter(
          (row) => isDefaultVisibleRow(row) || (this.filter.showFiles && isFileToolRow(row)) || (this.filter.showBash && isBashRow(row)),
        );
    if (!matcher) return [...categoryFiltered];
    if (!matcher.ok) return [];
    return categoryFiltered.filter((row) => {
      const text = rowSearchText(row);
      if (text.length > TREE_SEARCH_SUBJECT_MAX_LENGTH) return false;
      matcher.regex.lastIndex = 0;
      return matcher.regex.test(text);
    });
  }
}

function writeSessionEntriesDocument(path: string, entries: readonly SessionEntry[], mode: SessionDocumentMode): void {
  const descriptor = openSync(path, "w", 0o600);
  try {
    for (const chunk of sessionEntriesDocumentChunks(entries, mode)) {
      const buffer = Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(descriptor, buffer, offset);
        if (written <= 0) throw new Error("Could not write session text document");
        offset += written;
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

function formatClipboardSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function openEntriesInExternalEditor(
  ctx: ExtensionContext,
  entries: SessionEntry[],
  mode: SessionDocumentMode,
  tui?: TUI,
): Promise<void> {
  const editorCmd = process.env.VISUAL || process.env.EDITOR || "nvim";
  const dir = mkdtempSync(join(tmpdir(), "pi-session-entry-"));
  const extension = mode === "raw" ? "json" : "md";
  const path = join(dir, entries.length === 1 ? `entry.${extension}` : `entries-${entries.length}.${extension}`);

  let status: number | null = null;
  try {
    writeSessionEntriesDocument(path, entries, mode);
    chmodSync(path, 0o444);
    try {
      tui?.stop?.();
      process.stdout.write(
        `Opening ${entries.length} session entr${entries.length === 1 ? "y" : "ies"} in ${editorCmd}\nPi will resume when the editor exits.\n`,
      );
      const [editor, ...editorArgs] = editorCmd.split(" ").filter(Boolean);
      const executable = editor ?? "nvim";
      const readonlyArgs = /(^|\/)(n?vim|view)$/.test(executable) ? ["-R", "-M"] : [];
      status = await new Promise<number | null>((resolve) => {
        const child = spawn(executable, [...editorArgs, ...readonlyArgs, path], {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        child.on("exit", (code) => resolve(code));
        child.on("error", () => resolve(127));
      });
    } finally {
      tui?.start?.();
      tui?.requestRender?.(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (status && status !== 0) ctx.ui.notify(`Editor exited with code ${status}`, "warning");
}

export async function openSessionTextBrowser(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Session text browser is only available in TUI mode", "warning");
    return;
  }

  const activeBranchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
  const rows = flattenSessionTreeRows(ctx.sessionManager.getTree(), activeBranchIds, ctx.sessionManager.getLeafId());
  if (rows.length === 0) {
    ctx.ui.notify("No session entries yet", "info");
    return;
  }

  let initialState: VimSessionTreeState | undefined;
  while (true) {
    const action = await ctx.ui.custom<VimSessionTreeAction>(
      (tui, theme, _keybindings, done) => new VimSessionTreeComponent(tui, theme, rows, done, initialState, copySessionText),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "85%",
          minWidth: 60,
          maxHeight: "100%",
          margin: 1,
        },
      },
    );

    if (!action || action.kind === "cancel") return;

    if (action.kind === "confirmLargeCopy") {
      initialState = action.state;
      const entries = action.entryIds.map((id) => ctx.sessionManager.getEntry(id)).filter((entry): entry is SessionEntry => Boolean(entry));
      if (entries.length === 0) {
        ctx.ui.notify("No selected session entries found", "error");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Large clipboard copy",
        `Copy ${formatClipboardSize(action.estimatedBytes)} of session text to the clipboard?`,
      );
      if (!confirmed) continue;
      try {
        await copySessionText(sessionEntriesClipboardText(entries));
        initialState = { ...action.state, mode: "normal", visualAnchorId: undefined };
        ctx.ui.notify(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} yanked`, "info");
      } catch (error) {
        ctx.ui.notify(`Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      continue;
    }

    if (action.kind === "openExternal") {
      const entries = action.entryIds.map((id) => ctx.sessionManager.getEntry(id)).filter((entry): entry is SessionEntry => Boolean(entry));
      if (entries.length === 0) {
        ctx.ui.notify("No selected session entries found", "error");
        return;
      }
      initialState = action.state;
      await openEntriesInExternalEditor(ctx, entries, action.mode, action.tui);
    }
  }
}
