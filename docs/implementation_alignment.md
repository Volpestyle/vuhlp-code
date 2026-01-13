# vuhlp code — Implementation Alignment Doc (v0)

> **Legend:**
> - **[v0 IMPLEMENTED]** — Feature is fully implemented in v0
> - **[v0 PARTIAL]** — Types/structure defined, basic implementation exists
> - **[v1 PLANNED]** — Feature is planned for v1, not yet implemented

---

## 0. Core Design Philosophy

### 0.1 Graph-First Orchestration

vuhlp is **not** a fixed orchestration pipeline. Instead, it provides a flexible graph architecture where users build their own orchestration configurations visually.

Key principles:
- **No default pipeline**: Sessions start with a single, unconfigured node
- **User-built workflows**: Users create chains, loops, and hierarchies by connecting nodes
- **Roles are templates**: Roles (Orchestrator, Coder, etc.) are presets for custom instructions, not hardcoded behaviors
- **Full flexibility**: Any orchestration pattern can be constructed in the graph

### 0.2 Hybrid Autonomy

Every node can operate independently:
- **Auto mode**: Node loops continuously, re-executing its initial prompt until goals are met
- **Interactive mode**: User drives the conversation manually

The system supports:
- Per-node Auto/Interactive toggles
- Global Auto/Interactive toggle (affects all nodes)
- Mixed configurations (some nodes auto, some interactive)

### 0.3 Planning vs Implementation Modes

A global toggle that fundamentally changes agent behavior:

**Planning Mode:**
- Agents ask questions and identify gaps
- Agents write ONLY to `/docs/` (or configured directory)
- Codebase is read-only
- Subagents report findings to orchestrators rather than applying changes
- Focus: investigation, design, documentation

**Implementation Mode (Default):**
- Agents can propose and apply code changes
- Orchestrators decide when subagents can apply directly vs. report back
- Safety heuristic: high-risk changes route through orchestrator for reconciliation
- Focus: execution, shipping code

---

## 1. System Architecture

### 1.1 Core Components

| Component | Status |
|-----------|--------|
| Graph Engine | **[v0 IMPLEMENTED]** |
| Node Runtime | **[v0 IMPLEMENTED]** |
| Harness Adapters (Codex, Claude, Gemini) | **[v0 IMPLEMENTED]** |
| State Store (event-sourced) | **[v0 IMPLEMENTED]** |
| Session Registry | **[v0 IMPLEMENTED]** |
| Role Registry | **[v0 IMPLEMENTED]** |
| UI (graph + inspector + chat) | **[v0 IMPLEMENTED]** |

**1. Graph Engine**
- Manages node lifecycle and graph topology
- Routes data between connected nodes
- Handles Auto mode looping logic
- Does NOT impose a fixed execution order

**2. Node Runtime**
- Each node is an independent agent instance
- Maintains its own context and conversation history
- Can be configured with any role or custom instructions
- Operates in Auto or Interactive mode

**3. Harness Adapters**
- CodexAdapter **[v0 IMPLEMENTED]**
- ClaudeCodeAdapter **[v0 IMPLEMENTED]**
- GeminiCLIAdapter **[v0 IMPLEMENTED]**
- MockAdapter **[v0 IMPLEMENTED]**
- Each adapter normalizes: start/resume/send message/stream events/cancel

**4. State Store (event-sourced)**
- Append-only RunEvent log **[v0 IMPLEMENTED]**
- Materialized views: graph state, node status, transcripts, artifacts **[v0 IMPLEMENTED]**
- Session registry (provider session IDs) **[v0 IMPLEMENTED]**

---

## 2. Node Behavior

### 2.1 Default State

When a node is created, it starts with:
- No role assigned (generic CLI interface)
- Interactive mode (user-driven)
- No connections

This allows the user to:
- Use it as a standard CLI session with the configured provider
- Configure it with a role
- Connect it to other nodes

### 2.2 Auto Mode Behavior

**[v0 IMPLEMENTED]**

When a node is set to Auto mode:

**Standalone Node (no connections):**
- The node continuously works on its assigned goal
- The initial prompt is re-executed each loop iteration
- Loop continues until verification passes or goals are met

**Connected Node:**
- The node processes inputs from upstream nodes automatically
- When upstream output arrives, the node executes with that input
- Output is forwarded to downstream nodes

**Looping Examples:**
- `Coder <-> Verifier`: Coder writes code, Verifier runs tests, failures loop back
- `Codex -> Claude -> Codex`: Codex orchestrates, Claude implements, results return

### 2.3 Interactive Mode Behavior

**[v0 IMPLEMENTED]**

When a node is set to Interactive mode:
- User manually drives the conversation
- Node waits for user input before each turn
- Behaves like a standard CLI chat session

---

## 3. Roles and Custom Instructions

### 3.1 Roles as Templates

**[v0 IMPLEMENTED]**

Roles are NOT hardcoded behaviors. They are templates that configure:
- System instructions
- Tool access / capabilities
- Loop behavior hints

Users can:
- Select a preset role
- Modify any aspect of the role
- Create fully custom configurations

### 3.2 Built-in Role Templates

| Role | Capabilities | Use Case |
|------|-------------|----------|
| **Orchestrator** | Spawn subagents, reconcile changes, manage workflow | Supervisory tasks |
| **Coder** | File editing, code generation | Implementation |
| **Planner** | Read-only, doc writing | Requirements analysis |
| **Verifier** | Run commands (tests, lint, build) | Quality checks |
| **Custom** | User-defined | Anything |

### 3.3 Orchestrator Role

**[v0 IMPLEMENTED]**

The Orchestrator role enables:
- Spawning subagent nodes dynamically
- Receiving reports from subagents
- Reconciling disparate changes
- Deciding when subagents apply changes vs. report back

The orchestrator decides based on context:
- **High-risk changes**: Subagents report patches, orchestrator applies after review
- **Scaffolding tasks**: Subagents can work in separate areas and apply directly
- **Conflict potential**: Orchestrator coordinates to avoid merge issues

---

## 4. Workflow Patterns

### 4.1 Single Node (Default Start)

**[v0 IMPLEMENTED]**

Every session starts here:
- One node, no role, no connections
- Behaves as a standard CLI session
- User builds from here

### 4.2 Linear Chain

**[v0 IMPLEMENTED]**

Connect nodes in sequence: `A -> B -> C`
- A's output becomes B's input
- B's output becomes C's input
- Each node can be Auto or Interactive

### 4.3 Feedback Loop

**[v0 IMPLEMENTED]**

Create cycles: `A <-> B`
- Enables iterative refinement
- Example: `Coder <-> Verifier` (write -> test -> fix -> test)

### 4.4 Orchestrator Pattern

**[v0 IMPLEMENTED]**

Hub-and-spoke with orchestrator:
- Orchestrator spawns/manages subagents
- Subagents report back
- Orchestrator reconciles and finalizes

---

## 5. Global Modes

### 5.1 Planning Mode

**[v0 IMPLEMENTED]**

When the global mode is set to Planning:

**Orchestrator behavior:**
- Asks clarifying questions
- Validates requirements
- Spawns planning-focused subagents

**Subagent behavior:**
- Strictly read-only on code
- Scans repo, finds gaps, drafts plans
- Reports findings to orchestrator
- Does NOT apply changes unless explicitly told

**Verification behavior:**
- Checks for "Plan Completeness" rather than "Tests Pass"
- Validates documentation coverage

### 5.2 Implementation Mode

**[v0 IMPLEMENTED]**

When the global mode is set to Implementation (default):

**Orchestrator behavior:**
- Manages the "merge" of changes
- Decides when to apply changes
- Coordinates parallel work

**Subagent behavior:**
- Can apply scaffolding/low-risk changes directly
- Routes refactoring/high-risk changes to orchestrator
- Works in assigned areas to minimize conflicts

**Verification behavior:**
- Runs actual builds, tests, lints
- Reports pass/fail status

### 5.3 Subagent Decision Matrix

| Scenario | Planning Mode | Implementation Mode |
|----------|---------------|---------------------|
| New file scaffolding | Report to orchestrator | Apply directly (if isolated) |
| Refactoring existing code | Report to orchestrator | Report to orchestrator |
| High-risk changes | Report to orchestrator | Report to orchestrator |
| Documentation updates | Apply directly to /docs/ | Apply directly |
| Test changes | Report to orchestrator | Apply directly (if isolated) |

---

## 6. Auto/Interactive Controls

### 6.1 Global Toggle

**[v0 IMPLEMENTED]**

The global Auto/Interactive toggle:
- When switching to Interactive: Stops all new turn scheduling
- When switching to Auto: Resumes automatic scheduling
- Running turns complete before pause takes effect

### 6.2 Per-Node Override

**[v0 IMPLEMENTED]**

Each node can override the global setting:
- `AUTO`: Follows global setting
- `MANUAL`: Always requires manual triggering regardless of global

### 6.3 Pause Semantics

**[v0 IMPLEMENTED]**

Pause is cooperative:
1. `pause_requested` flag is set
2. Current turns complete to a safe boundary
3. Node enters PAUSED state
4. Orchestrator stops scheduling new work

### 6.4 Resume Semantics

**[v0 IMPLEMENTED]**

When resuming:
1. Ingest any changes from interactive period
2. Recompute graph state
3. Schedule next ready nodes

---

## 7. Harness Integration

### 7.1 Codex CLI

**[v0 IMPLEMENTED]**

- Non-interactive mode: `codex exec --json`
- Session resumption: `codex exec resume <session_id>`
- AGENTS.md injection for project context

### 7.2 Claude Code CLI

**[v0 IMPLEMENTED]**

- Streaming output: `--output-format stream-json`
- Session resumption: `--resume <session_id>`
- CLAUDE.md injection for project context

### 7.3 Gemini CLI

**[v0 IMPLEMENTED]**

- Streaming output: `--output-format stream-json`
- Session resumption via session IDs

---

## 8. UI Requirements

### 8.1 Graph Canvas

**[v0 IMPLEMENTED]**

- Drag-and-drop node creation
- Visual wiring between ports
- Real-time status indicators

### 8.2 Node Configuration

**[v0 IMPLEMENTED]**

Per-node configuration panel:
- Role selector (with presets)
- Custom instructions editor
- Provider selector
- Auto/Interactive toggle

### 8.3 Global Controls

**[v0 IMPLEMENTED]**

- Planning/Implementation mode switch
- Global Auto/Interactive toggle
- Start/Stop all auto nodes

---

## 9. Templates (Future)

### 9.1 Workflow Templates

**[v1 PLANNED]**

Save and load common workflow patterns:
- "Code Review Loop" (Coder <-> Reviewer)
- "Feature Pipeline" (Planner -> Coder -> Verifier)
- "Parallel Implementation" (Orchestrator -> [Agent1, Agent2] -> Merger)

### 9.2 Role Templates

**[v0 IMPLEMENTED]**

Built-in presets that users can customize:
- Each role is a starting point, not a constraint
- Users can modify any aspect after applying

---

## 10. Implementation Status Summary

| Feature | Status |
|---------|--------|
| Graph Engine (flexible topology) | **[v0 IMPLEMENTED]** |
| Node lifecycle management | **[v0 IMPLEMENTED]** |
| Auto/Interactive per-node | **[v0 IMPLEMENTED]** |
| Global Auto/Interactive toggle | **[v0 IMPLEMENTED]** |
| Planning/Implementation modes | **[v0 IMPLEMENTED]** |
| Role templates (configurable) | **[v0 IMPLEMENTED]** |
| Custom instructions per node | **[v0 IMPLEMENTED]** |
| Codex CLI adapter | **[v0 IMPLEMENTED]** |
| Claude Code CLI adapter | **[v0 IMPLEMENTED]** |
| Gemini CLI adapter | **[v0 IMPLEMENTED]** |
| Session continuity (all providers) | **[v0 IMPLEMENTED]** |
| AGENTS.md / CLAUDE.md injection | **[v0 IMPLEMENTED]** |
| Event-sourced state store | **[v0 IMPLEMENTED]** |
| WebSocket event streaming | **[v0 IMPLEMENTED]** |
| Graph UI with Cytoscape | **[v0 IMPLEMENTED]** |
| Node inspector/configuration | **[v0 IMPLEMENTED]** |
| Approval queue UI | **[v0 IMPLEMENTED]** |
| Manual node/edge creation | **[v0 IMPLEMENTED]** |
| Verification commands | **[v0 IMPLEMENTED]** |
| Workflow templates (save/load) | **[v1 PLANNED]** |
| Multi-orchestrator nesting | **[v1 PLANNED]** |
| Remote runners | **[v2 PLANNED]** |
