---
name: bugrun
description: "Use when the user asks to understand or prove runtime code flow, execution path, state transitions, call stacks, locals, lifecycle behavior, or how one file/module interacts with another. Triggers include: code flow, runtime flow, call path, execution path, trace through, understand how X connects to Y, why this branch/state happens, DAP, breakpoints, stack, locals, debugpy, lldb-dap, dlv dap, js-debug-adapter. Supports Python, Rust, Go, and TypeScript/JavaScript."
---

# Bugrun runtime-flow microscope

Use Bugrun when static code reading alone is likely to miss the actual execution path, state transitions, locals, or lifecycle observer behavior.

## When to use

Use this skill for requests like:

- “I want to understand the code flow between X and Y.”
- “Trace how this runtime/lifecycle path works.”
- “Why does this state/branch/value happen?”
- “Show the call path and locals through this behavior.”
- “Prove which observer/executor/adapter runs.”

Do not stop after `supp`, `rg`, or `read` when the user explicitly asks for runtime/code flow and there is a focused test or small stimulus available. Use static inspection to choose the stimulus and breakpoint lines, then use Bugrun for DAP evidence.

## Workflow

1. Classify intent:
   - `explore`: mental model / code-flow explanation.
   - `solve`: suspected bug fix.
   - `harden`: abstraction/invariant QA.
   - `lab`: playful proof/experiment.
2. Inspect narrowly with SUPP/rg/read to find:
   - the file/symbol mentioned by the user;
   - a focused existing test or smallest test stimulus;
   - 1–5 production-code breakpoint lines where control crosses boundaries or state changes.
3. Run Bugrun:
   - Prefer `bugrun_debug` for one-shot evidence.
   - Prefer `bugrun_start` when you need interactive stepping between stops.
4. Answer from runtime evidence:
   - call path and important stack frames;
   - relevant locals/state transitions;
   - what static inspection alone would have missed;
   - any caveats if a stimulus was synthetic or incomplete.

## Tool examples

Python:

```json
{
  "language": "python",
  "cwd": "/repo",
  "test": "tests/test_runtime.py::test_flow",
  "breakpoints": ["src/runtime/native.py:42", "src/runtime/pipeline.py:118"]
}
```

Rust:

```json
{
  "language": "rust",
  "cwd": "/repo",
  "test": "flow_executes_native_effect",
  "breakpoints": ["src/native.rs:42"]
}
```

Go:

```json
{
  "language": "go",
  "cwd": "/repo",
  "test": "./runtime",
  "testArgs": ["-run", "TestNativeFlow"],
  "breakpoints": ["runtime/native.go:42"]
}
```

TypeScript/JavaScript:

```json
{
  "language": "ts",
  "cwd": "/repo",
  "test": "runtime/native.test.ts",
  "breakpoints": ["src/runtime/native.ts:42"]
}
```

## Adapter requirements

- Python: `debugpy` directly or via `uv run --with debugpy`.
- Rust: `lldb-dap` / CodeLLDB-compatible adapter.
- Go: `dlv` with DAP support.
- TypeScript/JavaScript: `js-debug-adapter` from `vscode-js-debug`.

If an adapter is missing, report the exact missing executable and continue with the best static explanation only after saying runtime evidence could not be collected.
