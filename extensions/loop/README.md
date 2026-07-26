# LP Loop Extension

`/lp` runs gated, repeatable engineering workflows inside Pi. A workflow can combine QA, stress, agent, command, prompt, and pull-request stages while requiring typed evidence before it advances.

## Quick start

```text
/lp qa until clean max 3
/lp qa until clean max 3 | stress auto | pr draft if passed
/lp qa-pr
```

Useful commands:

```text
/lp status
/lp stop
/lp resume
/lp list
/lp reload
/lp validate <workflow>
/lp schema
```

## Inline marker

While a loop is running or waiting, the Vim status border displays a breathing green marker:

```text
 LP 1/3
```

`X/Y` is the current attempt and maximum attempts for the active stage. Stages without retries display `1/1`. The marker uses the shared `inline-mode:update` protocol used by MB, FF, and YS, and clears when the loop completes, stops, blocks, or is interrupted.

## Gated results

Gated stages must call `report_loop_stage` exactly once with concrete evidence:

- `clean` — QA found no remaining issue.
- `fixed` — QA changed the diff and requires another pass.
- `passed` — stress, agent, command, or PR work succeeded.
- `blocked` — progress requires external input or unavailable infrastructure.
- `failed` — the stage ran and failed.

A gated stage that settles without a typed report is blocked rather than silently advanced.

## Configuration

Loop workflows are loaded from global and trusted project configuration under `loops/`. See the shipped files in [`../../loops`](../../loops) for examples. `/lp schema` writes a JSON Schema into the current project's Pi configuration directory.

## Development

Focused verification:

```bash
pnpm vitest run extensions/loop/workflow.test.ts extensions/loop/index.test.ts
pnpm exec biome check extensions/loop
```
