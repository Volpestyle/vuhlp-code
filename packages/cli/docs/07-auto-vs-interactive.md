# AUTO vs INTERACTIVE (terminal-first)

This design supports your desired toggle:

- In **INTERACTIVE**, everything pauses and **you** prompt agents.
- In **AUTO**, the orchestrator continues prompting until completion.

In a terminal-first product, “pause” must mean:
- no new turns are started automatically
- existing turn commands may complete
- users can still attach to tmux panes and type

---

## Run mode semantics

### AUTO
- orchestrator evaluates graph, finds READY nodes, dispatches turns
- dispatch happens by writing command lines into tmux panes and pressing Enter
- after turns finish, orchestrator ingests results and continues (verify, loop)

### INTERACTIVE
- orchestrator does not dispatch turns
- user triggers turns with:
  - `vulp turn send <node> "..."` (writes into pane)
  - or directly typing into attached tmux pane
- graph state still updates when `vulp` records events/artifacts

> If the user types directly into the pane, `vulp` may not know what happened
> unless you also run log capture and/or wrap commands with markers.
> For v0, prefer `vulp turn send` even in interactive mode so state stays in sync.

---

## Mode toggle workflow

1) `vulp run mode interactive`
   - set a run flag
   - orchestrator loop stops scheduling at next tick boundary

2) user takes over:
   - open panes
   - send turns manually
   - run verify manually

3) `vulp run mode auto`
   - orchestrator resumes scheduling from current graph state

---

## Blocking points
In barebones mode, define blockers clearly:

- `BLOCKED(dependency)` — upstream not done
- `BLOCKED(manual)` — node configured manual-only
- `BLOCKED(approval)` — waiting for explicit approval (optional)
- `BLOCKED(mode)` — run is INTERACTIVE and node needs auto scheduling

These are shown in `vulp viz`.

---

## Concurrency rules (simple)
- allow multiple turns in parallel up to `max_parallel_turns`
- do not run two write-capable nodes in the same workspace concurrently unless using worktrees
- verification typically blocks further “merge” steps (but can run concurrently with read-only nodes)

