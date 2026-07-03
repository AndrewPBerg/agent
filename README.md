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

Do not commit local Pi runtime state, OAuth tokens, session logs, or machine-specific settings. The following paths are intentionally ignored:

- `auth.json`, `settings.json`, `trust.json`
- `mcp-cache.json`, `mcp-onboarding.json`, `mcp-oauth/`
- `last-notify-window`
- `runs/`, `sessions/`, `goals/`
- `notification-mp3s/`
- `.env*`

If a configuration example is useful, commit a sanitized `*.example.json` file instead of real local state.

## License

License TBD. Do not assume reuse rights until a license is selected and added.
