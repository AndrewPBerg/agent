import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_FALLBACK_RETRY_MS = 30_000;
const DEFAULT_MAX_ONLINE_FALLBACK_ATTEMPTS = 3;
const MAX_FALLBACK_RETRY_MS = 5 * 60_000;
const MAILBOX_TYPE = "network-resume";
const WAIT_STATE_TYPE = "network-resume-state";

const NETWORK_ERROR_PATTERN = new RegExp(
  [
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "socket connection was closed",
    "timed? out",
    "timeout",
    "terminated",
    "websocket.?closed",
    "websocket.?error",
    "ended without",
    "http2 request did not get a response",
    "http.?[12]?.*(connection|stream|request).*(closed|reset|failed|timed? out)",
    "econnreset",
    "enetunreach",
    "ehostunreach",
    "getaddrinfo",
  ].join("|"),
  "i",
);

const RESUME_MESSAGE =
  "Network connectivity has returned. Continue the interrupted task from the last successful step. Do not repeat completed tool side effects.";

type UnknownRecord = Record<string, unknown>;

type NetworkConnectivity = "online" | "offline" | "unknown";

type NetworkResumeOptions = {
  /** Compatibility seam for callers that only distinguish online from offline. */
  checkOnline?: () => Promise<boolean>;
  /** Preferred seam: `unknown` permits bounded retries when NetworkManager is unavailable. */
  checkConnectivity?: () => Promise<NetworkConnectivity>;
  pollMs?: number;
  fallbackRetryMs?: number;
  maxOnlineFallbackAttempts?: number;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function finalAssistantMessage(event: unknown): UnknownRecord | undefined {
  const messages = asRecord(event)?.messages;
  if (!Array.isArray(messages)) return undefined;

  return [...messages]
    .reverse()
    .map(asRecord)
    .find((message) => message?.role === "assistant");
}

export function stoppedForNetwork(event: unknown): boolean {
  const message = finalAssistantMessage(event);
  return message?.stopReason === "error" && NETWORK_ERROR_PATTERN.test(String(message.errorMessage ?? ""));
}

/**
 * OS-level connectivity gate. NetworkManager's `full` state means it verified
 * an Internet route; its other successful states mean offline. A missing or
 * failed `nmcli` probe is unknown rather than an indefinitely-offline host.
 */
export function networkManagerConnectivity(): Promise<NetworkConnectivity> {
  return new Promise((resolve) => {
    execFile("nmcli", ["-t", "-f", "CONNECTIVITY", "general"], { timeout: 3_000 }, (error, stdout) => {
      if (error) resolve("unknown");
      else resolve(stdout.trim() === "full" ? "online" : "offline");
    });
  });
}

/** @deprecated Prefer {@link networkManagerConnectivity} to retain unknown state. */
export async function networkManagerIsOnline(): Promise<boolean> {
  return (await networkManagerConnectivity()) === "online";
}

export function createNetworkResume(options: NetworkResumeOptions = {}) {
  const checkConnectivity =
    options.checkConnectivity ??
    (options.checkOnline
      ? async (): Promise<NetworkConnectivity> => ((await options.checkOnline!()) ? "online" : "offline")
      : networkManagerConnectivity);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const fallbackRetryMs = options.fallbackRetryMs ?? DEFAULT_FALLBACK_RETRY_MS;
  const maxOnlineFallbackAttempts = options.maxOnlineFallbackAttempts ?? DEFAULT_MAX_ONLINE_FALLBACK_ATTEMPTS;

  return function networkResume(pi: ExtensionAPI) {
    let lastRunHadNetworkError = false;
    let waiting = false;
    let observedOffline = false;
    let fallbackAttempt = 0;
    let fallbackAt = 0;
    let probeInFlight = false;
    let waitGeneration = 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    function persistWaitState(armed: boolean) {
      pi.appendEntry(WAIT_STATE_TYPE, { version: 1, armed });
    }

    function restoredWaitState(ctx: ExtensionContext): boolean {
      const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index] as { type?: string; customType?: string; data?: { version?: unknown; armed?: unknown } };
        if (
          entry.type === "custom" &&
          entry.customType === WAIT_STATE_TYPE &&
          entry.data?.version === 1 &&
          typeof entry.data.armed === "boolean"
        ) {
          return entry.data.armed;
        }
      }
      return false;
    }

    function clearTimer() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    }

    function stopWaiting(ctx: ExtensionContext, persist = true) {
      const wasWaiting = waiting;
      waitGeneration++;
      waiting = false;
      probeInFlight = false;
      clearTimer();
      if (persist && wasWaiting) persistWaitState(false);
      ctx.ui.setStatus("network-resume", undefined);
    }

    function pushResumeMailbox() {
      // A follow-up message is the mailbox: it wakes an otherwise-idle parent
      // session without trying to resume from the timer callback itself.
      pi.sendMessage(
        {
          customType: MAILBOX_TYPE,
          content: RESUME_MESSAGE,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }

    function resume(ctx: ExtensionContext, generation: number) {
      if (!waiting || generation !== waitGeneration) return;
      waitGeneration++;
      waiting = false;
      probeInFlight = false;
      clearTimer();
      fallbackAttempt++;
      persistWaitState(false);
      ctx.ui.setStatus("network-resume", "network restored; resuming");
      pushResumeMailbox();
    }

    async function probe(ctx: ExtensionContext, generation: number) {
      if (!waiting || generation !== waitGeneration || probeInFlight) return;
      probeInFlight = true;
      let connectivity: NetworkConnectivity = "unknown";
      try {
        connectivity = await checkConnectivity();
      } catch {
        // A failed OS probe cannot prove connectivity; use the bounded fallback.
      }
      if (generation !== waitGeneration) return;
      probeInFlight = false;
      if (!waiting) return;

      if (connectivity === "offline") {
        observedOffline = true;
        fallbackAttempt = 0;
        ctx.ui.setStatus("network-resume", "offline; auto-resume armed");
        return;
      }

      if (connectivity === "unknown") ctx.ui.setStatus("network-resume", "network status unavailable; retry armed");
      if (observedOffline || Date.now() >= fallbackAt) resume(ctx, generation);
    }

    async function beginWaiting(ctx: ExtensionContext) {
      if (waiting) return;

      const generation = ++waitGeneration;
      waiting = true;
      observedOffline = false;
      persistWaitState(true);
      const fallbackDelay = Math.min(fallbackRetryMs * 2 ** fallbackAttempt, MAX_FALLBACK_RETRY_MS);
      fallbackAt = fallbackAttempt < maxOnlineFallbackAttempts ? Date.now() + fallbackDelay : Number.POSITIVE_INFINITY;
      ctx.ui.setStatus("network-resume", "connection lost; waiting for network");
      await probe(ctx, generation);
      if (!waiting || generation !== waitGeneration) return;
      pollTimer = setInterval(() => void probe(ctx, generation), pollMs);
    }

    pi.on("agent_end", (event, ctx) => {
      lastRunHadNetworkError = stoppedForNetwork(event);
      if (!lastRunHadNetworkError) {
        fallbackAttempt = 0;
        stopWaiting(ctx);
      }
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (ctx.mode === "tui" && lastRunHadNetworkError && ctx.isIdle()) await beginWaiting(ctx);
    });

    pi.on("agent_start", (_event, ctx) => {
      if (waiting) stopWaiting(ctx);
    });

    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode === "tui" && restoredWaitState(ctx)) void beginWaiting(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      lastRunHadNetworkError = false;
      // Keep the latest armed state so a restarted Pi can recreate the worker.
      stopWaiting(ctx, false);
    });
  };
}

export default createNetworkResume();
