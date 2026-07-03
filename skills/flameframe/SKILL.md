---
name: flameframe
description: "Use for local video URL/path processing with FlameFrame: download or inspect video URLs, extract captions/transcript markdown, split videos, build .frameflame evidence packs, zoom around timestamps, and load generated context for agent review. Prefer this when users mention YouTube/video URLs, captions, transcript-first video review, frame extraction, or FlameFrame/frameflame."
---

# FlameFrame local video workflow

Use the globally installed local CLI. Do not write ad-hoc Python/Node/shell parsers for FlameFrame workflows; if the CLI cannot do the needed operation, report the missing CLI capability instead of scripting around it.

## Commands

Health check:

```bash
flameframe doctor
```

One-command URL/path processing into a deterministic work directory:

```bash
flameframe process '<URL_OR_VIDEO_PATH>' \
  --work-dir data/downloads/<slug> \
  --max-height 480 \
  --budget 40 \
  --fps 2 \
  --segment-seconds 300 \
  --window-seconds 60
```

Inspect only:

```bash
flameframe inspect '<URL_OR_VIDEO_OR_PACK>'
```

Transcript-first context after processing:

```bash
flameframe context data/downloads/<slug>
```

Zoom around a timestamp selected from transcript context:

```bash
flameframe zoom data/downloads/<slug>/video.mp4 \
  --at 00:12:34 \
  --window 8 \
  --fps 4 \
  --out data/downloads/<slug>/zooms/00-12-34
```

Verify artifacts:

```bash
flameframe verify data/downloads/<slug> --require-segments
```

## Agent reading order

1. Read `inspect.context.md` for the work-dir overview.
2. Read `video.context.md` for transcript-first timestamp windows.
3. Read `inspect.visual.context.md` only when selected frames matter.
4. Use `flameframe zoom` only for transcript windows that need more visual evidence.
5. Reference local files and timestamps; do not invent visual details not represented in generated frames or zoom output.

## Defaults and constraints

- Keep processing local; FlameFrame shells out to local `yt-dlp`, `ffmpeg`, and `ffprobe`.
- Prefer `--max-height 480` for daily agent context unless the user asks for higher resolution.
- Prefer deterministic `--work-dir` paths under `data/downloads/`.
- Do not put raw video contents in chat context. Load markdown context first, then specific images/zoom frames only when needed.
- If a requested workflow requires scripts outside `flameframe`, stop and identify the missing CLI command/flag.
