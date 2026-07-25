import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { filterSessionTitleMessagesFromContext, SESSION_TITLE_MESSAGE_TYPE } from "./title-context.js";

export { SESSION_TITLE_MESSAGE_TYPE } from "./title-context.js";

type SessionTitleMessageDetails = {
  actor: string;
  message: string;
  timestamp: number;
  source: "auto" | "manual";
  temporary?: boolean;
};

function toneFor(details: SessionTitleMessageDetails): "warning" | "accent" {
  return details.temporary ? "warning" : "accent";
}

function actorLabel(actor: string): string {
  const slash = actor.indexOf("/");
  return slash >= 0 ? actor.slice(slash + 1) : actor;
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderSessionTitleMessage(theme: Theme, details: SessionTitleMessageDetails, content: string): string {
  const tone = toneFor(details);
  const source = details.source === "manual" ? "manual" : "auto";
  const temporary = details.temporary ? " temporary" : "";
  const time = formatTime(details.timestamp);
  const suffix = [source + temporary, actorLabel(details.actor), time].filter(Boolean).join(" · ");
  return `${theme.fg(tone, "Session title")} ${theme.fg("dim", suffix)}\n${content}`;
}

export function registerSessionTitleMessageRenderer(pi: ExtensionAPI): void {
  pi.on("context", (event) => {
    const messages = filterSessionTitleMessagesFromContext(event.messages);
    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.registerMessageRenderer(SESSION_TITLE_MESSAGE_TYPE, (message, _options, theme) => {
    const details = (message.details ?? {}) as SessionTitleMessageDetails;
    const content = details.message ?? (typeof message.content === "string" ? message.content : "");
    return new Text(renderSessionTitleMessage(theme, details, content), 0, 0);
  });
}

type EmitSessionTitleMessageArgs = {
  title: string;
  actor: string;
  source: "auto" | "manual";
  temporary?: boolean;
};

type EmitSessionTitleMessageOptions = {
  ctx?: Pick<ExtensionContext, "isIdle">;
  pollMs?: number;
  maxWaitMs?: number;
};

function buildSessionTitleMessage(args: EmitSessionTitleMessageArgs) {
  const title = args.title || "(cleared session title)";
  const message = `Session renamed to: \`${title}\``;
  return {
    customType: SESSION_TITLE_MESSAGE_TYPE,
    content: message,
    display: true,
    details: {
      actor: args.actor,
      message,
      source: args.source,
      temporary: args.temporary === true,
      timestamp: Date.now(),
    } satisfies SessionTitleMessageDetails,
  };
}

export function emitSessionTitleMessage(
  pi: ExtensionAPI,
  args: EmitSessionTitleMessageArgs,
  options: EmitSessionTitleMessageOptions = {},
): void {
  const appMessage = buildSessionTitleMessage(args);
  const { ctx, pollMs = 100, maxWaitMs = 30_000 } = options;
  const started = Date.now();

  const send = (deferToNextTurn = false): void => {
    try {
      pi.sendMessage(appMessage, deferToNextTurn ? { deliverAs: "nextTurn" } : undefined);
    } catch (error) {
      console.warn(`[session-title] failed to emit title message: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (!ctx || ctx.isIdle()) {
    send();
    return;
  }

  const waitForIdle = (): void => {
    if (ctx.isIdle()) {
      send();
      return;
    }
    if (Date.now() - started >= maxWaitMs) {
      send(true);
      return;
    }
    setTimeout(waitForIdle, pollMs).unref?.();
  };
  setTimeout(waitForIdle, pollMs).unref?.();
}
