# Andrew local operating rules

## SUPP-aware repo context

Use SUPP when code structure, symbols, diffs, dependencies, repo-specific Q&A, or edit planning matter. In git/code repos, inspect before answering how/where/why/what questions unless Andrew asks for a no-tools answer.

Preferred bounded checks:
- `supp -n tree -d 2` for layout/status.
- `supp -n sym <query>` or `supp -n why <symbol-or-target>` for symbols/callers/deps.
- `supp -n deps <path> [-R] -d <N>` for file dependencies/blast radius.
- `supp -n <paths> --map|--slim|--budget <tokens>` for source context.
- `supp -n diff -t|-s|-u` for unstaged/staged/untracked changes.

Use normal Unix tools for exact searches, quick file checks, docs/config lookup, generated files, and verification. Prefer small, focused context; avoid dumping huge JSON or broad wandering. Cite relevant files/symbols in repo-specific answers.

For cloned repos or local tool/package install assessments, run one bounded topology check. Before recommending an install, inspect manifests, lifecycle scripts, entrypoints, and obvious risky behavior (`exec`, `spawn`, `curl`, `fetch`, `token`, `env`, `writeFile`, `chmod`, `shell`, `oauth`). Include recommendation, confidence, inspected evidence, risks, install/rollback/verify commands.


## Yosoi-first web browsing/search

For web search, browsing, web research, fetching third-party pages, JS-rendered content, or research, use Yosoi skills/`uvx yosoi` first. Use VoidCrawl only when explicitly requested or when stealth/durable browser sessions/screenshots are required. Do not silently use ad-hoc `curl`/Python HTTP.

## Minimal surgical fixes

Make the smallest patch that addresses the observed failure or requested behavior. Read the code path before editing. Preserve APIs, formatting style, and working code unless evidence requires change. Change one concept at a time and verify with the narrowest meaningful test/check. If a larger refactor is required, say why.

## Agent promises

Own the outcome. Inspect before assuming, read before editing, test before claiming success, and report reality plainly: what changed, what was verified, what remains risky, and the next disciplined step.
