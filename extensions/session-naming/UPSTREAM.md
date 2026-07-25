# Upstream provenance

- Upstream: https://github.com/furbyhaxx/pi-session-naming
- Tracking fork: https://github.com/AndrewPBerg/pi-session-naming
- Imported release: `v0.2.1`
- Imported commit: `7213eaaba33799903da05acb385e3be424a33426`
- License: MIT; preserved in [`LICENSE`](LICENSE)

## Local adaptation

The upstream production files from `extensions/session/` and `extensions/shared/` were flattened into this directory so Pi's global `extensions/<name>/index.ts` discovery loads the extension directly.

Import paths were adjusted for the flattened layout. The default title model was changed from `auto` to `openai-codex/gpt-5.3-codex-spark`. Upstream test files and package-level build metadata were not vendored; this repository supplies focused Vitest coverage instead.
