import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type CodexAuth = {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
};

type UsageWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

type RateLimit = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
};

type CodexUsage = {
  email?: string;
  plan_type?: string;
  rate_limit?: RateLimit | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    metered_feature?: string;
    rate_limit?: RateLimit | null;
  }> | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | null;
  } | null;
  spend_control?: {
    reached?: boolean;
    individual_limit?: {
      limit?: string;
      used?: string;
      remaining_percent?: number;
      reset_after_seconds?: number;
      reset_at?: number;
    } | null;
  } | null;
  rate_limit_reset_credits?: {
    available_count?: number;
  } | null;
};

const WIDGET_ID = "codex-status";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AUTO_CLOSE_MS = 10_000;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function authPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

async function readAuth(): Promise<CodexAuth> {
  return JSON.parse(await readFile(authPath(), "utf8"));
}

function refreshCodexAuthBestEffort() {
  spawnSync("codex", ["login", "status"], { stdio: "ignore", timeout: 15_000 });
}

async function fetchUsage(): Promise<CodexUsage> {
  let auth = await readAuth();
  let response = await fetchUsageWithAuth(auth);
  if (response.status === 401 || response.status === 403) {
    refreshCodexAuthBestEffort();
    auth = await readAuth();
    response = await fetchUsageWithAuth(auth);
  }
  if (!response.ok) throw new Error(`Codex usage request failed: HTTP ${response.status}`);
  return (await response.json()) as CodexUsage;
}

async function fetchUsageWithAuth(auth: CodexAuth): Promise<Response> {
  if (auth.auth_mode !== "chatgpt") throw new Error("Codex is not logged in with ChatGPT. Run `codex login` first.");
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) throw new Error("Codex ChatGPT access token not found. Run `codex login` first.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "user-agent": "codex-cli",
    };
    if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
    return await fetch(USAGE_URL, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function redactEmail(email?: string): string {
  if (!email || !email.includes("@")) return "unknown";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function leftPercent(n?: number): number | undefined {
  return typeof n === "number" ? Math.max(0, Math.min(100, 100 - n)) : undefined;
}

function fmtLeft(n?: number): string {
  const left = leftPercent(n);
  return typeof left === "number" ? `${left}% left` : "left unknown";
}

function meter(n?: number): string {
  const left = leftPercent(n);
  if (typeof left !== "number") return "[??????????]";
  const filled = Math.round(left / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}

function fmtDuration(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "unknown";
  const mins = Math.max(0, Math.round(seconds / 60));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (remMins || parts.length === 0) parts.push(`${remMins}m`);
  return parts.join(" ");
}

function fmtWindow(label: string, window?: UsageWindow | null): string {
  if (!window) return `  ${label}: n/a`;
  const windowLen = fmtDuration(window.limit_window_seconds);
  const reset = fmtDuration(window.reset_after_seconds);
  return `  ${label}: ${meter(window.used_percent)} ${fmtLeft(window.used_percent)} · resets in ${reset} · ${windowLen} window`;
}

function fmtLimit(name: string, limit?: RateLimit | null): string[] {
  const state = limit?.limit_reached ? "LIMIT REACHED" : limit?.allowed === false ? "blocked" : "ok";
  return [`${name}: ${state}`, fmtWindow("5h", limit?.primary_window), fmtWindow("7d", limit?.secondary_window)];
}

function buildLines(data: CodexUsage): string[] {
  const lines = [
    `Codex status (${data.plan_type || "unknown"}) · ${redactEmail(data.email)} · closes in 10s`,
    ...fmtLimit("Codex", data.rate_limit),
  ];

  const additional = data.additional_rate_limits || [];
  for (const item of additional.slice(0, 2)) {
    lines.push(...fmtLimit(item.limit_name || item.metered_feature || "Additional", item.rate_limit));
  }
  if (additional.length > 2) lines.push(`… ${additional.length - 2} more additional limits`);

  lines.push(
    `Credits: ${data.credits?.unlimited ? "unlimited" : data.credits?.has_credits ? `balance ${data.credits.balance ?? "unknown"}` : "none"} · reset credits: ${data.rate_limit_reset_credits?.available_count ?? 0}`,
  );

  if (data.spend_control?.individual_limit) {
    const limit = data.spend_control.individual_limit;
    lines.push(`Spend: ${limit.used ?? "?"}/${limit.limit ?? "?"} used · ${limit.remaining_percent ?? "?"}% remaining`);
  } else if (data.spend_control?.reached) {
    lines.push("Spend: reached");
  }

  lines.push("Usage: https://chatgpt.com/codex/settings/usage");
  return lines.slice(0, 12);
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

class CodexStatusWidget {
  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(width: number): string[] {
    const outerWidth = Math.max(24, Math.min(Math.max(width - 2, 24), 118));
    const innerWidth = outerWidth - 4;
    const border = "─".repeat(outerWidth - 2);
    const body = this.lines.map((line) => {
      const text = truncate(line, innerWidth);
      return `│ ${text.padEnd(innerWidth, " ")} │`;
    });
    return [`╭${border}╮`, ...body, `╰${border}╯`];
  }

  invalidate() {}
}

function clearStatus(ui: ExtensionCommandContext["ui"]) {
  ui.setWidget(WIDGET_ID, undefined);
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

function armAutoClose(ctx: ExtensionCommandContext) {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => clearStatus(ctx.ui), AUTO_CLOSE_MS);
}

async function showCodexStatus(_args: string, ctx: ExtensionCommandContext) {
  const lines = buildLines(await fetchUsage());
  if (ctx.hasUI) {
    ctx.ui.setWidget(WIDGET_ID, () => new CodexStatusWidget(lines), { placement: "aboveEditor" });
    armAutoClose(ctx);
  } else {
    console.log(lines.join("\n"));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", (_event, ctx) => {
    clearStatus(ctx.ui);
  });

  pi.registerCommand("status", {
    description: "Show Codex subscription usage and remaining rate limits",
    handler: showCodexStatus,
  });

  pi.registerCommand("usage", {
    description: "Show Codex subscription usage and remaining rate limits",
    handler: showCodexStatus,
  });
}
