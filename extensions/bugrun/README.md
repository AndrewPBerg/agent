# bugrun

Pi-native runtime-flow investigation prototype for Python first, with language-aware adapter configuration for Rust, Go, and TypeScript.

- Command: `/bugrun [solve|explore|harden|lab] <question-or-test-target>`
- Tools: `bugrun_start`, `bugrun_continue`, `bugrun_status`, `bugrun_expand`, `bugrun_stop`, plus compatibility `bugrun_debug`
- Fixture: `/bugrun fixture`
- Clear UI/live sessions: `/bugrun clear`
- UI: a small Bugrun panel shows the selected mode and pointed instruction

Mental model:

- `/bugrun ...` means “use DAP as a runtime microscope.”
- Pick intent first: `solve` for bug fixing, `explore` for mental models, `harden` for abstraction QA, `lab` for playful proof.
- A focused test command is the executable stimulus, not the whole answer.
- Static analysis is used to choose stimulus + breakpoints, then stack/locals explain the flow.
- LLM-facing tool content is compact by default; source-centered trace UI is rendered by the extension, not pasted into tool content.

Current support:

- Python: full pytest/debugpy execution via direct Python import or `uv run --with debugpy`.
- Rust: `cargo test` launched through `lldb-dap` / CodeLLDB-compatible DAP.
- Go: `go test` launched through Delve DAP (`dlv dap`).
- TypeScript: Node test commands launched through VS Code `js-debug-adapter` (`vscode-js-debug`).

MVP constraints:

- Multi-shot flow is Python-backed today: `bugrun_start` accepts up to 12 explicit breakpoints. At each stop, validate the mental model and revise it before continuing when the new evidence changes it.
- `bugrun_debug` is language-aware and returns runtime evidence for Python, Rust, Go, and TypeScript when the matching local DAP adapter is installed.
- Explicit breakpoints are required.
- No expression evaluation; locals/stack only.

Examples:

```text
/bugrun explore native.py in relation to pydantic Graph
/bugrun solve tests/test_cart.py::test_discount_total src/shop/cart.py:9
/bugrun solve --language rust cart_discount src/lib.rs:42
/bugrun harden fbv2 runtime abstraction boundaries
/bugrun lab prove how this request lifecycle works
/bugrun clear
```

Example low-level Python tool args:

```json
{
  "language": "python",
  "cwd": "./extensions/bugrun/fixtures/python-shop",
  "test": "tests/test_cart.py::test_discount_total",
  "breakpoints": ["src/shop/cart.py:9"],
  "runner": "uv",
  "uvPackages": ["pytest"],
  "uvNoProject": true,
  "pytestArgs": ["-q", "-p", "no:cacheprovider"]
}
```

Example `.pi/debug.json` shape:

```json
{
  "python": { "runner": "uv", "uvPackages": ["pytest"] },
  "rust": { "adapter": "lldb-dap", "testArgs": ["--lib"] },
  "go": { "adapter": "dlv", "testArgs": ["-run", "TestName"] },
  "ts": { "adapter": "js-debug-adapter", "command": "pnpm vitest path/to/file.test.ts" }
}
```
