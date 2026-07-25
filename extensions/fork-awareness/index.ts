import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "fork-awareness";
const HANDOFFS = Symbol.for("andrew.pi.fork-awareness.handoffs");
const HANDOFF_TTL_MS = 5 * 60 * 1000;

type ForkOperation = "fork" | "clone" | "fork_or_clone";
type ForkPosition = "before" | "at";

interface SessionEndpoint {
  sessionId: string;
  sessionFile?: string;
  entryId?: string;
}

interface ForkEventData {
  version: 2;
  provenanceId: string;
  parentProvenanceId?: string;
  operation: ForkOperation;
  position?: ForkPosition;
  depth: number;
  detectedBy: "session_event" | "parent_header";
  source: SessionEndpoint;
  target: SessionEndpoint;
}

interface LegacyForkEventData {
  version?: 1;
  operation?: "fork_or_clone";
  previousSessionFile?: string;
  detectedBy?: "session_event" | "parent_header";
  depth?: number;
}

interface PendingFork {
  createdAt: number;
  operation: "fork" | "clone";
  position: ForkPosition;
  depth: number;
  parentProvenanceId?: string;
  source: SessionEndpoint;
}

type GlobalWithHandoffs = typeof globalThis & { [HANDOFFS]?: PendingFork[] };

function handoffs(): PendingFork[] {
  const target = globalThis as GlobalWithHandoffs;
  const now = Date.now();
  target[HANDOFFS] = (target[HANDOFFS] ?? []).filter((item) => now - item.createdAt < HANDOFF_TTL_MS);
  return target[HANDOFFS];
}

function forkEntries(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
  return entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE);
}

function lineageState(ctx: ExtensionContext): { depth: number; provenanceId?: string } {
  let inferredDepth = 0;
  let explicitDepth = 0;
  let provenanceId: string | undefined;
  for (const entry of forkEntries(ctx)) {
    inferredDepth += 1;
    const data = entry.data as LegacyForkEventData | ForkEventData | undefined;
    const depth = data?.depth;
    if (typeof depth !== "number" || !Number.isFinite(depth) || depth < explicitDepth) continue;
    explicitDepth = depth;
    provenanceId = data?.version === 2 ? data.provenanceId : undefined;
  }
  return { depth: Math.max(inferredDepth, explicitDepth), provenanceId };
}

function hasEventForCurrentSession(ctx: ExtensionContext): boolean {
  const header = ctx.sessionManager.getHeader();
  return forkEntries(ctx).some((entry) => {
    const data = entry.data as LegacyForkEventData | ForkEventData | undefined;
    if (!data) return false;
    if (data.version === 2) return data.target.sessionId === header.id;
    return Boolean(header.parentSession && data.previousSessionFile === header.parentSession);
  });
}

function takeHandoff(previousSessionFile?: string): PendingFork | undefined {
  if (!previousSessionFile) return undefined;
  const pending = handoffs();
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]?.source.sessionFile !== previousSessionFile) continue;
    return pending.splice(index, 1)[0];
  }
  return undefined;
}

function renderEvent(data: LegacyForkEventData | ForkEventData, expanded: boolean): { label: string; details?: string } {
  const depth = Math.max(1, data.depth ?? 1);
  const indent = "  ".repeat(depth - 1);
  const operation = data.operation ?? "fork_or_clone";
  const operationLabel = operation === "fork_or_clone" ? "fork/clone" : operation;
  const label = `${indent}↳ session ${operationLabel} #${depth}`;

  if (!expanded) return { label };
  if (data.version !== 2) {
    return { label, details: data.previousSessionFile ? `  parent: ${data.previousSessionFile}` : undefined };
  }

  const sourceEntry = data.source.entryId ? `:${data.source.entryId}` : "";
  const details = [
    `  provenance: ${data.provenanceId}`,
    ...(data.parentProvenanceId ? [`  parent event: ${data.parentProvenanceId}`] : []),
    `  source: ${data.source.sessionId}${sourceEntry}`,
    `  target: ${data.target.sessionId}`,
  ];
  if (data.source.sessionFile) details.push(`  parent: ${data.source.sessionFile}`);
  return { label, details: details.join("\n") };
}

function forkPrompt(depth: number): string {
  return `SESSION FORK CONTEXT:
- This conversation is at fork/clone lineage depth ${depth}.
- History before each fork point is inherited; parent and sibling continuations are not present. Do not assume they share this branch's decisions.
- Forking the conversation does not isolate the working directory, processes, or Git state. Verify current external state before relying on inherited claims.
- Treat the user's latest instructions as the intent for this branch.
- Use this context operationally; do not mention the fork unless it is relevant.`;
}

export default function forkAwareness(pi: ExtensionAPI) {
  let currentDepth = 0;

  pi.registerEntryRenderer(CUSTOM_TYPE, (entry, options, theme) => {
    const rendered = renderEvent(entry.data as LegacyForkEventData | ForkEventData, options.expanded);
    let text = theme.fg("customMessageLabel", rendered.label);
    if (rendered.details) text += `\n${theme.fg("dim", rendered.details)}`;
    return new Text(text, 1, 0);
  });

  pi.on("session_before_fork", (event, ctx) => {
    const lineage = lineageState(ctx);
    handoffs().push({
      createdAt: Date.now(),
      operation: event.position === "at" ? "clone" : "fork",
      position: event.position,
      depth: lineage.depth + 1,
      parentProvenanceId: lineage.provenanceId,
      source: {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        entryId: event.entryId,
      },
    });
  });

  pi.on("session_start", (event, ctx) => {
    const lineage = lineageState(ctx);
    currentDepth = lineage.depth;
    const header = ctx.sessionManager.getHeader();
    const handoff = event.reason === "fork" ? takeHandoff(event.previousSessionFile) : undefined;
    const needsBackfill = Boolean(header.parentSession && !hasEventForCurrentSession(ctx));
    if (!handoff && !needsBackfill) return;

    const depth = handoff?.depth ?? currentDepth + 1;
    const data: ForkEventData = {
      version: 2,
      provenanceId: randomUUID(),
      parentProvenanceId: handoff?.parentProvenanceId ?? lineage.provenanceId,
      operation: handoff?.operation ?? "fork_or_clone",
      position: handoff?.position,
      depth,
      detectedBy: handoff ? "session_event" : "parent_header",
      source: handoff?.source ?? {
        sessionId: "unknown",
        sessionFile: event.previousSessionFile ?? header.parentSession,
      },
      target: {
        sessionId: header.id,
        sessionFile: ctx.sessionManager.getSessionFile(),
      },
    };
    pi.appendEntry(CUSTOM_TYPE, data);
    currentDepth = depth;
  });

  pi.on("before_agent_start", (event) => {
    if (currentDepth === 0) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${forkPrompt(currentDepth)}` };
  });
}
