import { unlinkSync } from "node:fs";
import type { ExtensionAPI, SessionInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CLI_COLORS as COLORS, color, compact, pad, registerSharedJsonFlag, supportsColor, writeStdoutLine } from "./cli-listing.js";
import { DEFAULT_PI_CONFIG, loadPiConfig, type SessionBrowserConfig } from "./config.js";
import { markManualTitle, markManualTitleInSession } from "./state.js";

const LIST_SESSIONS_FLAG = "list-sessions";
const JSON_FLAG = "json";

type ListSessionsArgs = {
  enabled: boolean;
  filter?: string;
  json: boolean;
  sessionDir?: string;
};

type SessionSelectorResult =
  | { action: "switch"; session: SessionInfo }
  | { action: "rename"; session: SessionInfo }
  | { action: "delete"; session: SessionInfo }
  | { action: "cancel" };

export function parseListSessionsArgs(args = process.argv.slice(2)): ListSessionsArgs {
  const parsed: ListSessionsArgs = { enabled: false, json: false };
  const flag = `--${LIST_SESSIONS_FLAG}`;
  const jsonFlag = `--${JSON_FLAG}`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === jsonFlag) {
      parsed.json = true;
      continue;
    }
    if (arg === "--session-dir" && args[i + 1]) {
      parsed.sessionDir = args[++i];
      continue;
    }
    if (arg === flag) {
      parsed.enabled = true;
      const next = args[i + 1];
      if (next && !next.startsWith("-") && !next.startsWith("@")) {
        parsed.filter = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      parsed.enabled = true;
      parsed.filter = arg.slice(flag.length + 1) || undefined;
    }
  }
  return parsed;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function fuzzyIncludes(value: string, filter: string): boolean {
  const haystack = normalize(value);
  const needle = normalize(filter);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;

  let needleIndex = 0;
  for (const char of haystack) {
    if (char === needle[needleIndex]) needleIndex++;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

function sessionTitle(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage?.trim() || "(empty)";
}

function sessionMatches(session: SessionInfo, filter: string | undefined): boolean {
  if (!filter) return true;
  return fuzzyIncludes(
    [session.id, session.name, session.firstMessage, session.allMessagesText, session.path, session.cwd].filter(Boolean).join("\n"),
    filter,
  );
}

function padAnsi(value: string, width: number): string {
  const visible = visibleWidth(value);
  return `${value}${" ".repeat(Math.max(0, width - visible))}`;
}

function formatDuration(start: Date, end: Date): string {
  let minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.slice(0, 3).join(" ");
}

function formatRelativeDate(date: Date, now = new Date()): string {
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDiff = Math.max(0, Math.round((nowDay - dateDay) / 86_400_000));
  const time = date.toTimeString().slice(0, 5);
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `yesterday ${time}`;
  return `${dayDiff}d ago`;
}

function fitWidths(terminalWidth: number) {
  const fixedWidth = 8 + 10 + 6 + 16 + 10;
  const available = Math.max(20, terminalWidth - fixedWidth);
  return { nameWidth: Math.max(12, available) };
}

function formatSessionsList(sessions: SessionInfo[]): string {
  const now = new Date();
  const terminalWidth = Math.max(60, process.stdout.columns || 100);
  const useColor = supportsColor();
  const rows = sessions.map((session) => ({
    id: session.id.slice(0, 8),
    name: sessionTitle(session),
    duration: formatDuration(session.created, session.modified),
    messages: String(session.messageCount),
    created: formatRelativeDate(session.created, now),
    updated: formatRelativeDate(session.modified, now),
  }));
  const widths = fitWidths(terminalWidth);
  const header = `${pad("id", 8)}  ${pad("name", widths.nameWidth)}  ${pad("duration", 10)}  ${pad("msgs", 6)}  ${pad("created", 16)}  ${pad("updated", 16)}`;
  const lines = [color(header, COLORS.dim, useColor)];

  rows.forEach((row, index) => {
    const id = color(pad(row.id, 8), COLORS.cyan, useColor);
    const name = color(pad(compact(row.name, widths.nameWidth), widths.nameWidth), COLORS.green, useColor);
    const duration = color(pad(row.duration, 10), COLORS.yellow, useColor);
    const messages = color(pad(row.messages, 6), COLORS.magenta, useColor);
    const created = color(pad(row.created, 16), COLORS.blue, useColor);
    const updated = color(pad(row.updated, 16), COLORS.blue, useColor);
    const line = `${id}  ${name}  ${duration}  ${messages}  ${created}  ${updated}`;
    lines.push(index % 2 === 1 ? color(line, COLORS.dim, useColor) : line);
  });
  return lines.join("\n");
}

function toJsonSession(session: SessionInfo) {
  return {
    ...session,
    title: sessionTitle(session),
    durationMs: session.modified.getTime() - session.created.getTime(),
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
  };
}

async function getSessions(cwd: string, args: ListSessionsArgs): Promise<SessionInfo[]> {
  const sessionDir = args.sessionDir ?? SettingsManager.create(cwd, getAgentDir()).getSessionDir();
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.filter((session) => sessionMatches(session, args.filter)).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

class SessionsSelector {
  private selected = 0;
  private scroll = 0;
  private deleteArmedPath?: string;
  private deleteArmedPresses = 0;
  private filter = "";

  constructor(
    private sessions: SessionInfo[],
    private browser: SessionBrowserConfig,
    private theme: any,
    private done: (result: SessionSelectorResult) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done({ action: "cancel" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.clearDeleteArmed();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = this.clampSelection(this.selected + 1);
      this.clearDeleteArmed();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const session = this.filteredSessions()[this.selected];
      if (session) this.done({ action: "switch", session });
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const session = this.filteredSessions()[this.selected];
      if (session) this.done({ action: "rename", session });
      return;
    }
    if (matchesKey(data, Key.ctrl("d")) && this.browser.delete.enabled) {
      const session = this.filteredSessions()[this.selected];
      if (!session) return;
      const required = Math.max(1, this.browser.delete.confirmPresses);
      if (this.deleteArmedPath === session.path) this.deleteArmedPresses++;
      else {
        this.deleteArmedPath = session.path;
        this.deleteArmedPresses = 1;
      }
      if (this.deleteArmedPresses >= required) this.done({ action: "delete", session });
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.filter = this.filter.slice(0, -1);
      this.selected = this.clampSelection(this.selected);
      this.clearDeleteArmed();
      return;
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.filter += data;
      this.selected = 0;
      this.scroll = 0;
      this.clearDeleteArmed();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(24, width - 4);
    const content: string[] = [];
    const listHeight = Math.max(4, Math.min(20, this.browser.pageSize));
    const filtered = this.filteredSessions();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + listHeight) this.scroll = this.selected - listHeight + 1;

    const deleteHint = this.browser.delete.confirmPresses <= 1 ? "ctrl+d delete" : "ctrl+d ctrl+d delete";
    content.push(this.theme.fg("dim", `↑↓ navigate • type filter • enter switch • ctrl+r rename • ${deleteHint} • esc cancel`));
    content.push(this.theme.fg("dim", `project scope • filter: ${this.filter || "(none)"}`));
    content.push("");

    if (filtered.length === 0) {
      content.push(this.theme.fg("muted", "No sessions found for this project."));
      return this.renderFrame(content, width, innerWidth);
    }

    const rows = filtered.map((session) => ({
      id: session.id.slice(0, 8),
      name: sessionTitle(session),
      duration: formatDuration(session.created, session.modified),
      messages: String(session.messageCount),
      updated: formatRelativeDate(session.modified),
    }));
    const fixed = 2 + 8 + 2 + 10 + 2 + 6 + 2 + 16;
    const nameWidth = Math.max(12, innerWidth - fixed);
    content.push(this.theme.fg("dim", `${pad("id", 8)}  ${pad("name", nameWidth)}  ${pad("duration", 10)}  ${pad("msgs", 6)}  updated`));

    const visible = rows.slice(this.scroll, this.scroll + listHeight);
    visible.forEach((row, visibleIndex) => {
      const index = this.scroll + visibleIndex;
      const selected = index === this.selected;
      const prefix = selected ? "› " : "  ";
      const text = `${prefix}${pad(row.id, 8)}  ${pad(compact(row.name, nameWidth), nameWidth)}  ${pad(row.duration, 10)}  ${pad(row.messages, 6)}  ${row.updated}`;
      content.push(selected ? this.theme.bg("selectedBg", this.theme.fg("accent", text)) : text);
    });

    const selectedSession = filtered[this.selected];
    if (selectedSession && this.shouldShowCwd(filtered)) {
      content.push(this.theme.fg("dim", `cwd: ${selectedSession.cwd}`));
    }
    if (selectedSession && this.deleteArmedPath === selectedSession.path) {
      const remaining = Math.max(1, this.browser.delete.confirmPresses) - this.deleteArmedPresses;
      content.push(
        this.theme.fg("error", remaining > 1 ? `Press ctrl+d ${remaining} more times to delete` : "Press ctrl+d again to delete"),
      );
    } else {
      content.push(this.theme.fg("dim", `${this.selected + 1}/${filtered.length}`));
    }
    return this.renderFrame(content, width, innerWidth);
  }

  private filteredSessions(): SessionInfo[] {
    return this.sessions.filter((session) => sessionMatches(session, this.filter));
  }

  private clampSelection(index: number): number {
    const max = this.filteredSessions().length - 1;
    if (max < 0) return 0;
    return Math.max(0, Math.min(index, max));
  }

  private shouldShowCwd(sessions: SessionInfo[]): boolean {
    const first = sessions[0]?.cwd;
    return sessions.some((session) => session.cwd !== first);
  }

  private clearDeleteArmed(): void {
    this.deleteArmedPath = undefined;
    this.deleteArmedPresses = 0;
  }

  private renderFrame(content: string[], width: number, innerWidth: number): string[] {
    const title = " Sessions ";
    const top = `╭─${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 1))}╮`;
    const bottom = `╰${"─".repeat(innerWidth + 2)}╯`;
    return [
      this.theme.fg("accent", truncateToWidth(top, width)),
      ...content.map((line) => {
        const clipped = truncateToWidth(line, innerWidth);
        return `${this.theme.fg("accent", "│")} ${padAnsi(clipped, innerWidth)} ${this.theme.fg("accent", "│")}`;
      }),
      this.theme.fg("accent", truncateToWidth(bottom, width)),
    ];
  }

  invalidate(): void {}
}

async function showSessionsSelector(ctx: any, browser: SessionBrowserConfig): Promise<SessionSelectorResult> {
  const sessions = await getSessions(ctx.cwd, { enabled: true, json: false });
  return ctx.ui.custom(
    (tui: any, theme: any, _kb: unknown, done: (result: SessionSelectorResult) => void) => {
      const selector = new SessionsSelector(sessions, browser, theme, done);
      return {
        render: (width: number) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data: string) => {
          selector.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 64,
        maxHeight: "80%",
        margin: 1,
      },
    },
  );
}

export async function renameSession(pi: ExtensionAPI, ctx: any, session: SessionInfo): Promise<void> {
  const currentName = session.name ?? "";
  const newName = await ctx.ui.input("Rename session", currentName || sessionTitle(session));
  if (newName === undefined) return;
  const trimmed = newName.trim();
  if (session.path === ctx.sessionManager.getSessionFile()) {
    pi.setSessionName(trimmed);
    markManualTitle(pi, trimmed);
  } else {
    const sessionManager = SessionManager.open(session.path);
    sessionManager.appendSessionInfo(trimmed);
    markManualTitleInSession(sessionManager, trimmed);
  }
  ctx.ui.notify(trimmed ? `Renamed session: ${trimmed}` : "Cleared session name", "info");
}

async function deleteSession(pi: ExtensionAPI, ctx: any, session: SessionInfo, browser: SessionBrowserConfig): Promise<void> {
  if (session.path === ctx.sessionManager.getSessionFile()) {
    ctx.ui.notify("Cannot delete the current session", "error");
    return;
  }
  if (browser.delete.useTrash) {
    try {
      const result = await pi.exec("trash", [session.path], { timeout: 3000 });
      if (result.code === 0) {
        ctx.ui.notify(`Moved session to trash: ${sessionTitle(session)}`, "info");
        return;
      }
    } catch {
      // Fall back to unlink below.
    }
  }
  unlinkSync(session.path);
  ctx.ui.notify(`Deleted session: ${sessionTitle(session)}`, "info");
}

async function loadSessionConfig(cwd: string) {
  try {
    return (await loadPiConfig(cwd)).config.session;
  } catch {
    return DEFAULT_PI_CONFIG.session;
  }
}

export async function registerSessionList(pi: ExtensionAPI): Promise<void> {
  const sessionConfig = await loadSessionConfig(process.cwd());
  const browser = sessionConfig.browser;
  const args = parseListSessionsArgs();

  if (browser.enabled) {
    pi.registerCommand(browser.command, {
      description: "Switch, rename, or delete project sessions",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        while (true) {
          const result = await showSessionsSelector(ctx, browser);
          if (result.action === "cancel") return;
          if (result.action === "switch") {
            await ctx.switchSession(result.session.path);
            return;
          }
          if (result.action === "rename") {
            await renameSession(pi, ctx, result.session);
            continue;
          }
          if (result.action === "delete") {
            await deleteSession(pi, ctx, result.session, browser);
          }
        }
      },
    });
  }

  pi.registerFlag(LIST_SESSIONS_FLAG, {
    description: "List project sessions (with optional fuzzy filter)",
    type: "boolean",
  });
  if (args.enabled) registerSharedJsonFlag(pi, JSON_FLAG);
  if (!args.enabled) return;

  const sessions = await getSessions(process.cwd(), args);
  const output = args.json ? JSON.stringify(sessions.map(toJsonSession), null, 2) : formatSessionsList(sessions);
  writeStdoutLine(output);
  process.exit(0);
}

export default registerSessionList;
