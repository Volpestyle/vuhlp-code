# Workspaces and Patches

## Workspace Modes

When multiple nodes run in parallel with Auto mode, they may edit files concurrently. Workspace modes control how this is handled:

- `shared` (default) — All nodes work in the same directory
- `worktree` — Each node gets an isolated git worktree
- `copy` — Each node gets a full copy (slow but safe without git)

Configure in `vuhlp.config.json`:

```json
{
  "workspace": {
    "mode": "worktree",
    "rootDir": ".vuhlp/workspaces",
    "cleanupOnDone": false
  }
}
```

## When to Use Worktrees

Use `worktree` mode when:
- Multiple Coder nodes work in parallel
- Orchestrator delegates to subagents that apply changes
- You want clean diffs per agent

Use `shared` mode when:
- Single node workflows
- Read-only or Planning mode workflows
- Sequential node execution

## Patch Capture

When a node completes, v0 captures diffs:

- With git: `git diff` and `git status --porcelain`
- Without git: File modification list only

Artifacts saved:
- `diff.patch`
- `git-status.txt`

These patches can be:
- Reviewed in the Inspector
- Applied by the Orchestrator
- Merged in v1 automatically

## Orchestrator Reconciliation

In Implementation mode, the Orchestrator can:
1. Receive patches from multiple subagents
2. Review for conflicts
3. Apply patches in sequence or merge them

This is the recommended pattern for high-risk changes where subagents report back rather than applying directly.

## Merge Automation (v1)

v1 will add:
- Automatic worktree merging into integration branches
- Conflict detection and resolution nodes
- Smart patch ordering
