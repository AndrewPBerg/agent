import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LoadedLoopConfig, loadLoopConfig, loopConfigJsonSchema } from "./config";
import { completeLoopArguments, LOOP_MAX_REPEATS, parseInlineWorkflow, parseLegacyStages } from "./dsl";
import { LoopEngine } from "./engine";

function usage(): string {
  return "Usage: /lp <workflow|pipeline> | status | stop | resume | list | reload | validate | schema";
}

/** Backward-compatible parser for the original compact pipeline syntax. */
export function parseLoopDsl(input: string): Array<{ prompt: string }> | null {
  return parseLegacyStages(input);
}

export default function loop(pi: ExtensionAPI) {
  let loaded: LoadedLoopConfig = {
    version: 1 as const,
    defaults: { prMode: "draft" as const },
    workflows: {},
    stressProfiles: {},
    errors: [],
    sourcePaths: [],
  };
  const engine = new LoopEngine(pi, loaded);

  function reload(ctx: ExtensionContext) {
    loaded = loadLoopConfig(ctx);
    engine.setConfig(loaded);
    if (loaded.errors.length) ctx.ui.notify(`Some loop configs were ignored:\n${loaded.errors.slice(0, 5).join("\n")}`, "warning");
  }

  pi.registerTool({
    name: "report_loop_stage",
    label: "Report Loop Stage",
    description: "Report the typed terminal result and evidence for the currently active /lp stage.",
    promptSnippet: "Report a gated /lp stage as clean, fixed, passed, blocked, or failed.",
    promptGuidelines: [
      "Call report_loop_stage exactly once before finishing a gated /lp stage.",
      "Use clean only for QA that found no remaining issue, fixed when QA changed the diff, and passed for successful stress or PR stages.",
      "Include concrete evidence; never report success from intent alone.",
    ],
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("clean"),
        Type.Literal("fixed"),
        Type.Literal("passed"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      summary: Type.String({ minLength: 1 }),
      evidence: Type.Optional(Type.Array(Type.String())),
      changedFiles: Type.Optional(Type.Array(Type.String())),
      url: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const result = engine.report({ ...params, evidence: params.evidence ?? [] });
      return {
        content: [{ type: "text", text: `Loop stage recorded: ${result.status} — ${result.summary}` }],
        details: result,
      };
    },
  });

  pi.registerCommand("lp", {
    description: "Run a gated workflow: /lp qa-pr or /lp qa until clean max 3 | stress auto | pr",
    getArgumentCompletions: (prefix: string) => completeLoopArguments(prefix, engine.workflowNames(), engine.profileNames()),
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const [command, ...rest] = raw.split(/\s+/);
      const tail = rest.join(" ").trim();

      if (!raw || command === "status") {
        ctx.ui.notify(engine.describe(), "info");
        return;
      }
      if (command === "stop") {
        if (!engine.stop()) ctx.ui.notify("No active loop.", "info");
        return;
      }
      if (command === "resume") {
        try {
          await engine.resume(ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      if (command === "list") {
        ctx.ui.notify(
          [
            `Workflows: ${engine.workflowNames().join(", ") || "none"}`,
            `Stress profiles: ${engine.profileNames().join(", ") || "none"}`,
            loaded.sourcePaths.length ? `Sources:\n${loaded.sourcePaths.join("\n")}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        return;
      }
      if (command === "reload") {
        reload(ctx);
        ctx.ui.notify(`Loaded ${engine.workflowNames().length} loop workflow(s).`, loaded.errors.length ? "warning" : "info");
        return;
      }
      if (command === "schema") {
        const dir = join(ctx.cwd, CONFIG_DIR_NAME);
        const path = join(dir, "loop-workflow.schema.json");
        await mkdir(dir, { recursive: true });
        await writeFile(path, `${JSON.stringify(loopConfigJsonSchema(), null, 2)}\n`, "utf8");
        ctx.ui.notify(`Loop workflow JSON Schema written to ${path}`, "info");
        return;
      }
      if (command === "validate") {
        const named = loaded.workflows[tail];
        const parsed = named ? { success: true as const, workflow: named } : parseInlineWorkflow(tail);
        ctx.ui.notify(
          parsed.success ? `Valid loop: ${tail} (${parsed.workflow.stages.length} stages)` : `Invalid loop: ${parsed.error}`,
          parsed.success ? "info" : "warning",
        );
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; wait for it to settle before starting /lp.", "warning");
        return;
      }
      const existing = engine.currentRun();
      if (existing && ["running", "waiting"].includes(existing.status)) {
        ctx.ui.notify(`Loop ${existing.id} is already ${existing.status}. Use /lp status or /lp stop.`, "warning");
        return;
      }

      const named = loaded.workflows[raw];
      const parsed = named ? { success: true as const, workflow: named } : parseInlineWorkflow(raw);
      if (!parsed.success) {
        ctx.ui.notify(`${usage()}\n${parsed.error} (repeat counts must be 1-${LOOP_MAX_REPEATS})`, "warning");
        return;
      }
      await engine.start(parsed.workflow, ctx, named ? raw : undefined);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    engine.restore(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await engine.onAgentSettled(ctx);
  });

  pi.on("tool_call", (event) => engine.guardToolCall(event));

  pi.on("session_shutdown", () => {
    engine.shutdown();
  });
}
