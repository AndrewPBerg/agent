import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getInlineModes, type InlineModeState, inlineModeAnimationInterval, subscribeInlineModes } from "../lib/inline-modes";
import { VIM_LEADER_EVENT, type VimLeaderInvocation } from "../vim-leader/protocol";

const MODAL_CHROME_ROWS = 5;

type FooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

type Usage = {
  tokens?: number;
  contextWindow?: number;
  percent?: number | null;
};

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export default function inlineDetails(pi: ExtensionAPI) {
  let footerData: FooterData | undefined;
  let detailsOpen = false;
  let sessionCtx: ExtensionContext | undefined;
  let disposeFooterResources: (() => void) | undefined;

  const openDetails = async (ctx: ExtensionContext) => {
    if (detailsOpen || ctx.mode !== "tui") return;
    detailsOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new DetailsModal(
            pi,
            ctx,
            footerData,
            theme,
            Math.max(1, Math.floor(tui.terminal.rows * 0.88) - MODAL_CHROME_ROWS),
            tui.requestRender.bind(tui),
            done,
          ),
        {
          overlay: true,
          overlayOptions: { width: "72%", minWidth: 48, maxHeight: "88%", anchor: "center" },
        },
      );
    } finally {
      detailsOpen = false;
    }
  };

  pi.registerCommand("details", {
    description: "Show session, model, token, git, and extension details",
    handler: async (_args, ctx) => openDetails(ctx),
  });

  const unsubscribeLeader = pi.events.on(VIM_LEADER_EVENT, (data) => {
    const invocation = data as VimLeaderInvocation;
    if (invocation?.sequence !== "d" || !sessionCtx) return;
    void openDetails(sessionCtx).catch((error) => sessionCtx?.ui.notify(`Could not open details: ${errorMessage(error)}`, "error"));
  });

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, data) => {
      footerData = data;
      let animationTimer: ReturnType<typeof setInterval> | undefined;
      let animationInterval: number | undefined;

      const syncAnimation = () => {
        const nextInterval = inlineModeAnimationInterval();
        if (nextInterval === animationInterval) return;
        if (animationTimer) clearInterval(animationTimer);
        animationTimer = undefined;
        animationInterval = nextInterval;
        if (nextInterval !== undefined) {
          animationTimer = setInterval(() => tui.requestRender(), nextInterval);
          animationTimer.unref?.();
        }
      };

      const unsubscribeBranch = data.onBranchChange(() => tui.requestRender());
      const unsubscribeModes = subscribeInlineModes(() => {
        syncAnimation();
        tui.requestRender();
      });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribeBranch();
        unsubscribeModes();
        if (animationTimer) clearInterval(animationTimer);
        if (footerData === data) footerData = undefined;
        if (disposeFooterResources === dispose) disposeFooterResources = undefined;
      };
      disposeFooterResources?.();
      disposeFooterResources = dispose;
      syncAnimation();

      return {
        dispose,
        invalidate() {},
        render(width: number) {
          return [renderInlineFooter(pi, ctx, theme, width)];
        },
      };
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribeLeader();
    disposeFooterResources?.();
    disposeFooterResources = undefined;
    sessionCtx = undefined;
    footerData = undefined;
    detailsOpen = false;
  });
}

export function renderInlineFooter(pi: ExtensionAPI, ctx: ExtensionContext, theme: Theme, width: number): string {
  if (width <= 0) return "";

  const directory = formatDirectory(ctx.cwd);
  const name = sessionName(ctx);
  const model = ctx.model?.id ?? "no-model";
  const reasoning = !ctx.model ? "n/a" : ctx.model.reasoning === false ? "off" : pi.getThinkingLevel();
  const context = formatContext(ctx);

  const inlineModes = renderInlineModes(theme);
  const location = theme.fg("dim", `${directory} · ${name}`);
  const left = inlineModes ? `${inlineModes} ${location}` : location;
  const right = [theme.fg("text", model), theme.fg(reasoningColor(reasoning), reasoning), colorContext(context, ctx, theme)].join(
    theme.fg("dim", " · "),
  );

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "…");

  const availableLeft = Math.max(0, width - rightWidth - 3);
  const fittedLeft = truncateToWidth(left, availableLeft, theme.fg("dim", "…"));
  const padding = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
  return truncateToWidth(`${fittedLeft}${padding}${right}`, width, "…");
}

function renderInlineModes(theme: Theme, now = Date.now()): string {
  return getInlineModes()
    .map(({ state }) => renderInlineMode(state, theme, now))
    .join(" ");
}

function renderInlineMode(state: InlineModeState, theme: Theme, now: number): string {
  const frames = state.frames?.length ? state.frames : undefined;
  const frame = frames?.[Math.floor(now / Math.max(60, state.intervalMs ?? 160)) % frames.length];
  const icon = frame?.icon ?? state.icon;
  const tone = frame?.tone ?? state.tone ?? "accent";
  const content = [icon, state.label, state.detail].filter(Boolean).join(" ");
  return theme.bg("selectedBg", theme.fg(tone, theme.bold(` ${content} `)));
}

class DetailsModal {
  private offset = 0;
  private maxOffset = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly footerData: FooterData | undefined,
    private readonly theme: Theme,
    private readonly visibleRows: number,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (data === "q" || isKey(data, "escape", "\u001b") || isKey(data, "ctrl+c", "\u0003") || isKey(data, "enter", "\r")) {
      this.done();
      return;
    }

    const previous = this.offset;
    if (data === "k" || isKey(data, "up", "\u001b[A")) this.offset = Math.max(0, this.offset - 1);
    if (data === "j" || isKey(data, "down", "\u001b[B")) this.offset = Math.min(this.maxOffset, this.offset + 1);
    if (data === "g" || isKey(data, "home", "\u001b[H")) this.offset = 0;
    if (data === "G" || isKey(data, "end", "\u001b[F")) this.offset = this.maxOffset;
    if (isKey(data, "pageUp", "\u001b[5~")) this.offset = Math.max(0, this.offset - this.visibleRows);
    if (isKey(data, "pageDown", "\u001b[6~")) this.offset = Math.min(this.maxOffset, this.offset + this.visibleRows);
    if (this.offset !== previous) this.requestRender();
  }

  render(width: number): string[] {
    const lines = detailLines(this.pi, this.ctx, this.footerData, this.theme);
    this.maxOffset = Math.max(0, lines.length - this.visibleRows);
    this.offset = Math.min(this.offset, this.maxOffset);
    const visible = lines.slice(this.offset, this.offset + this.visibleRows);
    const padding = Array.from({ length: this.visibleRows - visible.length }, () => "");
    const rangeEnd = Math.min(lines.length, this.offset + visible.length);
    const scroll = this.maxOffset > 0 ? ` ${this.offset + 1}-${rangeEnd}/${lines.length} ` : ` ${lines.length} details `;
    return panel(
      [
        this.theme.fg("accent", this.theme.bold(" Inline details ")),
        this.theme.fg("dim", scroll),
        ...visible,
        ...padding,
        this.theme.fg("dim", " ↑↓/j k scroll · g/G ends · q/Esc/Ctrl-C/Enter close "),
      ],
      width,
      this.theme,
    );
  }

  invalidate(): void {}
}

function detailLines(pi: ExtensionAPI, ctx: ExtensionContext, footerData: FooterData | undefined, theme: Theme): string[] {
  const usage = contextUsage(ctx);
  const totals = usageTotals(ctx);
  const statuses = footerData ? [...footerData.getExtensionStatuses().entries()].sort(([a], [b]) => a.localeCompare(b)) : [];
  const activeTools = pi.getActiveTools();
  const allTools = pi.getAllTools();
  const file = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
  const id = ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getHeader?.()?.id ?? "unknown";
  const branch = footerData?.getGitBranch() ?? "not a git checkout";
  const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow;
  const contextValue =
    usage.tokens === undefined
      ? `unknown / ${formatTokens(contextWindow)}`
      : `${formatTokens(usage.tokens)} / ${formatTokens(contextWindow)}`;
  const percent = usage.percent === null || usage.percent === undefined ? "unknown" : `${usage.percent.toFixed(1)}%`;
  const reasoning = !ctx.model
    ? "n/a (no model selected)"
    : ctx.model.reasoning === false
      ? "off (model does not support reasoning)"
      : pi.getThinkingLevel();

  const lines = [
    field("Directory", ctx.cwd, theme),
    field("Session name", sessionName(ctx), theme),
    field("Session ID", id, theme),
    field("Session file", file, theme),
    field("Git branch", branch, theme),
    "",
    field("Model", ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model", theme),
    field("Reasoning", reasoning, theme),
    field("Context", `${contextValue} (${percent})`, theme),
    field("Providers", String(footerData?.getAvailableProviderCount() ?? "unknown"), theme),
    "",
    field("Input tokens", formatTokens(totals.input), theme),
    field("Output tokens", formatTokens(totals.output), theme),
    field("Cache read/write", `${formatTokens(totals.cacheRead)} / ${formatTokens(totals.cacheWrite)}`, theme),
    field("Cost", `$${totals.cost.toFixed(3)}`, theme),
    field("Entries", String(ctx.sessionManager.getEntries().length), theme),
    field("Tools", `${activeTools.length}/${allTools.length} active · ${activeTools.join(", ") || "none"}`, theme),
  ];

  if (statuses.length > 0) {
    lines.push("", theme.fg("muted", " Extension status "));
    for (const [key, value] of statuses) lines.push(field(key, sanitize(value), theme));
  }

  return lines;
}

function field(label: string, value: unknown, theme: Theme): string {
  return `${theme.fg("muted", `${label.padEnd(17)} `)}${theme.fg("text", String(value))}`;
}

function panel(lines: string[], width: number, theme: Theme): string[] {
  if (width < 4) return lines.map((line) => truncateToWidth(line, width));
  const innerWidth = width - 2;
  const border = (text: string) => theme.fg("borderAccent", text);
  const row = (line: string) => {
    const fitted = truncateToWidth(line, innerWidth, "…");
    return `${border("│")}${fitted}${" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))}${border("│")}`;
  };
  return [border(`╭${"─".repeat(innerWidth)}╮`), ...lines.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
}

function contextUsage(ctx: ExtensionContext): Usage {
  return (ctx.getContextUsage?.() ?? {}) as Usage;
}

function formatContext(ctx: ExtensionContext): string {
  const usage = contextUsage(ctx);
  const window = usage.contextWindow ?? ctx.model?.contextWindow;
  return `ctx ${formatTokens(usage.tokens)}/${formatTokens(window)}`;
}

function colorContext(text: string, ctx: ExtensionContext, theme: Theme): string {
  const percent = contextUsage(ctx).percent;
  if (typeof percent === "number" && percent > 90) return theme.fg("error", text);
  if (typeof percent === "number" && percent > 70) return theme.fg("warning", text);
  return theme.fg("muted", text);
}

function usageTotals(ctx: ExtensionContext): Totals {
  const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage ?? {};
    totals.input += finite(usage.input);
    totals.output += finite(usage.output);
    totals.cacheRead += finite(usage.cacheRead);
    totals.cacheWrite += finite(usage.cacheWrite);
    totals.cost += finite(usage.cost?.total);
  }
  return totals;
}

function sessionName(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionName?.() || "unnamed";
}

function formatDirectory(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "?";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function reasoningColor(
  level: string,
): "thinkingOff" | "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax" {
  switch (level) {
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
    default:
      return "thinkingOff";
  }
}

function isKey(data: string, key: string, raw: string): boolean {
  return data === raw || matchesKey(data, key);
}

function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
