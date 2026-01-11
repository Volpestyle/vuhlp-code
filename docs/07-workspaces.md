# Workspaces and patches

v0 supports these workspace modes:

- `shared` (default) — run tasks in the existing repo folder
- `worktree` — use `git worktree` to create an isolated workspace per node
- `copy` — copy repo into `.vuhlp/workspaces/...` (slow, but works without git worktrees)

Configure in `vuhlp.config.json`:

```json
{
  "workspace": {
    "mode": "worktree",
    "rootDir": ".vuhlp/workspaces"
  }
}
```

## Why worktrees?

Parallel agent work is easiest when each agent edits in a separate workspace.
This avoids merge conflicts and allows safe diffs.

## Patch capture

After a task completes, v0 tries to capture diffs:

- If git is available:
  - `git diff` and `git status --porcelain`
- Otherwise:
  - store file modification list only (v0)

Artifacts saved:
- `diff.patch`
- `git-status.txt`

## Merge (v1)

v0 includes the node type `merge`, but does not implement automatic merges yet.
v1 should:
- merge worktrees into a dedicated integration branch
- resolve conflicts by spawning conflict-resolution nodes
