---
name: wtf-worktrees
description: Use when creating/removing git worktrees or handling worktree env setup. Prefer WTF over raw git worktree commands; use --copy-env for agent worktrees and never expose .env contents.
---

# WTF Worktrees

Default for agent worktrees:

```bash
wtf new <branch> --copy-env --no-serve
```

Disposable/trial worktrees:

```bash
wtf new <branch> --copy-env --no-install --no-serve
```

Inside the `wtf` repo before the released binary is installed:

```bash
go run ./cmd/wtf new <branch> --copy-env --no-install --no-serve
```

## Env safety

- Do not print/read `.env*` contents.
- `--copy-env` copies root and nested `.env*` files, e.g. `app/.env`.
- Verify without exposing values:

```bash
stat -c 'mode=%a size=%s bytes' <file>
test -f <file> && test ! -L <file>
cmp -s <source> <target>
```

## Switching

Use `wtf news <branch> --copy-env --no-serve` only when the user wants shell integration to `cd` into the new worktree.

## Teardown

```bash
git worktree remove <worktree-path>
git branch -D <branch>
```

Check for user changes before removing non-disposable worktrees.
