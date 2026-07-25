import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentJob } from "./index";

type TuiLike = { requestRender: () => void };
type InspectorSubscription = (listener: () => void) => () => void;

function elapsed(startedAt: number, completedAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor(((completedAt ?? now) - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes < 60 ? `${minutes}m ${remainder}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function oneLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() || "—";
}

function jobSection(job: AgentJob): "Active" | "Pending" | "Previous" {
  if (job.status === "running") return "Active";
  if (job.status === "launching") return "Pending";
  return "Previous";
}

function sortedJobs(jobs: Iterable<AgentJob>): AgentJob[] {
  const rank = { Active: 0, Pending: 1, Previous: 2 } as const;
  return [...jobs].sort((left, right) => {
    const sectionOrder = rank[jobSection(left)] - rank[jobSection(right)];
    return sectionOrder || right.startedAt - left.startedAt;
  });
}

export class SubagentInspector {
  private selectedId?: string;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: Theme,
    private readonly getJobs: () => Iterable<AgentJob>,
    private readonly getCap: () => number,
    subscribe: InspectorSubscription,
    private readonly done: () => void,
  ) {
    this.unsubscribe = subscribe(() => this.tui.requestRender());
    this.timer = setInterval(() => this.tui.requestRender(), 1_000);
    this.timer.unref();
  }

  handleInput(data: string): void {
    const jobs = sortedJobs(this.getJobs());
    const selected = Math.max(
      0,
      jobs.findIndex((job) => job.id === this.selectedId),
    );
    if (data === "q" || data === "\u001b" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if ((data === "k" || matchesKey(data, "up")) && jobs.length) {
      this.selectedId = jobs[Math.max(0, selected - 1)]?.id;
      this.tui.requestRender();
    } else if ((data === "j" || matchesKey(data, "down")) && jobs.length) {
      this.selectedId = jobs[Math.min(jobs.length - 1, selected + 1)]?.id;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const now = Date.now();
    const jobs = sortedJobs(this.getJobs());
    if (!jobs.some((job) => job.id === this.selectedId)) this.selectedId = jobs[0]?.id;
    const selectedIndex = Math.max(
      0,
      jobs.findIndex((job) => job.id === this.selectedId),
    );
    const selected = jobs[selectedIndex];
    const running = jobs.filter((job) => job.status === "running").length;
    const launching = jobs.filter((job) => job.status === "launching").length;
    const innerWidth = Math.max(1, width - 2);
    const border = (value: string) => this.theme.fg("border", value);
    const row = (value = "") => {
      const clipped = truncateToWidth(value, innerWidth, "…");
      return border("│") + clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))) + border("│");
    };
    const title = truncateToWidth(` Mailbox monitor · ${running} active · ${launching} pending · cap ${this.getCap()} `, innerWidth, "");
    const titleFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
    const lines = [border("╭") + this.theme.fg("accent", title) + border(`${titleFill}╮`)];

    if (!jobs.length) {
      lines.push(row(" No mailbox jobs have run in this session."));
    } else {
      const maxVisible = Math.min(7, jobs.length);
      const first = Math.min(Math.max(0, selectedIndex - Math.floor(maxVisible / 2)), jobs.length - maxVisible);
      let section: ReturnType<typeof jobSection> | undefined;
      for (let index = first; index < first + maxVisible; index += 1) {
        const job = jobs[index]!;
        const nextSection = jobSection(job);
        if (nextSection !== section) {
          section = nextSection;
          lines.push(row(this.theme.fg("muted", ` ${section}`)));
        }
        const active = job.id === this.selectedId;
        const marker = active ? this.theme.fg("accent", "›") : " ";
        const statusColor =
          job.status === "completed" ? "success" : job.status === "running" || job.status === "launching" ? "warning" : "error";
        const status = this.theme.fg(statusColor, job.status);
        lines.push(row(` ${marker} ${status}  ${job.agent}  ${elapsed(job.startedAt, job.completedAt, now)}  ${job.id}`));
      }
    }

    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    if (selected) {
      lines.push(row(` Agent: ${this.theme.fg("accent", selected.agent)}  Status: ${selected.status}`));
      lines.push(row(` Task: ${oneLine(selected.task)}`));
      lines.push(row(` Cwd: ${selected.cwd}`));
      lines.push(
        row(
          ` Usage: ${selected.usage.turns} turns · ${selected.usage.input} in · ${selected.usage.output} out · $${selected.usage.cost.toFixed(4)}`,
        ),
      );
      if (selected.error) lines.push(row(` Error: ${this.theme.fg("error", oneLine(selected.error))}`));
      else if (selected.output) lines.push(row(` Result: ${oneLine(selected.output)}`));
    } else {
      lines.push(row(" Cap can be changed with /subagent-cap <int>."));
    }
    lines.push(row(this.theme.fg("dim", " j/k or ↑/↓ select · live updates · q/Esc close")));
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
}

export async function showSubagentInspector(
  ctx: ExtensionContext,
  getJobs: () => Iterable<AgentJob>,
  getCap: () => number,
  subscribe: InspectorSubscription,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Subagent inspector requires interactive mode.", "warning");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SubagentInspector(tui, theme, getJobs, getCap, subscribe, done), {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "80%",
      minWidth: 60,
      maxHeight: "80%",
      margin: 2,
    },
  });
}
