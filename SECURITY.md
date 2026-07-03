# Security Policy

## Reporting vulnerabilities

Please do not file public issues for suspected vulnerabilities. Report security concerns privately to the repository maintainers. Include:

- affected files or extensions,
- reproduction steps,
- expected impact,
- any suggested mitigation.

## No-secrets policy

This repository must not contain real credentials, OAuth tokens, session logs, private environment values, or machine-specific trust/config state.

Ignored local state includes:

- `auth.json`, `settings.json`, `trust.json`
- `mcp-cache.json`, `mcp-onboarding.json`, `mcp-oauth/`
- `runs/`, `sessions/`, `goals/`
- `notification-mp3s/`
- `.env*`

If any secret is committed, rotate or revoke it immediately and remove it from history before public release.

## Supported versions

This repository is pre-release. Security fixes apply to the current `main` branch unless a release policy is added later.
