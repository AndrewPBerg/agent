import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_REPEATS = 25;

type Stage = {
  prompt: string;
};

type ActivePipeline = {
  stages: Stage[];
  nextStage: number;
};

function usage(): string {
  return "Usage: /loop <objective> | <command> [args] [loop N]";
}

/**
 * Parse a small, deliberately boring pipeline:
 *
 *   /loop implement auth | qa make it clean loop 3
 *
 * The objective runs once. Every piped command runs once unless its trailing
 * `loop N` repeats that command N times. Commands are sent back through Pi's
 * normal input path, so they stay in this session and retain their own logic.
 */
export function parseLoopDsl(input: string): Stage[] | null {
  const segments = input.split("|").map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => !segment)) return null;

  const objective = segments[0];
  if (!objective) return null;

  const stages: Stage[] = [{ prompt: objective }];

  for (const segment of segments.slice(1)) {
    const match = segment.match(/^(.*?)(?:\s+loop\s+(\d+))?$/i);
    const command = match?.[1]?.trim();
    const repeats = match?.[2] === undefined ? 1 : Number(match[2]);

    if (!command || !Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) return null;

    const prompt = command.startsWith("/") ? command : `/${command}`;
    stages.push(...Array.from({ length: repeats }, () => ({ prompt })));
  }

  return stages;
}

export default function loop(pi: ExtensionAPI) {
  let active: ActivePipeline | undefined;

  function updateStatus(ctx: ExtensionContext) {
    if (!active) {
      ctx.ui.setStatus("loop", undefined);
      return;
    }

    ctx.ui.setStatus("loop", `loop ${active.nextStage}/${active.stages.length}`);
  }

  function stop(ctx: ExtensionContext, message: string) {
    active = undefined;
    updateStatus(ctx);
    ctx.ui.notify(message, "info");
  }

  function sendNext(ctx: ExtensionContext) {
    if (!active) return;

    const stage = active.stages[active.nextStage++];
    if (!stage) {
      stop(ctx, "Loop complete");
      return;
    }

    updateStatus(ctx);
    pi.sendUserMessage(stage.prompt);
  }

  pi.registerCommand("loop", {
    description: "Chain an objective into same-session commands: /loop objective | qa loop 3",
    handler: async (args, ctx) => {
      const input = String(args ?? "").trim();
      const command = input.toLowerCase();

      if (command === "stop") {
        if (active) stop(ctx, "Loop stopped");
        else ctx.ui.notify("No active loop", "info");
        return;
      }

      if (command === "status") {
        if (active) ctx.ui.notify(`Loop ${active.nextStage}/${active.stages.length}`, "info");
        else ctx.ui.notify("No active loop", "info");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; wait for it to settle before starting a loop", "warning");
        return;
      }

      const stages = parseLoopDsl(input);
      if (!stages) {
        ctx.ui.notify(`${usage()} (N must be 1-${MAX_REPEATS})`, "warning");
        return;
      }

      active = { stages, nextStage: 0 };
      sendNext(ctx);
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active) return;
    sendNext(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = undefined;
    updateStatus(ctx);
  });
}
