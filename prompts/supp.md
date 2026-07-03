---
description: SUPP-aware coding workflow for repo context, edits, review, and validation
argument-hint: "<goal>"
---
# SUPP-aware repo workflow

Goal: $ARGUMENTS

Use `supp` as Andrew's code-aware context layer when it helps. SUPP complements Unix tools; it does not replace them entirely. It supports Rust, Go, Python, TypeScript/TSX, JavaScript, Java, C, C++, JSON, and Markdown symbol/context extraction.

## Tool posture

Prefer SUPP when the task needs repository structure, code symbols, diffs, dependency context, source bundles, or edit planning.

Raw `ls`, `find`, `rg`, `grep`, `cat`, and file reads are still valid when they are the simplest direct tool: exact strings, quick directory checks, config/doc lookup, generated files, or verification.

Avoid broad wandering. If you are doing multiple raw searches/reads to understand code, switch to SUPP.

If you clone, enter, or assess a code repository, run one bounded SUPP topology command unless the task is purely literal docs/config lookup:

```bash
supp -n tree <repo> -d 2
```

## Third-party install/package assessments

When evaluating a package, Pi extension, MCP adapter/server, CLI, browser tool, or other local executable, do not recommend install from README claims alone. Do a small source-shape review:

1. inspect manifest/package metadata and declared entrypoints
2. inspect install/lifecycle scripts (`postinstall`, `preinstall`, `prepare`, native build hooks)
3. inspect topology with `supp -n tree <repo> -d 2`
4. inspect entrypoint API with `supp -n <entrypoint> --map`
5. inspect local dependency direction with `supp -n deps <entrypoint> -d 1`
6. use `rg`/`read` for exact risky strings: `exec`, `spawn`, `child_process`, `curl`, `fetch`, `token`, `env`, `writeFile`, `chmod`, `shell`, `oauth`, browser/profile paths
7. check release/tag hygiene and tests when available

Install recommendation answers should include:

- recommendation: yes / no / try temporarily
- confidence
- what was inspected
- main risks
- pinned or temporary install command
- rollback command
- verification command

## Useful SUPP commands

Prefer `-n`/`--no-copy` in Pi so output prints instead of changing the clipboard.

- `supp -n tree -d 2` — project structure and git status.
- `supp -n tree <path> -d 3` — narrower subtree.
- `supp -n diff -t|-s|-u` — tracked unstaged/staged/untracked local changes.
- `supp -n diff` — branch-vs-default diff for branch/PR-style review.
- `supp -n sym <query>` — symbol definitions.
- `supp -n why <symbol-or-target>` — definition, docs, callers, dependencies, hierarchy.
- `supp -n deps <path> -d 2` — file dependency graph.
- `supp -n deps <path> -R -d 1` — reverse deps / blast-radius-ish check.
- `supp -n todo [path]` — TODO/FIXME/HACK/XXX comments.
- `supp -n <paths>` — source context bundle.
- `supp -n <paths> --map` — signatures/API surface.
- `supp -n <paths> --slim` — compact source.
- `supp -n <paths> --budget 12000` — token-bounded context packing.

Do not dump huge `--json` output and write ad-hoc Python/Node/Ruby/Perl to parse it. Do not pipe SUPP to `head`; narrow the SUPP question instead with path, `-d`, `--map`, `--slim`, `--budget`, or `--regex`.

## Rust and Go notes

- Rust: use `supp -n sym`, `supp -n why`, and `supp -n deps` for structs, traits, enums, functions, modules, imports, and doc comments. Validate with focused `cargo test`/`cargo clippy` where appropriate.
- Go: use `supp -n sym`, `supp -n why`, and `supp -n deps` for structs, interfaces, funcs, imports, and doc comments. Validate with focused `go test` package commands.

## Context engineering target

Less is more. Start with the smallest context that can answer the question. Widen only when uncertainty remains or the task risk requires it.

Use SUPP to surface structural facts that bare Unix often misses: included/excluded paths, docs that define conventions, app/module boundaries, dependency direction, stale paths, CI/test command differences, and risk areas. Include these only when they change what the user should do.

## Minimal surgical fix posture

Karpathy-inspired default: treat each change as a small, testable experiment.

- Fix the bug/request at the closest responsible code path; avoid drive-by rewrites.
- Preserve existing behavior, API shape, naming, and style unless they are proven wrong.
- Prefer deleting or narrowing complexity over adding new abstraction.
- Make one conceptual change, verify, then widen only if evidence demands it.
- If the smallest safe fix is not enough, explicitly explain why before expanding scope.

## Workflow

1. Restate the goal in one sentence.
2. Gather minimal context using SUPP and/or simple Unix tools.
3. If still uncertain, widen one step with a narrower SUPP command before reading many files.
4. Identify the smallest likely edit set.
5. Make minimal, reversible changes.
6. Run the narrowest useful validation command.
7. If validation fails, use the error output to repair once or twice, then summarize.
8. Final summary:
   - files changed,
   - behavior changed,
   - validation run,
   - remaining risks or follow-ups.

Be direct. Prefer concrete commands, diffs, and next actions.
