# Pi Agent Extensions

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

Pi Agent Extensions is a local TypeScript workspace for Pi coding-agent extensions, skills, prompt snippets, and development tooling. It is intended to be public source code, while user-specific runtime state stays local and untracked.

## Repository layout

- `extensions/` — Pi extension packages and tests.
- `skills/` — reusable agent skill instructions.
- `prompts/` — reusable prompt templates.
- `agents/` — agent role briefs.
- `combinations/` — extension combination presets.
- `biome.json`, `knip.json`, `vitest.config.mts` — lint, dependency, and test configuration.

## Requirements

- Node.js 20+
- pnpm 10+

## Setup

```bash
pnpm install --frozen-lockfile
```

## Sandboxed Pi workflow

`extensions/pi-sandbox/` keeps agent-controlled shell and file tools sandboxed by default. Bubblewrap gives shell commands a read-only system view, a writable repository and dedicated package caches, while masking SSH/cloud credentials, Pi auth files, private keys, and real `.env*` files. Network access remains available and the extension does not show per-command permission prompts.

Use `/is_sandboxed` to inspect the current session, or type `/is_sandboxed false` explicitly to use host tools for that session. New sessions default back to `true`; process-spawning custom tools fail closed until they are routed through the sandbox or the user disables the session sandbox. `load_dotenv()` source is allowed—the policy protects resolved paths rather than matching the word `env`.

The launchers are:

```bash
~/.pi/agent/bin/pi       # sanitized host environment; sandboxed agent tools
~/.pi/agent/bin/pi-host  # explicit unsanitized launcher escape hatch
```

Set `PI_REAL_BIN` if the launcher cannot resolve Pi through a preserved `~/.local/bin/pi-origin` or `mise which pi`. Activation preserves an existing launcher as `pi-origin`, then places `pi` and `pi-host` symlinks in `~/.local/bin/`. To roll back, remove those two symlinks and rename `pi-origin` back to `pi`.

## Development commands

```bash
pnpm biome       # lint/format check
pnpm knip        # unused files/dependencies check
pnpm test        # run Vitest
pnpm precommit   # full local precommit check
pnpm run ci      # CI-equivalent check
```

## Extensions and skills

Each extension lives under `extensions/<name>/` and typically exports a Pi extension entrypoint from `index.ts`. Tests live beside the extension as `*.test.ts`. Skills in `skills/<name>/SKILL.md` document task-specific operating instructions for the agent.

## Security and privacy

Treat this repository as public source. Do not commit local Pi runtime state, OAuth tokens, session logs, machine-specific settings, or other secrets. Review diffs before pushing, especially when adding new extension fixtures, generated logs, or example configuration.

The following paths are intentionally ignored:

- `auth.json`, `settings.json`, `trust.json`
- `mcp-cache.json`, `mcp-onboarding.json`, `mcp-oauth/`
- `last-notify-window`
- `runs/`, `sessions/`, `goals/`
- `notification-mp3s/`
- `.env*`

If a configuration example is useful, commit a sanitized `*.example.json` file instead of real local state.

## Roadmap

- Stabilize the extension APIs and shared testing patterns.
- Expand reusable skills, prompts, and combination presets.
- Add clearer examples for building and composing local Pi workflows.
- Improve CI coverage for extension packaging and repository hygiene.

## License

License TBD. Do not assume reuse rights until a license is selected and added.
