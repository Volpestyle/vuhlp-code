# Agent SDK / AgentKit Migration Plan

This doc summarizes the current harness architecture, compares migration options
to Claude Agent SDK and OpenAI AgentKit (Agents SDK), and proposes a phased plan.

## Current integration points (Go)
- Model provider integration via ai-kit:
  - `cmd/agentd/main.go` (provider config + ai-kit init)
  - `internal/agent/runner.go` (plan execution)
  - `internal/agent/session_runner.go` (tool loop + streaming)
  - `internal/agent/specgen.go` (spec generation)
  - `internal/agent/plan.go` (plan generation)
  - `internal/agent/model_service.go` (model listing + policy)
  - `docs/ai-kit-integration.md` (expected surface)
- Tool registry + approvals:
  - `internal/agent/tools.go` (local tools + schemas)
  - `internal/agent/session_policies.go` (approval/verify defaults)
  - `internal/agent/session_runner.go` (approval gating + tool execution)
- API + event model:
  - `internal/api/server.go`
  - `docs/http-api.md`
  - `internal/runstore/*` (events + persistence)

## Constraints / goals
- Local-first execution remains the default.
- Keep daemon (`agentd`) + thin client (`agentctl`) architecture.
- Preserve approvals and append-only event log semantics.
- Spec-driven workflow stays intact.
- Prefer small, testable changes.

## Option A: All-in Claude Agent SDK (Anthropic)
### Summary
Replace ai-kit + Go tool loop with the Claude Agent SDK running in a
TypeScript/Python sidecar. The sidecar owns the agent loop and built-in tools.

### Integration approach
- Build a sidecar service (TS or Python) that exposes a minimal RPC surface:
  - `StartSessionTurn(session_id, workspace, messages, system_prompt, options)`
  - Stream message deltas + tool call events back to `agentd`.
- Use Claude Agent SDK `query(...)` streaming.
- Connect the SDK to local tools via MCP:
  - Implement an MCP server in Go that wraps the existing tool registry.
  - Configure SDK `mcpServers` to point at the MCP server.
  - Gate approvals inside the MCP server using existing runstore logic.
- If MCP is not used, rely on SDK built-in tools and use `PreToolUse` hooks to
  request approvals from `agentd` before execution.

### Pros
- Strong agent loop and code-editing UX out of the box.
- Built-in tools (Read/Write/Edit/Bash/Glob/Grep) reduce custom tooling.
- Hooks give audit/approval interception points.
- Native support for MCP and subagents.

### Cons
- Requires non-Go runtime + Claude Code install.
- Locks runtime to Claude; loses multi-provider flexibility unless you keep
  ai-kit in parallel.
- Tool naming and behavior differ from current registry; mapping is needed.
- Approval flow becomes cross-process (SDK <-> agentd).

### Key code changes
- Add a runtime interface and move the current ai-kit loop behind it.
- Add an MCP server wrapping `internal/agent.ToolRegistry`.
- Replace model policy handling with Claude-specific config (or keep both).
- Update `docs/architecture.md` and `docs/http-api.md` for runtime selection.

## Option B: All-in OpenAI AgentKit (Agents SDK)
### Summary
Adopt OpenAI Agents SDK and AgentKit tooling. The agent loop and tools run in a
sidecar (likely TS/Python). Optional ChatKit can replace or augment the UI.

### Integration approach
- Build a sidecar service around the Agents SDK.
- Expose the same RPC surface as Option A for `agentd`.
- Provide local tools via MCP (preferred) or SDK tool callbacks.
- If you adopt Agent Builder flows, store workflow definitions locally and load
  them at runtime to keep local-first behavior.

### Pros
- Strong eval/optimization tooling and a UI embedding option (ChatKit).
- Deep OpenAI platform integration (tools, vector stores, evals).
- MCP support enables reuse of local tools.

### Cons
- Not Go-native; adds runtime + deployment complexity.
- Tighter coupling to OpenAI workflows and hosted tooling.
- Local-first story weaker if Agent Builder/ChatKit is required.
- Less clarity on hooks/approvals parity vs Claude Agent SDK.

### Key code changes
- Similar to Option A: runtime interface + sidecar + MCP tool server.
- Replace model policy routing with OpenAI model selection or keep ai-kit in
  parallel.
- Rework observability if using OpenAI tracing/evals as system-of-record.

## Option C: Hybrid (recommended)
### Summary
Keep the Go harness as the system of record and add pluggable runtimes:
ai-kit (current), Claude Agent SDK, and OpenAI Agents SDK. Use MCP to expose
the existing tool registry so both SDKs call the same local tools and approvals.

### Integration approach
- Introduce an `AgentRuntime` interface in Go:
  - `RunPlan(ctx, ...)`
  - `RunSessionTurn(ctx, ...)`
  - `StreamEvents(ctx, ...)`
- Implement `AikitRuntime` by wrapping current code.
- Implement `ClaudeRuntime` and `OpenAIRuntime` as sidecar-backed adapters.
- MCP server wraps `ToolRegistry` and enforces approvals via runstore.
- Add runtime selection to config and request payloads (defaults to ai-kit).

### Pros
- Preserves local-first, approvals, and event log semantics.
- Lets you evaluate SDKs incrementally without a hard cutover.
- Keeps multi-provider model routing via ai-kit where needed.
- MCP keeps tool behavior consistent across runtimes.

### Cons
- More moving parts (sidecars + MCP).
- Slightly higher ops/dev complexity.

## Recommendation
Hybrid is the best fit for this repo:
- Your harness is Go-first, local-first, and provider-agnostic via ai-kit.
- Both Agent SDKs are TS/Python and would require sidecars anyway.
- MCP lets you keep a single tool registry and approval gate while testing
  both SDKs.
- Start with Claude Agent SDK as the first sidecar if you want stronger
  code-editing workflows; add OpenAI Agents SDK only if you need ChatKit/evals.

If you want a single-vendor, hosted workflow and are willing to drop the
local-first tool loop, go all-in on the OpenAI stack. Otherwise, avoid a full
cutover.

## Proposed phased plan
1. Spec and decisions
   - Create `specs/agent-sdk-migration/spec.md`.
   - Define runtime selection rules (per run/session, per workspace, or global).
   - Decide whether model policy endpoints remain (ai-kit) or are removed.

2. Runtime abstraction (Go)
   - Add `internal/agent/runtime.go` with an `AgentRuntime` interface.
   - Move ai-kit logic into `AikitRuntime`.
   - Update `internal/api` to select runtime for runs/sessions.

3. MCP tool server (Go)
   - Implement `internal/agent/mcp` or `cmd/agentmcp`.
   - Expose existing tools (repo_tree, read_file, apply_patch, shell, verify).
   - Gate approvals using current runstore approval flows.
   - Ensure tool results are serialized as message parts consistently.

4. Claude Agent SDK sidecar
   - Add a small TS or Python service under `cmd/claude-agentd` (or similar).
   - Wire SDK `query(...)` stream to Go via RPC or SSE.
   - Configure `mcpServers` to call the Go MCP tool server.
   - Map session messages to SDK prompts and stream deltas back to runstore.

5. OpenAI Agents SDK sidecar
   - Mirror the Claude sidecar structure for OpenAI.
   - If using Agent Builder flows, load workflow JSON from disk.
   - Connect MCP tools and stream deltas back to `agentd`.

6. Runtime selection + config
   - Add `HARNESS_RUNTIME` (aikit|claude|openai).
   - Add per-session override field in the session create API.
   - Extend `agentctl` to set runtime for runs/sessions.

7. Docs + tests
   - Update `docs/architecture.md` and `docs/http-api.md`.
   - Add a new `docs/agent-runtime.md` describing runtimes + MCP.
   - Add unit tests for runtime adapters and MCP tool server.
   - Run `make test` and keep coverage stable.

## Open questions
- Do we want to keep ai-kit as the default runtime or switch to Claude?
- Are built-in SDK tools acceptable, or must every tool go through MCP?
- How should approval prompts flow if tool execution happens in a sidecar?
- Do we want SDK session persistence, or will runstore remain the source of truth?
- Should model selection live in Go (policy + router) or in the SDK config?
