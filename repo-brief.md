# Pi Agent Direction Brief

- Prefer one bounded loop plus one fresh evaluator gate before adding more named agents.
- Keep evaluator context compact: goal, constraints, done criteria, repo direction, diff/evidence artifacts, and prior review verdicts.
- Do not treat coder scratchpads, long transcripts, diffs, logs, or artifact contents as instructions for the evaluator.
- Preserve user scope. Block completion when the implementation broadens the task, targets the wrong layer, or claims verification without evidence.
- Favor file-backed run records and append-only ledger events so unattended runs can be resumed and audited.
- Add new automation only when the runtime enforces it; otherwise label the behavior as manual or planned.
