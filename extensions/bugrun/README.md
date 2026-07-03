# bugrun

Pi-native Python runtime-flow investigation prototype.

- Command: `/bugrun [solve|explore|harden|lab] <question-or-pytest-target>`
- Tools: `bugrun_start`, `bugrun_continue`, `bugrun_status`, `bugrun_expand`, `bugrun_stop`, plus compatibility `bugrun_debug`
- Fixture: `/bugrun fixture`
- Clear UI/live sessions: `/bugrun clear`
- UI: a small Bugrun panel shows the selected mode and pointed instruction

Mental model:

- `/bugrun ...` means “use DAP/debugpy as a runtime microscope.”
- Pick intent first: `solve` for bug fixing, `explore` for mental models, `harden` for abstraction QA, `lab` for playful proof.
- Pytest is the executable stimulus, not the whole answer.
- Static analysis is used to choose stimulus + breakpoints, then stack/locals explain the flow.
- LLM-facing tool content is compact by default; source-centered trace UI is rendered by the extension, not pasted into tool content.

MVP constraints:

- Python/pytest only
- debugpy via direct Python import or `uv run --with debugpy`
- Multi-shot flow: `bugrun_start` starts pytest/debugpy with up to 5 explicit breakpoints, `bugrun_continue` advances to the next stop, `bugrun_expand` prepares a TUI-only expanded trace view.
- `bugrun_debug` remains the one-shot compatibility tool and requires explicit breakpoints
- no expression evaluation; locals/stack only

Examples:

```text
/bugrun explore native.py in relation to pydantic Graph
/bugrun solve tests/test_cart.py::test_discount_total src/shop/cart.py:9
/bugrun harden fbv2 runtime abstraction boundaries
/bugrun lab prove how this request lifecycle works
/bugrun clear
```

Example low-level tool args:

```json
{
  "cwd": "./extensions/bugrun/fixtures/python-shop",
  "test": "tests/test_cart.py::test_discount_total",
  "breakpoints": ["src/shop/cart.py:9"],
  "runner": "uv",
  "uvPackages": ["pytest"],
  "uvNoProject": true,
  "pytestArgs": ["-q", "-p", "no:cacheprovider"]
}
```
