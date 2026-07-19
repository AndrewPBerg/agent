---
name: flameframe
description: Process local video files and video URLs into compact, timestamped evidence packs with FlameFrame. Use when the user asks to inspect, summarize, search, or answer questions about a video.
---

# FlameFrame

Use FlameFrame to turn a video URL or local video into agent-readable evidence before drawing conclusions from it.

## Workflow

1. Process the video into a deterministic work directory:

   ```sh
   flameframe process <URL_OR_VIDEO> --work-dir .flameframe/<slug>
   ```

2. Read `<work-dir>/video.context.md` first when it exists.
3. Read `<work-dir>/inspect.visual.context.md` next.
4. Open selected frames only when the markdown evidence is insufficient.
5. Request closer evidence around a timestamp when needed:

   ```sh
   flameframe zoom <work-dir>/video.mp4 --at <TIMESTAMP> --out <work-dir>/zooms/<timestamp>
   ```

Cite timestamps and distinguish transcript evidence from visual evidence. Do not infer details that the evidence pack does not support.
