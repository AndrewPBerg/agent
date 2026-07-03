import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024;

const optionalNumber = (description: string) => Type.Optional(Type.Number({ description }));
const optionalString = (description: string) => Type.Optional(Type.String({ description }));

async function runFlameFrame(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS) {
  const { stdout, stderr } = await execFileAsync("flameframe", args, {
    cwd,
    signal,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function pushOptional(args: string[], flag: string, value: string | number | undefined) {
  if (value !== undefined && value !== "") args.push(flag, String(value));
}

function resultText(command: string[], output: string) {
  return `$ flameframe ${command.join(" ")}\n${output || "ok"}`;
}

export default function flameframeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "flameframe_inspect",
    label: "FlameFrame Inspect",
    description: "Inspect a video URL, local video file, or .frameflame pack using the local flameframe CLI.",
    promptSnippet: "Inspect video URLs, local videos, or FlameFrame packs via the local flameframe CLI",
    promptGuidelines: [
      "Use flameframe_inspect for quick metadata on video URLs, local video files, or .frameflame packs before deeper processing.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "URL, local video path, or .frameflame pack directory" }),
      timeoutSeconds: Type.Optional(Type.Number({ description: "URL metadata timeout in seconds" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["inspect", params.target];
      pushOptional(args, "--timeout-seconds", params.timeoutSeconds);
      const output = await runFlameFrame(args, ctx.cwd, signal, 2 * 60 * 1000);
      return { content: [{ type: "text", text: resultText(args, output) }], details: { args, output } };
    },
  });

  pi.registerTool({
    name: "flameframe_process",
    label: "FlameFrame Process",
    description:
      "Run the full local FlameFrame workflow for a video URL/path: download when needed, ingest, split, build markdown context, and verify.",
    promptSnippet: "Process a video URL/path locally into transcript, segment, and visual FlameFrame context",
    promptGuidelines: [
      "Use flameframe_process when the user asks to process a YouTube/video URL or local video for agent-readable context.",
      "flameframe_process requires a deterministic workDir, preferably under data/downloads/<slug>.",
      "After flameframe_process, read inspect.context.md first, then video.context.md, then inspect.visual.context.md only when visual evidence is needed.",
    ],
    parameters: Type.Object({
      input: Type.String({ description: "HTTP(S) video URL or local video path" }),
      workDir: Type.String({ description: "Deterministic output/work directory, e.g. data/downloads/my-video" }),
      maxHeight: optionalNumber("Maximum downloaded video height; default 480"),
      budget: optionalNumber("Selected frame budget; default 32"),
      fps: optionalNumber("Low-resolution analysis FPS; default 2"),
      segmentSeconds: optionalNumber("Segment length in seconds; default 300"),
      windowSeconds: optionalNumber("Transcript markdown window size in seconds; default 60"),
      timeoutSeconds: optionalNumber("URL download timeout in seconds; default 900"),
      subLangs: optionalString("Caption/subtitle languages; default en,en-orig"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["process", params.input, "--work-dir", params.workDir];
      pushOptional(args, "--max-height", params.maxHeight);
      pushOptional(args, "--budget", params.budget);
      pushOptional(args, "--fps", params.fps);
      pushOptional(args, "--segment-seconds", params.segmentSeconds);
      pushOptional(args, "--window-seconds", params.windowSeconds);
      pushOptional(args, "--timeout-seconds", params.timeoutSeconds);
      pushOptional(args, "--sub-langs", params.subLangs);
      const timeoutMs = ((params.timeoutSeconds ?? 900) + 300) * 1000;
      const output = await runFlameFrame(args, ctx.cwd, signal, timeoutMs);
      return { content: [{ type: "text", text: resultText(args, output) }], details: { args, output } };
    },
  });

  pi.registerTool({
    name: "flameframe_zoom",
    label: "FlameFrame Zoom",
    description: "Extract local frame images around a timestamp from a processed video using the local flameframe CLI.",
    promptSnippet: "Extract zoom frame windows around transcript-selected timestamps",
    promptGuidelines: [
      "Use flameframe_zoom after reading transcript context and identifying a timestamp that needs closer visual evidence.",
    ],
    parameters: Type.Object({
      video: Type.String({ description: "Local video path, usually <workDir>/video.mp4" }),
      at: Type.String({ description: "Center timestamp, e.g. 00:12:34 or 754.0" }),
      out: Type.String({ description: "Output directory for zoom frames, e.g. <workDir>/zooms/00-12-34" }),
      window: optionalNumber("Window size in seconds; default 8"),
      fps: optionalNumber("Extraction FPS; default 4"),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["zoom", params.video, "--at", params.at, "--out", params.out];
      pushOptional(args, "--window", params.window);
      pushOptional(args, "--fps", params.fps);
      const output = await runFlameFrame(args, ctx.cwd, signal, 5 * 60 * 1000);
      return { content: [{ type: "text", text: resultText(args, output) }], details: { args, output } };
    },
  });

  pi.registerCommand("flameframe", {
    description: "Start a FlameFrame video-processing workflow: /flameframe <url-or-path> <work-dir>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /flameframe <url-or-path> <work-dir>", "warning");
        return;
      }
      pi.sendUserMessage(
        `Use the flameframe skill and local FlameFrame CLI only. Process this video into agent context, then summarize the generated files and next inspection steps: ${trimmed}`,
      );
    },
  });
}
