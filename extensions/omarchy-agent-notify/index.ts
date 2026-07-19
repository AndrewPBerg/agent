import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Vol_percent } from "../../constants.ts";

const APP_NAME = "Pi";
const ICON = "utilities-terminal";
const EXPIRE_MS = "15000";
const MAX_BODY_CHARS = 420;
const MAX_SUMMARY_CHARS = 220;
const PI_AGENT_DIR = `${process.env.HOME ?? homedir()}/.pi/agent`;
const DONE_SOUND_DIR = `${PI_AGENT_DIR}/notification-mp3s`;
const FOCUS_WINDOW_FILE = `${PI_AGENT_DIR}/last-notify-window`;
const SOUND_SUPPRESSING_MAKO_MODES = new Set(["do-not-disturb", "voxtype-muted"]);
const NORMALIZE_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11";
const NOTIFICATION_VOLUME_PERCENT = Math.max(0, Math.min(100, Vol_percent));
const NOTIFICATION_VOLUME = NOTIFICATION_VOLUME_PERCENT / 100;

type NotifyUrgency = "low" | "normal" | "critical";
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function activeWindowAddress(): string | undefined {
  try {
    const active = JSON.parse(execFileSync("hyprctl", ["activewindow", "-j"], { encoding: "utf8" }));
    const address = asRecord(active)?.address;
    return typeof address === "string" ? address : undefined;
  } catch {
    return undefined;
  }
}

function rememberFocusWindow(address: string | undefined): void {
  try {
    writeFileSync(FOCUS_WINDOW_FILE, address ?? "", "utf8");
  } catch {}
}

function piNotificationSoundMuted(): boolean {
  try {
    const modes = execFileSync("makoctl", ["mode"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((mode) => mode.trim())
      .filter(Boolean);
    return modes.some((mode) => SOUND_SUPPRESSING_MAKO_MODES.has(mode));
  } catch {
    return false;
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd === home) return "~";
  if (home && cwd.startsWith(`${home}/`)) return `~/${basename(cwd)}`;
  return cwd;
}

function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function messageOf(value: unknown): UnknownRecord | undefined {
  return asRecord(asRecord(value)?.message ?? value);
}

function contentText(message: UnknownRecord | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolNameFromPart(part: unknown): string | undefined {
  const record = asRecord(part);
  return record?.type === "toolCall" && typeof record.name === "string" ? record.name : undefined;
}

function toolArgsFromPart(part: unknown): UnknownRecord | undefined {
  const record = asRecord(part);
  return record?.type === "toolCall" ? asRecord(record.arguments) : undefined;
}

function compactPath(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  const home = process.env.HOME;
  const compact = home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  const parts = compact.split("/");
  return parts.length <= 3 ? compact : `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function summarizeToolCounts(counts: Map<string, number>): string | undefined {
  if (counts.size === 0) return undefined;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name, count]) => (count === 1 ? name : `${name}×${count}`))
    .join(", ");
}

function collectStats(messages: unknown[]) {
  const toolCounts = new Map<string, number>();
  const changedPaths = new Set<string>();
  let toolErrors = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let finalAssistant: UnknownRecord | undefined;

  for (const item of messages) {
    const message = messageOf(item);
    if (!message) continue;

    if (message.role === "toolResult" && message.isError) toolErrors += 1;
    if (message.role !== "assistant") continue;

    finalAssistant = message;
    const usage = asRecord(message.usage);
    if (typeof usage?.totalTokens === "number") totalTokens += usage.totalTokens;
    const cost = asRecord(usage?.cost);
    if (typeof cost?.total === "number") totalCost += cost.total;

    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const toolName = toolNameFromPart(part);
      if (!toolName) continue;
      increment(toolCounts, toolName);

      if (toolName === "write" || toolName === "edit") {
        const path = compactPath(toolArgsFromPart(part)?.path);
        if (path) changedPaths.add(path);
      }
    }
  }

  return { toolCounts, changedPaths, toolErrors, totalTokens, totalCost, finalAssistant };
}

function formatCost(cost: number): string | undefined {
  if (!cost) return undefined;
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string | undefined {
  if (!tokens) return undefined;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tok` : `${tokens} tok`;
}

function finalAssistantMessage(event: unknown): UnknownRecord | undefined {
  const messages = Array.isArray(asRecord(event)?.messages) ? (asRecord(event)?.messages as unknown[]) : [];
  return [...messages]
    .reverse()
    .map(messageOf)
    .find((message) => message?.role === "assistant");
}

function wasCancelled(event: unknown, ctx: ExtensionContext): boolean {
  if ((ctx as ExtensionContext & { signal?: AbortSignal }).signal?.aborted) return true;

  const messages = Array.isArray(asRecord(event)?.messages) ? (asRecord(event)?.messages as unknown[]) : [];
  if (messages.length === 0) return true;

  const finalAssistant = finalAssistantMessage(event);
  const cancelWords = ["abort", "aborted", "cancel", "cancelled", "canceled", "interrupted"];
  const stopReason = String(finalAssistant?.stopReason ?? "").toLowerCase();
  const errorMessage = String(finalAssistant?.errorMessage ?? "").toLowerCase();
  return cancelWords.includes(stopReason) || cancelWords.some((word) => errorMessage.includes(word));
}

function stoppedWithError(event: unknown): boolean {
  return finalAssistantMessage(event)?.stopReason === "error";
}

function buildNotification(event: unknown, ctx: ExtensionContext, elapsed?: string) {
  const messages = Array.isArray(asRecord(event)?.messages) ? (asRecord(event)?.messages as unknown[]) : [];
  const stats = collectStats(messages);
  const finalText = truncate(oneLine(contentText(stats.finalAssistant)), MAX_SUMMARY_CHARS);
  const hardError = stats.finalAssistant?.stopReason === "error";
  const where = shortCwd(ctx.cwd);

  const meta: string[] = [];
  const tools = summarizeToolCounts(stats.toolCounts);
  if (tools) meta.push(`tools: ${tools}`);
  if (stats.toolErrors) meta.push(`tool errors: ${stats.toolErrors}`);
  const cost = formatCost(stats.totalCost);
  const tokens = formatTokens(stats.totalTokens);
  if (cost || tokens) meta.push([cost, tokens].filter(Boolean).join(" / "));

  const changed = [...stats.changedPaths].slice(0, 3).join(", ");
  const lines = [
    finalText || (hardError ? "Stopped with an error." : "Ready for input."),
    changed ? `changed: ${changed}` : undefined,
    meta.length ? meta.join(" · ") : undefined,
  ].filter(Boolean) as string[];

  return {
    title: `${hardError ? "Pi needs attention" : "Pi finished"} · ${[where, elapsed].filter(Boolean).join(" · ")}`,
    body: truncate(lines.join("\n"), MAX_BODY_CHARS),
    urgency: hardError ? ("critical" as const) : stats.toolErrors ? ("normal" as const) : ("low" as const),
  };
}

function randomDoneSound(): string | undefined {
  try {
    if (!existsSync(DONE_SOUND_DIR)) return undefined;
    const files = readdirSync(DONE_SOUND_DIR)
      .filter((file) => file.toLowerCase().endsWith(".mp3"))
      .map((file) => `${DONE_SOUND_DIR}/${file}`);
    return files.length ? files[Math.floor(Math.random() * files.length)] : undefined;
  } catch {
    return undefined;
  }
}

function spawnSound(script: string, args: string[]): void {
  const child = spawn("bash", ["-lc", script, "pi-done-sound", ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function playDoneSound(urgency: NotifyUrgency): void {
  if (piNotificationSoundMuted()) return;

  const doneSound = randomDoneSound();
  const eventId = urgency === "critical" ? "dialog-warning" : "complete";
  if (doneSound) {
    spawnSound(
      [
        "sink=$(pactl get-default-sink 2>/dev/null || true)",
        'if [ -n "$sink" ]; then pactl suspend-sink "$sink" false >/dev/null 2>&1 || true; fi',
        "if command -v ffmpeg >/dev/null 2>&1 && command -v pw-play >/dev/null 2>&1; then",
        `  ffmpeg -v error -i "$1" -af ${NORMALIZE_FILTER} -f wav - 2>/dev/null | pw-play --target "\${sink:-@DEFAULT_AUDIO_SINK@}" --media-role Notification --volume ${NOTIFICATION_VOLUME} - && exit 0`,
        "fi",
        `if command -v mpv >/dev/null 2>&1 && timeout 8s mpv --no-config --no-video --really-quiet --ao=pipewire,pulse --audio-client-name="Pi agent notification" '--af=lavfi=[${NORMALIZE_FILTER}]' --volume=${NOTIFICATION_VOLUME_PERCENT} "$1"; then exit 0; fi`,
        'exec canberra-gtk-play --id "$2" --description "Pi agent finished"',
      ].join("\n"),
      [doneSound, eventId],
    );
    return;
  }

  spawnSound('exec canberra-gtk-play --id "$1" --description "Pi agent finished"', [eventId]);
}

function notify(title: string, body: string, urgency: NotifyUrgency): void {
  const child = spawn(
    "notify-send",
    ["--app-name", APP_NAME, "--icon", ICON, "--urgency", urgency, "--expire-time", urgency === "critical" ? "0" : EXPIRE_MS, title, body],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", () => {});
  child.unref();
}

export default function omarchyAgentNotify(pi: ExtensionAPI) {
  let startedAt: number | null = null;
  let startWindowAddress: string | undefined;

  pi.on("agent_start", () => {
    startedAt = Date.now();
    startWindowAddress = activeWindowAddress();
  });

  pi.on("agent_end", async (event, ctx: ExtensionContext) => {
    const elapsed = startedAt === null ? undefined : formatDuration(Date.now() - startedAt);
    const targetWindowAddress = startWindowAddress;
    startedAt = null;
    startWindowAddress = undefined;

    if (wasCancelled(event, ctx)) return;
    if (stoppedWithError(event)) return;
    if (targetWindowAddress && activeWindowAddress() === targetWindowAddress) return;

    const notification = buildNotification(event, ctx, elapsed);
    rememberFocusWindow(targetWindowAddress);
    playDoneSound(notification.urgency);
    notify(notification.title, notification.body, notification.urgency);
  });

  pi.registerCommand("pi-notify-test", {
    description: "Send a test Pi desktop notification and sound",
    handler: async (_args, ctx) => {
      playDoneSound("low");
      rememberFocusWindow(activeWindowAddress());
      notify(
        `Pi finished · ${shortCwd(ctx.cwd)} · 42s`,
        "Example final answer excerpt appears here.\nchanged: ~/.pi/…/omarchy-agent-notify.ts\ntools: read, edit, bash×2 · $0.03 / 41k tok",
        "low",
      );
      ctx.ui.notify("Sent rich desktop notification + sound", "info");
    },
  });
}
