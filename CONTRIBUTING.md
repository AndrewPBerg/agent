# Contributing

## Setup

1. Install Node.js 20+ and pnpm 10+.
2. Install dependencies:

   ```bash
   pnpm install --frozen-lockfile
   ```

## Development workflow

- Keep changes focused and small.
- Add or update tests for behavior changes.
- Keep local/private Pi state out of commits.
- Prefer sanitized examples (`*.example.json`) over checked-in real configuration.

## Checks

Run the CI-equivalent checks before opening a pull request:

```bash
pnpm run ci
```

This runs:

- `pnpm biome`
- `pnpm knip`
- `pnpm test`

## Pull request checklist

- [ ] The change is scoped to one topic.
- [ ] Tests or docs were updated where appropriate.
- [ ] `pnpm run ci` passes locally, or failures are documented.
- [ ] No secrets, OAuth tokens, local session logs, or machine-specific files are included.
- [ ] Public docs remain accurate.
