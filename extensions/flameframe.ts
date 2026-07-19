import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Image, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PROCESS_TOOL_NAME = "flameframe_process";
const CUSTOM_ENTRY_TYPE = "flameframe-pack";
const SESSION_DETAILS_VERSION = 1;
const MAX_CONTEXT_BYTES = 256_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const BROWSER_PREVIEW_RESERVED_ROWS = 26;
const DETAIL_TRANSCRIPT_VISIBLE_LINES = 12;
const CLIPBOARD_TIMEOUT_MS = 2_000;

type Manifest = {
  source_input?: unknown;
  source_video?: unknown;
  budget?: unknown;
  analysis_fps?: unknown;
  metadata?: { duration_seconds?: unknown };
};

type Frame = {
  frameId: string;
  timestampMs: number;
  imagePath: string;
  selectionReason: string;
  caption?: string;
};

type SessionPack = {
  version: number;
  packPath: string;
  workDir: string;
  sourceInput: string;
  sourceVideo: string;
  durationSeconds?: number;
  budget: number;
  analysisFps: number;
  captions: boolean;
  frames: Frame[];
};

type FlameFrameDetails = {
  version: number;
  pack: SessionPack;
};

type BrowserAction = { type: "close" } | { type: "image"; frame: Frame } | { type: "zoom"; frame: Frame };

export default function (pi: ExtensionAPI) {
  let sessionPacks: SessionPack[] = [];

  const updateShelf = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    if (sessionPacks.length === 0) {
      ctx.ui.setWidget("flameframe-session", undefined);
      return;
    }

    const latest = sessionPacks.at(-1)!;
    const frames = sessionPacks.reduce((total, pack) => total + pack.frames.length, 0);
    ctx.ui.setWidget("flameframe-session", (_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        const label = ` FlameFrame · this session: ${sessionPacks.length} packs · ${frames} frames · latest: ${packLabel(latest)} · /flameframe-browser `;
        return [truncateToWidth(theme.fg("accent", label), width)];
      },
    }));
  };

  const addPack = (pack: SessionPack, ctx: ExtensionContext) => {
    sessionPacks = [...sessionPacks.filter((item) => item.packPath !== pack.packPath), pack];
    updateShelf(ctx);
  };

  const rememberPack = (pack: SessionPack, ctx: ExtensionContext) => {
    const alreadyRegistered = sessionPacks.some((item) => item.packPath === pack.packPath);
    addPack(pack, ctx);
    if (!alreadyRegistered) {
      pi.appendEntry<FlameFrameDetails>(CUSTOM_ENTRY_TYPE, {
        version: SESSION_DETAILS_VERSION,
        pack,
      });
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionPacks = packsFromSession(ctx);
    updateShelf(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== PROCESS_TOOL_NAME || event.isError) return;
    const workDir = workDirFromInput(event.input);
    if (!workDir) return;
    try {
      rememberPack(await loadPack(workDir, ctx.cwd), ctx);
    } catch (error) {
      ctx.ui.notify(`FlameFrame completed but its evidence pack could not be added: ${errorMessage(error)}`, "warning");
    }
  });

  pi.registerCommand("flameframe-browser", {
    description: "Browse FlameFrame evidence packs registered in this session, or add one explicitly.",
    handler: async (args, ctx) => {
      if (args.trim()) rememberPack(await loadPack(args.trim(), ctx.cwd), ctx);
      await browseSessionPacks(sessionPacks, ctx);
    },
  });
}

async function browseSessionPacks(packs: SessionPack[], ctx: ExtensionContext): Promise<void> {
  if (packs.length === 0) {
    ctx.ui.notify(
      "No FlameFrame packs are registered in this session. Run flameframe_process or /flameframe-browser <pack-or-workdir>.",
      "info",
    );
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The FlameFrame frame browser requires Pi TUI mode.", "warning");
    return;
  }

  const pack = await choosePack(packs, ctx);
  if (!pack) return;

  const copyFramePath = async (frame: Frame): Promise<boolean> => {
    const path = frameImagePath(pack, frame);
    if (await copyToClipboard(path)) return true;
    ctx.ui.setEditorText(path);
    ctx.ui.notify("No clipboard helper found; image path was placed in the editor.", "warning");
    return false;
  };

  while (true) {
    const action = await ctx.ui.custom<BrowserAction>(
      (tui, theme, _keybindings, done) => new FrameBrowser(pack, theme, tui.requestRender.bind(tui), copyFramePath, done),
      { overlay: true, overlayOptions: { width: "88%", minWidth: 56, maxHeight: "92%", anchor: "center" } },
    );
    if (!action || action.type === "close") return;
    if (action.type === "image") {
      await showImage(pack, action.frame, ctx);
      continue;
    }

    ctx.ui.setEditorText(zoomCommand(pack, action.frame));
    ctx.ui.notify("Zoom command placed in the editor.", "info");
    return;
  }
}

async function choosePack(packs: SessionPack[], ctx: ExtensionContext): Promise<SessionPack | undefined> {
  if (packs.length === 1) return packs[0];
  const labels = packs.map((pack) => `${packLabel(pack)} · ${pack.frames.length} frames · ${pack.packPath}`);
  const selected = await ctx.ui.select("FlameFrame packs in this session:", labels);
  const index = selected === undefined ? -1 : labels.indexOf(selected);
  return index < 0 ? undefined : packs[index];
}

class FrameBrowser implements Component {
  private selected = 0;
  private preview: Image | undefined;
  private previewFrameId: string | undefined;
  private previewRequestFrameId: string | undefined;
  private previewError: string | undefined;
  private copyIndicator = "";
  private copyIndicatorTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly previewCache = new Map<string, Image>();

  constructor(
    private readonly pack: SessionPack,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly copyPath: (frame: Frame) => Promise<boolean>,
    private readonly done: (action: BrowserAction) => void,
  ) {
    void this.loadPreview();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.closed = true;
      this.done({ type: "close" });
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "h" || data === "k") {
      this.selectFrame(-1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "l" || data === "j") {
      this.selectFrame(1);
      return;
    }

    const frame = this.pack.frames[this.selected];
    if (!frame) return;
    if (data === "o" || matchesKey(data, Key.enter)) this.done({ type: "image", frame });
    if (data === "c") void this.copyFramePath(frame);
    if (data === "z") this.done({ type: "zoom", frame });
  }

  render(width: number): string[] {
    const frame = this.pack.frames[this.selected];
    if (!frame) return roundedPanel(["No selected frames were found in this pack."], width, this.theme);
    const innerWidth = Math.max(1, width - 2);
    const lines = [
      this.theme.fg("accent", this.theme.bold(` FlameFrame · ${packLabel(this.pack)} `)),
      this.theme.fg("muted", ` ${this.selected + 1}/${this.pack.frames.length} · ${formatTimestamp(frame.timestampMs)} · ${frame.frameId}`),
      "",
      ...frameList(this.pack.frames, this.selected, innerWidth - 2),
      "",
      this.theme.fg("text", ` Reason: ${frame.selectionReason}`),
      this.theme.fg("dim", ` Image: ${frameImagePath(this.pack, frame)}`),
      this.theme.fg("text", ` Caption: ${frame.caption ?? "No caption excerpt is available for this frame."}`),
      "",
      this.theme.fg("muted", " Preview "),
      ...this.previewLines(innerWidth),
      "",
      this.theme.fg("dim", ` ←→/j k frame · Enter/o lightbox · c copy path${this.copyIndicator} · z zoom · Esc close `),
    ];
    return roundedPanel(lines, width, this.theme);
  }

  invalidate(): void {
    this.previewCache.clear();
    this.preview = undefined;
    this.previewFrameId = undefined;
    this.previewRequestFrameId = undefined;
    void this.loadPreview();
  }

  private async copyFramePath(frame: Frame): Promise<void> {
    if (!(await this.copyPath(frame)) || this.closed) return;
    this.copyIndicator = " ✓ Copied";
    this.requestRender();
    if (this.copyIndicatorTimer) clearTimeout(this.copyIndicatorTimer);
    this.copyIndicatorTimer = setTimeout(() => {
      this.copyIndicator = "";
      if (!this.closed) this.requestRender();
    }, 2_000);
  }

  private selectFrame(delta: number): void {
    this.selected = Math.max(0, Math.min(this.pack.frames.length - 1, this.selected + delta));
    void this.loadPreview();
    this.requestRender();
  }

  private previewLines(width: number): string[] {
    const selectedFrame = this.pack.frames[this.selected];
    const loading = this.previewRequestFrameId === selectedFrame?.frameId;
    const status =
      loading && this.previewFrameId !== selectedFrame?.frameId
        ? this.theme.fg("dim", ` Loading ${selectedFrame?.frameId ?? "selected frame"}; keeping the previous preview visible…`)
        : this.previewError
          ? this.theme.fg("warning", this.previewError)
          : " ";
    // Reserve the full image area before ffmpeg completes. Otherwise Pi recenters
    // the expanding overlay and leaves the first, short panel border behind.
    const imageLines = this.preview ? this.preview.render(width) : [this.theme.fg("dim", " Loading selected frame…")];
    const padding = Array.from({ length: Math.max(0, BROWSER_PREVIEW_RESERVED_ROWS - imageLines.length) }, () => "");
    return [...imageLines, ...padding, status];
  }

  private async loadPreview(): Promise<void> {
    const frame = this.pack.frames[this.selected];
    if (!frame || (this.previewFrameId === frame.frameId && this.preview)) return;
    const cached = this.previewCache.get(frame.frameId);
    if (cached) {
      this.preview = cached;
      this.previewFrameId = frame.frameId;
      this.previewRequestFrameId = undefined;
      this.previewError = undefined;
      return;
    }

    this.previewRequestFrameId = frame.frameId;
    this.previewError = undefined;
    try {
      const image = await createPreviewImage(frameImagePath(this.pack, frame), this.theme, {
        maxHeightCells: BROWSER_PREVIEW_RESERVED_ROWS,
        maxWidthCells: 112,
      });
      this.previewCache.set(frame.frameId, image);
      if (this.previewRequestFrameId === frame.frameId) {
        this.preview = image;
        this.previewFrameId = frame.frameId;
        this.previewRequestFrameId = undefined;
      }
    } catch (error) {
      if (this.previewRequestFrameId === frame.frameId) {
        this.previewError = ` Preview unavailable: ${errorMessage(error)}`;
        this.previewRequestFrameId = undefined;
      }
    }
    this.requestRender();
  }
}

function roundedPanel(lines: string[], width: number, theme: Theme): string[] {
  if (width < 4) return lines.map((line) => truncateToWidth(line, width));
  const innerWidth = width - 2;
  const border = (line: string) => theme.fg("borderAccent", line);
  const row = (line: string) => {
    const fitted = truncateToWidth(line, innerWidth);
    return `${border("│")}${fitted}${" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))}${border("│")}`;
  };
  return [border(`╭${"─".repeat(innerWidth)}╮`), ...lines.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
}

type PreviewOptions = {
  maxHeightCells: number;
  maxWidthCells: number;
};

async function createPreviewImage(path: string, theme: Theme, options: PreviewOptions): Promise<Image> {
  const png = await renderPreviewPng(path);
  return new Image(
    png.toString("base64"),
    "image/png",
    { fallbackColor: (text) => theme.fg("warning", text) },
    { ...options, filename: basename(path) },
  );
}

function renderPreviewPng(path: string): Promise<Buffer> {
  return new Promise((resolvePreview, rejectPreview) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PREVIEW_BYTES) {
        exceeded = true;
        child.kill();
        return;
      }
      output.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", rejectPreview);
    child.once("close", (code) => {
      if (exceeded) {
        rejectPreview(new Error("preview image exceeds 8 MiB"));
        return;
      }
      const png = Buffer.concat(output);
      if (code !== 0 || png.length === 0) {
        rejectPreview(new Error(Buffer.concat(errors).toString("utf8").trim() || "ffmpeg could not create a PNG preview"));
        return;
      }
      resolvePreview(png);
    });
  });
}

async function showImage(pack: SessionPack, frame: Frame, ctx: ExtensionContext): Promise<void> {
  let image: Image;
  try {
    image = await createPreviewImage(frameImagePath(pack, frame), ctx.ui.theme, {
      maxHeightCells: 18,
      maxWidthCells: 100,
    });
  } catch (error) {
    ctx.ui.notify(`Could not prepare selected image preview: ${errorMessage(error)}`, "error");
    return;
  }

  const transcript = await transcriptWindow(pack, frame.timestampMs);
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new FrameImageOverlay(image, frame, transcript, theme, tui.requestRender.bind(tui), done),
    { overlay: true, overlayOptions: { width: "90%", minWidth: 40, maxHeight: "92%", anchor: "center" } },
  );
}

class FrameImageOverlay implements Component {
  private transcriptOffset = 0;
  private maxTranscriptOffset = 0;
  private scrollRenderScheduled = false;
  private closed = false;

  constructor(
    private readonly image: Image,
    private readonly frame: Frame,
    private readonly transcript: string,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "o") {
      this.closed = true;
      this.done();
      return;
    }
    if ((matchesKey(data, Key.down) || data === "j") && this.transcriptOffset < this.maxTranscriptOffset) {
      this.transcriptOffset += 1;
      this.requestScrollRender();
    }
    if ((matchesKey(data, Key.up) || data === "k") && this.transcriptOffset > 0) {
      this.transcriptOffset -= 1;
      this.requestScrollRender();
    }
  }

  private requestScrollRender(): void {
    if (this.scrollRenderScheduled) return;
    this.scrollRenderScheduled = true;
    setTimeout(() => {
      this.scrollRenderScheduled = false;
      if (!this.closed) this.requestRender();
    }, 16);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const transcript = transcriptLines(this.transcript, innerWidth, this.theme);
    this.maxTranscriptOffset = Math.max(0, transcript.length - DETAIL_TRANSCRIPT_VISIBLE_LINES);
    this.transcriptOffset = Math.min(this.transcriptOffset, this.maxTranscriptOffset);
    const visibleTranscript = transcript.slice(this.transcriptOffset, this.transcriptOffset + DETAIL_TRANSCRIPT_VISIBLE_LINES);
    return roundedPanel(
      [
        this.theme.fg("accent", this.theme.bold(` ${this.frame.frameId} · ${formatTimestamp(this.frame.timestampMs)} `)),
        "",
        ...this.image.render(innerWidth),
        "",
        this.theme.fg(
          "muted",
          ` Transcript ${this.transcriptOffset + 1}-${this.transcriptOffset + visibleTranscript.length}/${transcript.length} `,
        ),
        ...visibleTranscript,
        "",
        this.theme.fg("dim", " ↑↓/j k transcript · Enter/o/Esc return to frame browser "),
      ],
      width,
      this.theme,
    );
  }

  invalidate(): void {
    this.image.invalidate();
  }
}

async function transcriptWindow(pack: SessionPack, timestampMs: number): Promise<string> {
  const path = join(pack.workDir, "video.context.md");
  if (!(await fileExists(path))) return "No captions were available for this video.";
  const text = (await readFile(path)).subarray(0, MAX_CONTEXT_BYTES).toString("utf8");
  for (const section of text.split(/\n(?=## )/)) {
    const range = /^## (\d{2}:\d{2}:\d{2})[–-](\d{2}:\d{2}:\d{2})/m.exec(section);
    if (!range?.[1] || !range[2]) continue;
    const start = timestampFromText(range[1]);
    const end = timestampFromText(range[2]);
    if (start <= timestampMs && timestampMs <= end) return section.trim();
  }
  return "No transcript window was found for this selected frame.";
}

function transcriptLines(transcript: string, width: number, theme: Theme): string[] {
  return transcript.split("\n").flatMap((line) => {
    if (!line) return [""];
    if (line.startsWith("## ")) {
      return wrapTextWithAnsi(line, width).map((part) => theme.fg("accent", theme.bold(part)));
    }

    const captions = line.split(/(?=\[\d{2}:\d{2}:\d{2}\])/).filter(Boolean);
    return captions.flatMap((caption) => formatCaptionLines(caption, width, theme));
  });
}

function formatCaptionLines(caption: string, width: number, theme: Theme): string[] {
  const match = /^(\[\d{2}:\d{2}:\d{2}\])\s*(.*)$/.exec(caption);
  if (!match) return wrapTextWithAnsi(caption, width);

  const timestamp = match[1] ?? "";
  const speech = match[2] ?? "";
  const isSpoken = speech.startsWith(">>");
  const text = isSpoken ? speech.slice(2).trimStart() : speech;
  // Wrap plain text before applying SGR styles. This avoids emitting a partial
  // color sequence when Pi redraws a wrapped transcript line.
  const prefix = `${timestamp}${isSpoken ? " ›" : ""} `;
  return wrapTextWithAnsi(`${prefix}${text}`, width).map((line, index) => {
    if (index > 0) return line;
    const body = line.slice(prefix.length);
    const styledBody = /^\[[^\]]+\]$/.test(body) ? theme.fg("dim", body) : body;
    return `${theme.fg("accent", timestamp)}${isSpoken ? ` ${theme.fg("warning", "›")}` : ""} ${styledBody}`;
  });
}

function timestampFromText(timestamp: string): number {
  const [hours, minutes, seconds] = timestamp.split(":").map(Number);
  return ((hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (seconds ?? 0)) * 1_000;
}

async function loadPack(input: string, cwd: string): Promise<SessionPack> {
  const packPath = await resolvePackPath(input, cwd);
  const manifestPath = join(packPath, "manifest.json");
  const framesPath = join(packPath, "frames.jsonl");
  const manifest = await readManifest(manifestPath);
  const workDir = dirname(packPath);
  const captions = await fileExists(join(workDir, "video.context.md"));
  const captionsByFrame = await readCaptionExcerpts(join(workDir, "inspect.visual.context.md"));
  const frames = await readFrames(framesPath, packPath, captionsByFrame);
  const sourceVideo = stringValue(manifest.source_video, join(workDir, "video.mp4"));

  return {
    version: SESSION_DETAILS_VERSION,
    packPath,
    workDir,
    sourceInput: stringValue(manifest.source_input, "unknown source"),
    sourceVideo: await resolveSourceVideo(sourceVideo, workDir, cwd),
    durationSeconds: finiteNumber(manifest.metadata?.duration_seconds),
    budget: finiteNumber(manifest.budget) ?? frames.length,
    analysisFps: finiteNumber(manifest.analysis_fps) ?? 0,
    captions,
    frames,
  };
}

async function resolvePackPath(input: string, cwd: string): Promise<string> {
  const start = resolve(cwd, input);
  for (const candidate of [start, join(start, "video.frameflame")]) {
    if ((await fileExists(join(candidate, "manifest.json"))) && (await fileExists(join(candidate, "frames.jsonl")))) {
      return realpath(candidate);
    }
  }
  throw new Error(`${input} is not a FlameFrame evidence pack or work directory`);
}

async function readManifest(path: string): Promise<Manifest> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error(`invalid manifest: ${path}`);
  return parsed as Manifest;
}

async function readFrames(path: string, packPath: string, captions: Map<string, string>): Promise<Frame[]> {
  const raw = await readFile(path, "utf8");
  const frames: Frame[] = [];
  for (const [index, line] of raw.split(/\r?\n/).filter(Boolean).entries()) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`invalid frame record ${index + 1} in ${path}`);
    }
    if (!record || typeof record !== "object") throw new Error(`invalid frame record ${index + 1} in ${path}`);
    const item = record as Record<string, unknown>;
    const frameId = stringValue(item.frame_id, "");
    const timestampMs = finiteNumber(item.timestamp_ms);
    const imagePath = stringValue(item.image_path, "");
    if (!frameId || timestampMs === undefined || !imagePath || !isSafeRelativePath(imagePath)) {
      throw new Error(`invalid frame record ${index + 1} in ${path}`);
    }
    const absoluteImage = resolve(packPath, imagePath);
    let realImage: string;
    try {
      realImage = await realpath(absoluteImage);
    } catch {
      throw new Error(`selected image is missing or outside the pack: ${imagePath}`);
    }
    if (!isInside(packPath, realImage) || !(await fileExists(realImage))) {
      throw new Error(`selected image is missing or outside the pack: ${imagePath}`);
    }
    frames.push({
      frameId,
      timestampMs,
      imagePath,
      selectionReason: stringValue(item.selection_reason, "unknown"),
      caption: captions.get(frameId),
    });
  }
  if (frames.length === 0) throw new Error(`no frame records found in ${path}`);
  return frames;
}

async function readCaptionExcerpts(path: string): Promise<Map<string, string>> {
  if (!(await fileExists(path))) return new Map();
  const buffer = await readFile(path);
  const text = buffer.subarray(0, MAX_CONTEXT_BYTES).toString("utf8");
  const excerpts = new Map<string, string>();
  for (const section of text.split(/\n(?=## )/)) {
    const header = /^## .*?—\s*(f_\d+)/m.exec(section);
    if (!header?.[1]) continue;
    const body = section
      .split("\nSuggested zoom:", 1)[0]!
      .split("\n")
      .slice(1)
      .filter((line) => line && !line.startsWith("!["))
      .join(" ")
      .trim();
    if (body) excerpts.set(header[1], truncatePlainText(body, 360));
  }
  return excerpts;
}

function packsFromSession(ctx: ExtensionContext): SessionPack[] {
  const packs = new Map<string, SessionPack>();
  for (const entry of ctx.sessionManager.getBranch()) {
    const details =
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === PROCESS_TOOL_NAME
        ? asFlameFrameDetails(entry.message.details)
        : entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE
          ? asFlameFrameDetails(entry.data)
          : undefined;
    if (details) packs.set(details.pack.packPath, details.pack);
  }
  return [...packs.values()];
}

function workDirFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const workDir = (input as Record<string, unknown>).workDir;
  return typeof workDir === "string" && workDir.trim() ? workDir : undefined;
}

function asFlameFrameDetails(value: unknown): FlameFrameDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<FlameFrameDetails>;
  if (details.version !== SESSION_DETAILS_VERSION || !details.pack || typeof details.pack.packPath !== "string") return undefined;
  return details as FlameFrameDetails;
}

function frameImagePath(pack: SessionPack, frame: Frame): string {
  return resolve(pack.packPath, frame.imagePath);
}

async function resolveSourceVideo(sourceVideo: string, workDir: string, cwd: string): Promise<string> {
  const resolved = resolve(cwd, sourceVideo);
  if (await fileExists(resolved)) return resolved;
  const workVideo = join(workDir, basename(sourceVideo));
  return (await fileExists(workVideo)) ? workVideo : resolved;
}

function zoomCommand(pack: SessionPack, frame: Frame): string {
  const timestamp = formatTimestamp(frame.timestampMs);
  const output = join(pack.workDir, "zooms", timestamp.replaceAll(":", "-"));
  return `flameframe zoom ${shellQuote(pack.sourceVideo)} --at ${timestamp} --window 12 --fps 2 --out ${shellQuote(output)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function frameList(frames: Frame[], selected: number, width: number): string[] {
  const visibleRows = Math.min(5, frames.length);
  // A fixed list height prevents the preview from shifting while the initial
  // selection moves from the first rows into the centered window.
  const from = Math.max(0, Math.min(selected - 2, frames.length - visibleRows));
  return frames.slice(from, from + visibleRows).map((frame, offset) => {
    const index = from + offset;
    const marker = index === selected ? "›" : " ";
    return truncateToWidth(`${marker} ${formatTimestamp(frame.timestampMs)}  ${frame.frameId}`, width);
  });
}

function packLabel(pack: SessionPack): string {
  return pack.sourceInput.length > 48 ? `${pack.sourceInput.slice(0, 45)}…` : pack.sourceInput;
}

function formatTimestamp(timestampMs: number): string {
  const seconds = Math.floor(timestampMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSafeRelativePath(path: string): boolean {
  return !isAbsolute(path) && !path.split(/[\\/]+/).includes("..");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function truncatePlainText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyToClipboard(value: string): Promise<boolean> {
  const commands =
    process.platform === "darwin"
      ? [["pbcopy", []] as const]
      : process.platform === "win32"
        ? [["clip.exe", []] as const]
        : [["wl-copy", []] as const, ["xclip", ["-selection", "clipboard"]] as const];
  for (const [command, args] of commands) {
    if (await writeToProcess(command, args, value)) return true;
  }
  return false;
}

function writeToProcess(command: string, args: readonly string[], value: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const finish = (copied: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      done(copied);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.once("error", () => finish(false));
    child.stdin.end(value);
  });
}
