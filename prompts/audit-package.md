---
description: Audit a third-party package, extension, MCP server, or CLI before installing
argument-hint: "<source-or-path> [goal]"
---
# Package/install audit

Target: $1
Goal/context: ${@:2}

Decide whether this package/tool should be installed or tried locally. Treat Pi extensions, MCP adapters/servers, browser tools, CLIs, and npm/git packages as code that may run with user permissions.

## Method

1. Identify install surface:
   - package manager/source and version/tag/commit
   - manifest/package metadata
   - declared entrypoints/bin/extensions
   - install/lifecycle scripts (`postinstall`, `preinstall`, `prepare`, native build hooks)
2. If source is remote, clone/fetch into a temp directory and pin the inspected ref.
3. Run bounded SUPP topology unless this is purely docs/config lookup:

   ```bash
   supp -n tree <repo> -d 2
   ```

4. Inspect source shape:

   ```bash
   supp -n <entrypoint> --map
   supp -n deps <entrypoint> -d 1
   ```

   If SUPP fails or the language/path is unsupported, say so and fall back to focused `read`/`rg`.

5. Use exact search/read for risk strings:

   ```bash
   rg -n "postinstall|preinstall|prepare|exec|spawn|child_process|curl|fetch|token|env|writeFile|chmod|shell|oauth|browser|profile" <repo>
   ```

6. Check tests/release hygiene when available:
   - current tag/commit
   - test files or CI config
   - license
   - dependency/runtime footprint

## Answer shape

- Recommendation: yes / no / try temporarily
- Confidence: low / medium / high
- Inspected evidence: files/commands/ref
- Main risks and mitigations
- Safer install command, pinned if possible
- Rollback command
- Verification command after install

Prefer concise judgment over a source dump.
