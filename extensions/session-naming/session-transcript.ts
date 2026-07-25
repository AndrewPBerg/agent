import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type SessionTranscriptOptions = {
  maxMessageCount: number;
  includeTools: boolean;
};

function firstTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function textifySessionEntry(entry: SessionEntry, options: Pick<SessionTranscriptOptions, "includeTools">): string | undefined {
  if (entry.type !== "message") return undefined;
  const m = entry.message;
  if (m.role === "user") return `[user] ${firstTextContent(m.content)}`;
  if (m.role === "assistant") return `[assistant] ${firstTextContent(m.content)}`;
  if (m.role === "toolResult" && options.includeTools) return `[tool:${m.toolName}] ${firstTextContent(m.content)}`;
  return undefined;
}

export function formatSessionTranscript(branch: SessionEntry[], options: SessionTranscriptOptions): string {
  const textEntries = branch.map((entry) => textifySessionEntry(entry, options)).filter((text): text is string => Boolean(text?.trim()));
  const maxMessageCount = Math.floor(options.maxMessageCount);
  const selected = maxMessageCount > 0 ? textEntries.slice(-maxMessageCount) : textEntries;
  return selected.join("\n");
}

export function buildSessionTranscriptBlock(branch: SessionEntry[], options: SessionTranscriptOptions): string | undefined {
  const transcript = formatSessionTranscript(branch, options);
  return transcript ? `<session-transcript>\n${transcript}\n</session-transcript>` : undefined;
}
