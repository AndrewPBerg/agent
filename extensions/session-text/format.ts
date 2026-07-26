import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SESSION_CLIPBOARD_WARNING_BYTES = 32 * 1024 * 1024;

const DOCUMENT_CHUNK_CODE_UNITS = 64 * 1024;

export type SessionDocumentMode = "readable" | "raw";
type DocumentSection = { heading?: string; body: string };
type ToolCallView = { name: string; arguments: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanTerminalText(text: string): string {
  return stripVTControlCharacters(text);
}

function joinExactParts(parts: readonly string[]): string {
  let result = "";
  let hasPart = false;
  for (const part of parts) {
    if (!part) continue;
    if (hasPart && !result.endsWith("\n") && !part.startsWith("\n")) result += "\n";
    result += part;
    hasPart = true;
  }
  return result;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []));
}

function textContent(content: unknown): string {
  return textParts(content).join("");
}

function toolCalls(content: unknown): ToolCallView[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") return [];
    return [{ name: part.name, arguments: isRecord(part.arguments) ? part.arguments : {} }];
  });
}

function bashCommands(content: unknown): string[] {
  return toolCalls(content).flatMap((call) => {
    const command = call.arguments.command;
    return call.name === "bash" && typeof command === "string" ? [command] : [];
  });
}

function lineRecords(text: string): Array<{ text: string; start: number; endWithNewline: number }> {
  const records: Array<{ text: string; start: number; endWithNewline: number }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const endWithNewline = newline < 0 ? text.length : newline + 1;
    const end = newline < 0 ? text.length : newline;
    records.push({ text: text.slice(start, end).replace(/\r$/, ""), start, endWithNewline });
    start = endWithNewline;
  }
  if (text.length === 0) records.push({ text: "", start: 0, endWithNewline: 0 });
  return records;
}

function soleFencedCodeBody(text: string): string | undefined {
  const lines = lineRecords(text);
  const first = lines.findIndex((line) => line.text.trim().length > 0);
  if (first < 0) return undefined;
  let last = lines.length - 1;
  while (last > first && lines[last]?.text.trim().length === 0) last -= 1;

  const opener = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(lines[first]?.text ?? "");
  if (!opener) return undefined;
  const marker = opener[1] ?? "";
  if (marker.startsWith("`") && (opener[2] ?? "").includes("`")) return undefined;

  const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[last]?.text ?? "");
  const closeMarker = closer?.[1] ?? "";
  if (!closer || closeMarker[0] !== marker[0] || closeMarker.length < marker.length || last <= first) {
    return undefined;
  }

  const bodyStart = lines[first]?.endWithNewline ?? 0;
  const bodyEnd = lines[last]?.start ?? bodyStart;
  return text.slice(bodyStart, bodyEnd);
}

function sourceText(content: unknown): string {
  const text = cleanTerminalText(textContent(content));
  return soleFencedCodeBody(text) ?? text;
}

function messageClipboardText(message: unknown): string {
  if (!isRecord(message) || typeof message.role !== "string") return "";
  switch (message.role) {
    case "user":
    case "custom":
      return sourceText(message.content);
    case "assistant": {
      const commands = bashCommands(message.content);
      return commands.length > 0 ? cleanTerminalText(joinExactParts(commands)) : sourceText(message.content);
    }
    case "toolResult":
      return cleanTerminalText(textContent(message.content));
    case "bashExecution":
      return typeof message.command === "string" ? cleanTerminalText(message.command) : "";
    case "branchSummary":
    case "compactionSummary":
      return typeof message.summary === "string" ? cleanTerminalText(message.summary) : "";
    default:
      return "";
  }
}

export function sessionEntryClipboardText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return messageClipboardText(entry.message);
    case "custom_message":
      return sourceText(entry.content);
    case "compaction":
    case "branch_summary":
      return cleanTerminalText(entry.summary);
    case "model_change":
      return cleanTerminalText(`${entry.provider}/${entry.modelId}`);
    case "thinking_level_change":
      return cleanTerminalText(entry.thinkingLevel);
    case "label":
      return cleanTerminalText(entry.label ?? "");
    case "session_info":
      return cleanTerminalText(entry.name ?? "");
    case "custom":
      return "";
  }
}

export function sessionEntriesClipboardText(entries: readonly SessionEntry[]): string {
  return joinExactParts(entries.map(sessionEntryClipboardText));
}

function messageClipboardSourceParts(message: unknown): string[] {
  if (!isRecord(message) || typeof message.role !== "string") return [];
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult":
      return textParts(message.content);
    case "assistant": {
      const commands = bashCommands(message.content);
      return commands.length > 0 ? commands : textParts(message.content);
    }
    case "bashExecution":
      return typeof message.command === "string" ? [message.command] : [];
    case "branchSummary":
    case "compactionSummary":
      return typeof message.summary === "string" ? [message.summary] : [];
    default:
      return [];
  }
}

function entryClipboardSourceParts(entry: SessionEntry): string[] {
  switch (entry.type) {
    case "message":
      return messageClipboardSourceParts(entry.message);
    case "custom_message":
      return textParts(entry.content);
    case "compaction":
    case "branch_summary":
      return [entry.summary];
    case "model_change":
      return [entry.provider, entry.modelId];
    case "thinking_level_change":
      return [entry.thinkingLevel];
    case "label":
      return entry.label ? [entry.label] : [];
    case "session_info":
      return entry.name ? [entry.name] : [];
    case "custom":
      return [];
  }
}

function estimateJoinedParts(parts: readonly string[]): number {
  let bytes = 0;
  let hasText = false;
  let previousEndsWithNewline = false;
  for (const part of parts) {
    if (!part) continue;
    if (hasText && !previousEndsWithNewline && !part.startsWith("\n")) bytes += 1;
    bytes += Buffer.byteLength(part, "utf8");
    hasText = true;
    previousEndsWithNewline = part.endsWith("\n");
  }
  return bytes;
}

export function estimateSessionEntriesClipboardBytes(entries: readonly SessionEntry[]): number {
  let bytes = 0;
  let hasEntry = false;
  for (const entry of entries) {
    const entryBytes = estimateJoinedParts(entryClipboardSourceParts(entry));
    if (entryBytes === 0) continue;
    if (hasEntry) bytes += 1;
    bytes += entryBytes;
    hasEntry = true;
  }
  return bytes;
}

function messageTitle(message: unknown): string {
  if (!isRecord(message) || typeof message.role !== "string") return "Message";
  if (message.role === "toolResult") {
    return `Tool result: ${typeof message.toolName === "string" ? message.toolName : "unknown"}`;
  }
  if (message.role === "bashExecution") return "Bash execution";
  if (message.role === "branchSummary") return "Branch summary";
  if (message.role === "compactionSummary") return "Compaction summary";
  return `${message.role.slice(0, 1).toUpperCase()}${message.role.slice(1)}`;
}

function formatToolArguments(argumentsValue: Record<string, unknown>): string {
  return Object.entries(argumentsValue)
    .map(([key, value]) => {
      if (typeof value === "string") {
        return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`;
      }
      if (value === undefined) return `${key}: undefined`;
      return `${key}: ${JSON.stringify(value, null, 2)}`;
    })
    .join("\n\n");
}

function messageDocumentSections(message: unknown): DocumentSection[] {
  if (!isRecord(message) || typeof message.role !== "string") return [];
  switch (message.role) {
    case "user":
    case "custom":
      return [{ body: textContent(message.content) }];
    case "assistant": {
      const sections: DocumentSection[] = [];
      const text = textContent(message.content);
      if (text) sections.push({ body: text });
      for (const call of toolCalls(message.content)) {
        const command = call.name === "bash" ? call.arguments.command : undefined;
        sections.push({
          heading: `Tool call: ${call.name}`,
          body: typeof command === "string" ? command : formatToolArguments(call.arguments),
        });
      }
      return sections;
    }
    case "toolResult":
      return [{ body: stripVTControlCharacters(textContent(message.content)) }];
    case "bashExecution": {
      const sections: DocumentSection[] = [];
      if (typeof message.command === "string") {
        sections.push({ heading: "Command", body: message.command });
      }
      if (typeof message.output === "string" && message.output) {
        sections.push({ heading: "Output", body: stripVTControlCharacters(message.output) });
      }
      return sections;
    }
    case "branchSummary":
    case "compactionSummary":
      return typeof message.summary === "string" ? [{ body: message.summary }] : [];
    default:
      return [];
  }
}

function entryTitle(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return messageTitle(entry.message);
    case "custom_message":
      return `Custom message: ${entry.customType}`;
    case "compaction":
      return "Compaction";
    case "branch_summary":
      return "Branch summary";
    case "model_change":
      return "Model change";
    case "thinking_level_change":
      return "Thinking level change";
    case "label":
      return "Label";
    case "session_info":
      return "Session information";
    case "custom":
      return `Custom state: ${entry.customType}`;
  }
}

function entryDocumentSections(entry: SessionEntry): DocumentSection[] {
  switch (entry.type) {
    case "message":
      return messageDocumentSections(entry.message);
    case "custom_message":
      return [{ body: textContent(entry.content) }];
    case "compaction":
    case "branch_summary":
      return [{ body: entry.summary }];
    case "model_change":
      return [{ body: `${entry.provider}/${entry.modelId}` }];
    case "thinking_level_change":
      return [{ body: entry.thinkingLevel }];
    case "label":
      return [{ body: entry.label ?? "Label cleared" }];
    case "session_info":
      return [{ body: entry.name ?? "Session name cleared" }];
    case "custom":
      return [{ body: "Use raw view to inspect extension state." }];
  }
}

function* chunkText(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + DOCUMENT_CHUNK_CODE_UNITS);
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    const splitsSurrogate = end < text.length && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
    if (splitsSurrogate) end -= 1;
    yield text.slice(start, end);
    start = end;
  }
}

function* readableEntryChunks(entry: SessionEntry): Generator<string> {
  yield `# ${cleanTerminalText(entryTitle(entry))} · ${cleanTerminalText(entry.id)}\n\n`;
  const sections = entryDocumentSections(entry);
  if (sections.length === 0) {
    yield "(no text content)\n";
    return;
  }
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!section) continue;
    if (index > 0) yield "\n";
    const heading = cleanTerminalText(section.heading ?? "");
    const body = cleanTerminalText(section.body);
    if (heading) yield `## ${heading}\n\n`;
    if (body) yield* chunkText(body);
    else yield "(empty)";
    if (!body.endsWith("\n")) yield "\n";
  }
}

function prepareJsonValue(value: unknown, key: string): unknown {
  if (isRecord(value) && typeof value.toJSON === "function") {
    return (value.toJSON as (propertyKey: string) => unknown).call(value, key);
  }
  return value;
}

function isOmittedJsonValue(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function jsonEscape(code: number): string | undefined {
  if (code === 0x08) return "\\b";
  if (code === 0x09) return "\\t";
  if (code === 0x0a) return "\\n";
  if (code === 0x0c) return "\\f";
  if (code === 0x0d) return "\\r";
  if (code === 0x22) return '\\"';
  if (code === 0x5c) return "\\\\";
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return `\\u${code.toString(16).padStart(4, "0")}`;
  return undefined;
}

function* jsonStringChunks(value: string): Generator<string> {
  yield '"';
  let buffer = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      buffer += value[index] + value[index + 1];
      index += 1;
    } else {
      buffer += jsonEscape(code) ?? value[index];
    }
    if (buffer.length >= DOCUMENT_CHUNK_CODE_UNITS) {
      yield* chunkText(buffer);
      buffer = "";
    }
  }
  if (buffer) yield buffer;
  yield '"';
}

function* jsonValueChunks(value: unknown, depth: number, seen: WeakSet<object>): Generator<string> {
  if (typeof value === "string") {
    yield* jsonStringChunks(value);
    return;
  }
  if (value === null || typeof value === "boolean") {
    yield String(value);
    return;
  }
  if (typeof value === "number") {
    yield Number.isFinite(value) ? String(value) : "null";
    return;
  }
  if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  if (!isRecord(value) && !Array.isArray(value)) {
    yield "null";
    return;
  }
  if (seen.has(value)) throw new TypeError("Converting circular structure to JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      yield* jsonArrayChunks(value, depth, seen);
    } else {
      yield* jsonObjectChunks(value, depth, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function* jsonArrayChunks(values: readonly unknown[], depth: number, seen: WeakSet<object>): Generator<string> {
  if (values.length === 0) {
    yield "[]";
    return;
  }
  yield "[\n";
  for (let index = 0; index < values.length; index += 1) {
    const value = prepareJsonValue(values[index], String(index));
    yield "  ".repeat(depth + 1);
    yield* jsonValueChunks(isOmittedJsonValue(value) ? null : value, depth + 1, seen);
    yield index + 1 < values.length ? ",\n" : "\n";
  }
  yield `${"  ".repeat(depth)}]`;
}

function* jsonObjectChunks(value: Record<string, unknown>, depth: number, seen: WeakSet<object>): Generator<string> {
  const properties = Object.keys(value).flatMap((key) => {
    const propertyValue = prepareJsonValue(value[key], key);
    return isOmittedJsonValue(propertyValue) ? [] : [{ key, value: propertyValue }];
  });
  if (properties.length === 0) {
    yield "{}";
    return;
  }
  yield "{\n";
  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];
    if (!property) continue;
    yield `${"  ".repeat(depth + 1)}${JSON.stringify(property.key)}: `;
    yield* jsonValueChunks(property.value, depth + 1, seen);
    yield index + 1 < properties.length ? ",\n" : "\n";
  }
  yield `${"  ".repeat(depth)}}`;
}

function* rawDocumentChunks(entries: readonly SessionEntry[]): Generator<string> {
  const value = prepareJsonValue(entries.length === 1 ? entries[0] : entries, "");
  yield* jsonValueChunks(value, 0, new WeakSet());
  yield "\n";
}

export function* sessionEntriesDocumentChunks(entries: readonly SessionEntry[], mode: SessionDocumentMode = "readable"): Generator<string> {
  if (mode === "raw") {
    yield* rawDocumentChunks(entries);
    return;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (index > 0) yield "\n---\n\n";
    yield* readableEntryChunks(entry);
  }
}

export function sessionEntriesDocumentText(entries: readonly SessionEntry[], mode: SessionDocumentMode = "readable"): string {
  return [...sessionEntriesDocumentChunks(entries, mode)].join("");
}
