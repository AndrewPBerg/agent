# Combinations

Combinations are lightweight YAML affordances that describe when separate Pi extensions or skills should work well together.

They are **not** agent instructions to read directly by default. The `combinations` extension loads these YAML files, validates them, selects relevant cards from session signals, then injects only compact distilled guidance into the agent system prompt.

## Mental model

- Extensions stay independent: `qa`, `bugrun`, `supp-first`, `yosoi-workflows`, `flameframe`, etc.
- Combinations describe useful interactions between those capabilities.
- The agent sees selected guidance, obligations, and preferred capabilities — not raw YAML.
- Use combinations to avoid writing one-off skills for every pairwise extension interaction.

## Current seed

`qa-plus-bugrun.yaml` says:

- When the user asks for QA/review/stress testing,
- and Python files changed,
- and BugRun tools are available,
- then QA should pair with BugRun runtime evidence when correctness depends on stack frames, locals, call path, or state transitions.

## YAML shape

```yaml
id: qa-plus-bugrun
description: Pair QA/diff review with BugRun runtime evidence for Python changes.
priority: 50
enabled: true
when:
  prompts:
    - qa
    - review
  fileExtensions:
    - .py
  tools:
    - bugrun_debug
guidance: |
  Compact workflow guidance injected into the system prompt when this combination matches.
preferredTools:
  - supp.diff-context
  - bugrun.runtime-evidence
obligations:
  - Inspect staged, unstaged, and untracked changes.
  - Run a focused verification check or explain why one is unavailable.
```

## Selection signals

The MVP matcher uses:

- current user prompt substring matches from `when.prompts`
- changed file extensions from `git status --short --untracked-files=all`
- currently active tool names from Pi's tool registry

All trigger lists are optional. Empty lists mean “no constraint.”

## Future expansion ideas

- richer task-kind detection instead of substring prompts
- session mode signals: planning, loop active, QA active
- evidence ledger signals from `tool_result`
- negative triggers / suppressions
- per-project combinations in `.pi/combinations/`
- counters for whether obligations were actually satisfied

## Important constraint

Do not couple extensions directly just to create a combination. Prefer:

1. keep each extension standalone,
2. add or edit a combination YAML card,
3. let the `combinations` extension compile it into compact prompt guidance.
