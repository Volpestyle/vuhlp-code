# How to build (implementation plan)

This is a build guide for implementing `vulp` as a CLI tool.

You can implement in many languages. The docs assume **Node.js + TypeScript**
because it is fast to iterate and works well for process control + JSON parsing.
A Go/Rust implementation is also straightforward and may be preferable for a single static binary.

---

## Recommended v0 tech stack (Node + TS)

- Node.js 20+
- TypeScript
- `commander` (CLI arg parsing) or `oclif`
- `execa` (process spawning) or `child_process.spawn`
- `zod` (schema validation for graph/event JSON)
- `chokidar` (watch mode: detect graph changes for `--watch`)
- `strip-ansi` + `ansi-to-html` (if you later want rich output; optional)

Optional:
- `better-sqlite3` if you want a SQLite run store (v1)

---

## Project structure

```
vulp/
  package.json
  src/
    cli.ts
    commands/
      init.ts
      run.ts
      node.ts
      edge.ts
      turn.ts
      viz.ts
      open.ts
    core/
      runStore.ts
      graph.ts
      events.ts
      lock.ts
      tmux.ts
      adapters/
        codex.ts
        claude.ts
        gemini.ts
        mock.ts
    viz/
      asciiLayout.ts
      asciiRender.ts
  docs/ (this spec)
```

---

## Step-by-step build plan

### Step 1: Run store
- implement `.vulp/` folder creation
- implement `run new`, writes `run.json` and initial `graph.json`
- implement file locking

### Step 2: Graph primitives
- implement add/list/remove nodes and edges
- implement graph validation (no duplicate ids, edges reference existing nodes)

### Step 3: tmux integration
- implement `tmux` wrapper functions:
  - create session
  - create window for node
  - get pane id
  - send keys
  - pipe pane to logs
- implement `vulp open <node>`

### Step 4: Adapter for one provider
- start with `mock` (always works)
- then implement Codex managed turns:
  - construct command line
  - send to tmux pane with marker lines
  - write per-turn log file
  - emit envelope

### Step 5: `vulp turn send`
- run a single turn
- update graph `last_output` for node
- append events

### Step 6: ASCII viz
- implement `vulp viz` list mode first
- add DAG layout mode (layered)

### Step 7: AUTO orchestrator loop (optional for v0)
- implement a simple rule-based orchestrator:
  - if node READY and no output, send initial prompt
  - if verifier exists, run it after implementations
- Later swap to an LLM orchestrator.

---

## Packaging and distribution
- `npm run build` produces `dist/`
- use `pkg` or `nexe` to ship a single binary if desired (optional)
- or distribute via `npm i -g vulp`

---

## Integration tests (recommended)
- tests for:
  - run store creation
  - graph determinism
  - ASCII viz determinism
- smoke test with mock adapter

