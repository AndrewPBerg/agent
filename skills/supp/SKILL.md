---
name: supp
description: "Use for codebase context and repo-specific Q&A, especially when inside a git/code repo and answering how/where/why/what about code, behavior, tests, config, dependencies, symbols, diffs, or edit planning. Strongly prefer SUPP for semantic context in Rust/Go/Python/TS/JS/Java/C/C++ repos; use ls/find/rg/read for simple literal checks."
---

# SUPP repository context

SUPP is a code-aware context toolkit originally designed around Claude skills. In Pi, use it as a better default for repository understanding when it gives more signal than raw shell tools.

## Mental model

SUPP is not a hard replacement for Unix tools.

- If the current working directory is inside a git/code repository and the user asks how something works, where code lives, why behavior occurs, what calls/depends on something, which tests/config apply, or wants an implementation explanation, inspect the repository before answering unless they explicitly ask for a no-tools/high-level answer.
- Use SUPP for code-aware context: trees with git status, diffs, symbols, call/dependency context, source bundles, token-aware compression.
- SUPP has broad language support: Rust, Go, Python, TypeScript/TSX, JavaScript, Java, C, C++, JSON, and Markdown. For Rust and Go specifically, prefer SUPP for symbols/imports/deps before falling back to raw search.
- Use `ls`, `find`, `rg`, `grep`, and `read` when they are the simplest direct tool: exact strings, quick directory checks, config/doc lookup, generated files, or verifying a hunch.
- If you clone, enter, or assess a code repository, run one bounded SUPP topology command unless the task is purely literal docs/config lookup: `supp -n tree <repo> -d 2`.
- Avoid broad wandering: do not chain many raw searches/reads when one SUPP command would give structured context.
- Avoid dumping huge JSON and writing ad-hoc scripts to parse it. Narrow with paths, `-d`, `--map`, `--slim`, `--budget`, or `--regex` instead.
- Avoid piping SUPP output to `head`; some commands may report a broken pipe. Narrow with SUPP flags instead.

## Core commands

Prefer `-n`/`--no-copy` in Pi so output prints instead of touching the clipboard.

```bash
supp -n tree -d 2                 # project layout + git status
supp -n tree <path> -d 3          # narrower subtree
supp -n diff -t                   # tracked but unstaged working-tree changes only
supp -n diff -s                   # staged/index changes only
supp -n diff -u                   # untracked files only
supp -n diff                      # branch diff vs default remote for branch review
supp -n sym <query>               # find symbol definitions
supp -n why <symbol-or-target>    # definition, docs, callers, deps, hierarchy
supp -n deps <path> -d 2          # file-level dependencies
supp -n deps <path> -R -d 1       # reverse deps / blast-radius-ish
supp -n todo [path]               # TODO/FIXME/HACK/XXX comments
supp -n <paths>                   # source context bundle
supp -n <paths> --map             # signatures/API surface
supp -n <paths> --slim            # compact source context
supp -n <paths> --budget 12000    # auto-pack within token budget
```

## Selection rules

- For repo-specific questions, gather a small amount of evidence first: `supp -n tree -d 2` for orientation when needed, then `supp -n sym <query>`, `supp -n why <symbol-or-target>`, `supp -n deps <path> -d 1`, `supp -n <path> --map`, or exact `rg`; cite the files/symbols used.
- For non-trivial code changes, use SUPP to plan before reading/editing: topology -> map/symbol/deps -> classification -> focused reads -> edits -> diff.
- Project structure/file location -> `supp -n tree -d 2`; `ls` is fine for a tiny current-dir check.
- Current local changes/commit prep -> use `git status --short` to classify state, then `supp -n diff -s` for staged/index changes, `supp -n diff -t` for tracked-but-unstaged changes, and `supp -n diff -u` for untracked files. For "all local changes", run all three; do not assume `-t` includes staged changes.
- Branch/PR-style review -> `supp -n diff` for default-branch-vs-current branch context.
- Symbol definition -> `supp -n sym <query>` before `rg` for symbol names.
- Symbol behavior/blast radius -> `supp -n why <target>`.
- File dependency graph -> `supp -n deps <path> [-R] -d <N>`.
- Read source files with context -> `supp -n <paths>`; use `--map`, `--slim`, or `--budget` for large areas.
- TODO/FIXME/HACK comments -> `supp -n todo [path]`; raw `rg TODO` is still fine for quick literal checks.
- Exact text/log/config/doc searches -> `rg`, `grep`, `find`, or `read` are normal and acceptable.
- Third-party package/tool/extension install assessment -> do a bounded source-shape review before recommending install: `supp -n tree <repo> -d 2`, inspect manifest/lifecycle scripts/entrypoints, then `supp -n <entrypoint> --map` and `supp -n deps <entrypoint> -d 1` when supported.

## Required workflow for non-trivial repo tasks

Do not start by reading large source files when a map/symbol/dependency view can answer the first question. Use SUPP to shape the problem before loading implementation detail.

Default progression:

1. Topology: `supp -n tree -d 2` or a narrower `supp -n tree <path> -d 2`.
2. Narrow target:
   - exact strings/config/docs: `rg`, `find`, or `read` are fine;
   - APIs and structure: `supp -n <path> --map`;
   - named definitions: `supp -n sym <name>`;
   - dependency/blast-radius questions: `supp -n deps <path> -d 1` or `supp -n why <symbol>`.
3. Before editing, classify the change: app code vs tests vs config vs tooling; policy location vs call-site fixes; module boundary and dependency direction.
4. Prefer changing one policy/tooling point over scattering many call-site edits when the task is about enforcement, linting, or conventions.
5. Read full files only when the map/symbol/deps view is insufficient, the file is small, or an edit needs local implementation detail.
6. After editing, summarize with `git status --short` plus the relevant SUPP diffs: `supp -n diff -s` for staged, `supp -n diff -t` for tracked-but-unstaged, and `supp -n diff -u` for untracked. If unsure, run all three before verification.

Avoid this pattern:

```bash
# too broad as a first move for a large file
read path/to/large_file.py
```

Try this first:

```bash
supp -n path/to/large_file.py --map
supp -n sym relevant_function
supp -n deps path/to/large_file.py -d 1
```

## Policy/linter/config tasks

For repo-specific checks, pre-commit hooks, lint rules, architectural boundaries, and ratchets, decide the enforcement shape before editing application code.

Workflow:

1. Gather candidates with exact search (`rg "pattern" <scope>`).
2. Use SUPP maps/deps to understand where candidates sit in the codebase.
3. Classify each candidate:
   - true violation to refactor now;
   - unavoidable framework/runtime limitation;
   - test-only bridge or fixture concern;
   - wrapper/helper boundary;
   - legacy debt to ratchet.
4. Choose policy shape explicitly:
   - strict fail-now;
   - ratchet with central allowlist;
   - wrapper/helper exemption;
   - path/test exclusions;
   - inline pragma only when local context is uniquely valuable.
5. Prefer centralized allowlists or wrapper exemptions over noisy inline pragmas when source cleanliness matters.
6. Validate both a passing proof-of-concept path/file and a known-failing synthetic or real violation.

## Third-party install assessments

When a package, Pi extension, MCP adapter/server, CLI, browser tool, or other local executable will run with user permissions, answer from evidence rather than README claims alone.

Minimum review:

1. manifest/package metadata and declared entrypoints
2. install/lifecycle scripts (`postinstall`, `preinstall`, `prepare`, native build hooks)
3. bounded topology with SUPP (`supp -n tree <repo> -d 2`)
4. entrypoint surface (`supp -n <entrypoint> --map`) and local deps (`supp -n deps <entrypoint> -d 1`) when SUPP supports the language/path
5. exact risky strings with `rg`/`read`: `exec`, `spawn`, `child_process`, `curl`, `fetch`, `token`, `env`, `writeFile`, `chmod`, `shell`, `oauth`, browser/profile paths
6. release/tag hygiene and tests when available

Install recommendation shape:

- recommendation: yes / no / try temporarily
- confidence
- what was inspected
- main risks
- safer pinned or temporary install command
- rollback command
- verification command

## Language notes

- Rust: `supp -n sym <StructOrFn>`, `supp -n why <symbol>`, and `supp -n deps src/main.rs -d 2` understand `use`, modules, traits, structs, enums, functions, and doc comments. Validate with focused `cargo test`, `cargo clippy`, or package-specific commands.
- Go: `supp -n sym <TypeOrFunc>`, `supp -n why <symbol>`, and `supp -n deps ./path/file.go -d 2` understand structs, interfaces, functions, imports, and doc comments. Validate with focused `go test ./...` or narrower package tests.

## Context engineering: less is more

Start with the smallest context that can answer the question. Widen only when uncertainty remains or the task risk requires it.

Good default progression:

1. quick orientation: `supp -n tree -d 2` or direct `ls` for tiny checks
2. narrow target: `supp -n tree <path> -d 2`, `supp -n sym <query>`, or `rg` for exact text
3. focused understanding: `supp -n why <symbol>`, `supp -n deps <path> -d 1`, or `supp -n <paths> --map`
4. full context only when needed: `supp -n <paths>` or `supp -n <paths> --budget 8000`

## SUPP-aware answer shape

A good SUPP-aware answer synthesizes repo topology, not command output. Include structural facts only when they change what the user should do:

- configured entrypoints and commands, e.g. pytest `testpaths`, Poe tasks, Cargo packages, Go packages
- included vs excluded directories or files when discovery scope matters
- important subtrees and their purpose
- app/module boundaries and dependency direction
- docs or AGENTS/CLAUDE files that define local conventions
- stale paths, mismatches, risky gaps, or likely CI differences
- focused next commands/tests to run

If the user asks a narrow question, answer narrowly and add at most one or two high-signal structural insights.

## Bad loops to avoid

Do not do this unless there is a clear reason:

```bash
supp tree --json > /tmp/tree.json
python - <<'PY'
# parse huge SUPP output by hand
PY
```

Instead, ask SUPP a smaller question:

```bash
supp -n tree llms -d 3
supp -n llms --map --budget 12000
supp -n sym Agent
supp -n deps llms/some_file.py -R -d 1
```
