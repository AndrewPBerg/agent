import { describe, expect, it } from "vitest";
import { createMockContext, createMockPi } from "../test/mocks/pi-coding-agent";
import forkAwareness from "./index";

interface SessionContextOptions {
  id: string;
  file: string;
  parentSession?: string;
  entries?: any[];
  allEntries?: any[];
}

function sessionContext({ id, file, parentSession, entries = [], allEntries = entries }: SessionContextOptions) {
  return createMockContext({
    sessionManager: {
      getEntries: () => allEntries,
      getBranch: () => entries,
      getHeader: () => ({ id, parentSession }),
      getSessionId: () => id,
      getSessionFile: () => file,
    },
  });
}

function forkEntry(depth: number, targetSessionId: string, sourceSessionId = "source-id") {
  return {
    type: "custom",
    customType: "fork-awareness",
    data: {
      version: 2,
      provenanceId: `provenance-${depth}`,
      parentProvenanceId: depth > 1 ? `provenance-${depth - 1}` : undefined,
      operation: "fork",
      position: "before",
      depth,
      detectedBy: "session_event",
      source: { sessionId: sourceSessionId, sessionFile: `/sessions/${sourceSessionId}.jsonl`, entryId: `entry-${depth}` },
      target: { sessionId: targetSessionId, sessionFile: `/sessions/${targetSessionId}.jsonl` },
    },
  };
}

describe("fork-awareness", () => {
  it("does not alter ordinary sessions", async () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const ctx = sessionContext({ id: "ordinary", file: "/sessions/ordinary.jsonl" });

    await pi.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

    expect(pi.entries).toEqual([]);
    expect(pi.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" })).toBeUndefined();
  });

  it("records exact source and target provenance for a nested fork", async () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const sourceFile = "/sessions/source-nested.jsonl";
    const inherited = [forkEntry(1, "grandparent"), forkEntry(2, "source-nested", "grandparent")];
    const sourceCtx = sessionContext({ id: "source-nested", file: sourceFile, entries: inherited });

    await pi.events.get("session_before_fork")?.[0]?.({ position: "before", entryId: "selected-user-entry" }, sourceCtx);

    const targetCtx = sessionContext({
      id: "target-nested",
      file: "/sessions/target-nested.jsonl",
      parentSession: sourceFile,
      entries: inherited,
    });
    await pi.events.get("session_start")?.[0]?.({ reason: "fork", previousSessionFile: sourceFile }, targetCtx);

    expect(pi.entries).toHaveLength(1);
    expect(pi.entries[0]).toMatchObject({
      customType: "fork-awareness",
      data: {
        version: 2,
        provenanceId: expect.any(String),
        parentProvenanceId: "provenance-2",
        operation: "fork",
        position: "before",
        depth: 3,
        detectedBy: "session_event",
        source: {
          sessionId: "source-nested",
          sessionFile: sourceFile,
          entryId: "selected-user-entry",
        },
        target: {
          sessionId: "target-nested",
          sessionFile: "/sessions/target-nested.jsonl",
        },
      },
    });

    const prompt = pi.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("lineage depth 3");
  });

  it("preserves clone semantics and selected entry provenance", async () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const sourceFile = "/sessions/source-clone.jsonl";
    const sourceCtx = sessionContext({ id: "source-clone", file: sourceFile });

    await pi.events.get("session_before_fork")?.[0]?.({ position: "at", entryId: "active-leaf" }, sourceCtx);
    const targetCtx = sessionContext({
      id: "target-clone",
      file: "/sessions/target-clone.jsonl",
      parentSession: sourceFile,
    });
    await pi.events.get("session_start")?.[0]?.({ reason: "fork", previousSessionFile: sourceFile }, targetCtx);

    expect(pi.entries[0]).toMatchObject({
      data: {
        operation: "clone",
        position: "at",
        depth: 1,
        source: { sessionId: "source-clone", entryId: "active-leaf" },
        target: { sessionId: "target-clone" },
      },
    });
  });

  it("preserves nested provenance across three consecutive forks", async () => {
    let sourceId = "root";
    let sourceFile = "/sessions/root-x3.jsonl";
    let entries: any[] = [];
    const labels: string[] = [];
    let previousProvenanceId: string | undefined;

    for (let depth = 1; depth <= 3; depth += 1) {
      const pi = createMockPi();
      forkAwareness(pi);
      const sourceCtx = sessionContext({ id: sourceId, file: sourceFile, entries });
      await pi.events.get("session_before_fork")?.[0]?.({ position: "before", entryId: `entry-${depth}` }, sourceCtx);

      const targetId = `fork-${depth}`;
      const targetFile = `/sessions/${targetId}.jsonl`;
      const targetCtx = sessionContext({ id: targetId, file: targetFile, parentSession: sourceFile, entries });
      await pi.events.get("session_start")?.[0]?.({ reason: "fork", previousSessionFile: sourceFile }, targetCtx);

      const recorded = pi.entries[0];
      expect(recorded.data.depth).toBe(depth);
      expect(recorded.data.parentProvenanceId).toBe(previousProvenanceId);
      expect(recorded.data.source.sessionId).toBe(sourceId);
      expect(recorded.data.target.sessionId).toBe(targetId);

      const renderer = pi.entryRenderers.get("fork-awareness");
      labels.push(renderer({ data: recorded.data }, { expanded: false }, { fg: (_color: string, text: string) => text }).text);
      entries = [...entries, { type: "custom", ...recorded }];
      previousProvenanceId = recorded.data.provenanceId;
      sourceId = targetId;
      sourceFile = targetFile;
    }

    expect(labels).toEqual(["↳ session fork #1", "  ↳ session fork #2", "    ↳ session fork #3"]);
  });

  it("renders nested lineage with indentation and expanded provenance", () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const renderer = pi.entryRenderers.get("fork-awareness");
    const component = renderer(
      { data: forkEntry(3, "target", "source").data },
      { expanded: true },
      { fg: (_color: string, text: string) => text },
    );

    expect(component.text).toContain("    ↳ session fork #3");
    expect(component.text).toContain("provenance: provenance-3");
    expect(component.text).toContain("parent event: provenance-2");
    expect(component.text).toContain("source: source:entry-3");
    expect(component.text).toContain("target: target");
  });

  it("backfills an already-forked session when no own event exists", async () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const ctx = sessionContext({
      id: "backfilled",
      file: "/sessions/backfilled.jsonl",
      parentSession: "/sessions/parent-backfill.jsonl",
      entries: [forkEntry(1, "parent-backfill")],
    });

    await pi.events.get("session_start")?.[0]?.({ reason: "reload" }, ctx);

    expect(pi.entries[0]).toMatchObject({
      data: {
        operation: "fork_or_clone",
        depth: 2,
        detectedBy: "parent_header",
        source: { sessionId: "unknown", sessionFile: "/sessions/parent-backfill.jsonl" },
        target: { sessionId: "backfilled" },
      },
    });
  });

  it("ignores fork records from sibling branches", async () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const branchEvent = forkEntry(1, "current", "root");
    const siblingEvent = forkEntry(2, "sibling", "current");
    const ctx = sessionContext({
      id: "current",
      file: "/sessions/current.jsonl",
      entries: [branchEvent],
      allEntries: [branchEvent, siblingEvent],
    });

    await pi.events.get("session_start")?.[0]?.({ reason: "resume" }, ctx);

    const prompt = pi.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("lineage depth 1");
    expect(prompt.systemPrompt).not.toContain("lineage depth 2");
  });

  it("does not duplicate an event already owned by the current session", async () => {
    const pi = createMockPi();
    forkAwareness(pi);
    const ownEvent = forkEntry(2, "current", "parent");
    const ctx = sessionContext({
      id: "current",
      file: "/sessions/current.jsonl",
      parentSession: "/sessions/parent.jsonl",
      entries: [forkEntry(1, "parent"), ownEvent],
    });

    await pi.events.get("session_start")?.[0]?.({ reason: "resume" }, ctx);

    expect(pi.entries).toEqual([]);
    const prompt = pi.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" });
    expect(prompt.systemPrompt).toContain("lineage depth 2");
  });
});
