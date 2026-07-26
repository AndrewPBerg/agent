# Pi Agent Extensions

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

Pi Agent Extensions is a local TypeScript workspace for Pi coding-agent extensions, skills, prompt snippets, and development tooling. It is intended to be public source code, while user-specific runtime state stays local and untracked.

## Repository layout

- `extensions/` — Pi extension packages and tests.
- `skills/` — reusable agent skill instructions.
- `prompts/` — reusable prompt templates.
- `agents/` — agent role briefs.
- `combinations/` — extension combination presets.
- `loops/` — named, schema-validated `/lp` workflows and stress profiles.
- `schemas/` — JSON Schemas for authoring YAML configuration.
- `biome.json`, `knip.json`, `vitest.config.mts` — lint, dependency, and test configuration.

## Requirements

- Node.js 20+
- pnpm 10+

## Setup

```bash
pnpm install --frozen-lockfile
```

## Sandboxed Pi workflow

`extensions/pi-sandbox/` can sandbox agent-controlled shell and file tools with Bubblewrap. When enabled, shell commands get a read-only system view, a writable repository and dedicated package caches, while SSH/cloud credentials, Pi auth files, private keys, and real `.env*` files are masked. Network access remains available and the extension does not show per-command permission prompts.

New sessions default to `false`; an explicit toggle is restored when resuming that session. Use `/sandboxed` to toggle protection for the current session. `/is_sandboxed` reports its state; `/is_sandboxed true|false` sets it explicitly (with argument completion). While enabled, process-spawning custom tools fail closed until they are routed through the sandbox. `load_dotenv()` source is allowed—the policy protects resolved paths rather than matching the word `env`.

The same extension lets ordinary `bash` calls yield after 10 seconds without changing the model-visible tool schema. A yielded process continues in the background, appears in the `/mailbox` monitor, and pushes a batched follow-up when it exits. Use `/bash-yield <seconds|off>` to configure the session, `/bash-jobs` for a summary, and `/bash-stop <job-id|all>` to cancel running jobs. The existing `bash.timeout` remains a hard process deadline; the yield threshold never kills the command.

The launchers are both unsandboxed and preserve the host environment:

```bash
~/.pi/agent/bin/pi       # normal launcher; sandboxing is opt-in per session
~/.pi/agent/bin/pi-host  # compatibility alias for the unsandboxed launcher
```

Set `PI_REAL_BIN` if the launcher cannot resolve Pi through a preserved `~/.local/bin/pi-origin` or `mise which pi`. Activation preserves an existing launcher as `pi-origin`, then places `pi` and `pi-host` symlinks in `~/.local/bin/`. To roll back, remove those two symlinks and rename `pi-origin` back to `pi`.

## Network resume

`extensions/network-resume/` watches an idle TUI session after a transport-level HTTP or WebSocket failure. It polls NetworkManager's `nmcli -t -f CONNECTIVITY general`; only `full` is online, while a failed or unavailable probe is `unknown` and gets a bounded retry instead of waiting forever. The armed worker is persisted in the session and resumes after Pi restarts. Its mailbox follow-up asks the agent to continue from the last successful step without repeating tool side effects.

## Gated loop workflows

`extensions/loop/` provides `/lp`, a persistent gated workflow runner. The default `/lp qa-pr` workflow repeats `/qa` until clean, runs all matching stress profiles through the push-based subagent mailbox, then pushes the branch and creates a draft PR after the current diff fingerprint passes every gate.

Useful commands:

```text
/lp qa-pr
/lp qa until clean max 3 | stress auto | pr draft if passed
/lp status
/lp stop
/lp resume
/lp list
/lp validate qa-pr
/lp schema
```

Global workflows load from `~/.pi/agent/loops/*.yaml`; trusted projects may override them from `.pi/loops/*.yaml`. `/lp schema` writes `.pi/loop-workflow.schema.json` for YAML language-server completion and validation. PR mode is configurable as `prepare`, `draft`, `ready`, or `off`; the shipped default is `draft`.

Async stress stages use correlated mailbox events rather than polling. Ordinary `spawn_agent` jobs keep their existing pushed follow-up behavior.

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
