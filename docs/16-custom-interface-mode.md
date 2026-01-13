# Custom Interface Mode

Custom interface mode provides enhanced observability and control for orchestrating AI coding agents through the vuhlp-code daemon.

## Overview

Custom interface mode enables:

- **Dual-channel observability**: Structured events + raw console output
- **Provider-specific session continuity**: Resume sessions with Claude, Codex, and Gemini
- **Rich event streaming**: Messages, tools, approvals, and handoffs
- **Human-in-the-loop**: Global approval queue for tool execution control

## Event Model

### Message Events

```typescript
// User prompt sent to a node
"message.user" -> { nodeId, content }

// Streaming assistant response deltas
"message.assistant.delta" -> { nodeId, delta, index? }

// Final assembled assistant response
"message.assistant.final" -> { nodeId, content, tokenCount? }

// Chain-of-thought / reasoning output
"message.reasoning" -> { nodeId, content }
```

### Tool Events

```typescript
// Tool execution proposed (with args and risk level)
"tool.proposed" -> { nodeId, tool: { id, name, args, riskLevel } }

// Tool execution started
"tool.started" -> { nodeId, toolId }

// Tool execution completed (success or error)
"tool.completed" -> { nodeId, toolId, result?, error?, durationMs? }
```

### Console Events

```typescript
// Raw console output chunk (stdout/stderr)
"console.chunk" -> { nodeId, stream, data, timestamp }
```

### Approval Events

```typescript
// Tool requires user approval
"approval.requested" -> { nodeId, approvalId, tool, context?, timeoutMs? }

// Approval resolved (approved/denied/modified/timeout)
"approval.resolved" -> { nodeId, approvalId, resolution }
```

### Handoff Events

```typescript
// Work delegated from one agent to another
"handoff.sent" -> { fromNodeId, toNodeId, edgeId, payload? }

// Results reported back from child to parent
"handoff.reported" -> { fromNodeId, toNodeId, edgeId, payload? }
```

## Provider Session Continuity

Each provider supports session resumption for multi-turn conversations:

| Provider | Session ID Source | Resume Flag |
|----------|-------------------|-------------|
| Claude | `init.session_id` | `--session-id <id>` or `--resume <id>` |
| Codex | `thread.started.thread_id` | `codex exec resume <thread_id>` |
| Gemini | `init.session_id` | `--resume <session_id>` |

Session IDs are captured via provider mappers and stored in the session registry for later retrieval.

## Approval System

The approval queue provides human-in-the-loop control over tool execution.

### Risk Levels

Tools are assigned risk levels based on their potential impact:

- **low**: Read-only operations (Read, Glob, Grep, WebSearch)
- **medium**: Write operations (Write, Edit, npm install)
- **high**: Destructive operations (rm, sudo, chmod, kill)

### Approval Flow

1. Provider proposes a tool execution via `tool.proposed`
2. If tool requires approval, `approval.requested` is emitted
3. Node execution blocks until resolution
4. User can: Approve, Deny, or Modify (with edited args)
5. `approval.resolved` is emitted and execution continues/stops

### API Endpoints

```
GET  /api/approvals          # List pending approvals
POST /api/approvals/:id      # Resolve approval
     body: { action: "approve" | "deny" | "modify", feedback?, modifiedArgs? }
```

## UI Components

### Node Inspector (Tabbed)

The inspector provides 7 tabs for deep node introspection:

1. **Overview**: Status, timing, costs, metadata
2. **Conversation**: Chat-style message history with streaming
3. **Tools**: Tool execution list with status and results
4. **Files**: File changes with diff viewer
5. **Context**: Instruction payload, constraints, parent context
6. **Events**: Filterable event log
7. **Console**: Terminal output with ANSI support

### Approval Queue

A global slide-out panel accessible from any view:

- Floating badge shows pending count
- High-risk items trigger visual pulse
- Expandable items with command preview
- Actions: Approve, Deny, Modify

### Graph Animations

The workflow graph visualizes agent handoffs:

- **Provider badges**: Colored borders indicate provider (Claude=amber, Codex=emerald, Gemini=indigo)
- **Edge types**: Solid=dependency, Dashed=handoff, Dotted=report
- **Animated packets**: Data flows visualized as moving dots along edges

## Provider Event Mappers

Raw provider output is parsed through mappers that emit canonical events:

### Claude Mapper (`claudeMapper.ts`)

Parses `--output-format stream-json`:
- `init` → `session`
- `assistant_partial` → `message.delta`
- `assistant` → `message.final`, `tool.proposed`, `tool.started`
- `tool_use` → `tool.proposed`, `tool.started`
- `tool_result` → `tool.completed`

### Codex Mapper (`codexMapper.ts`)

Parses `--json` JSONL output:
- `thread.started` → `session`
- `item.message` → `message.final`
- `item.reasoning` → `message.reasoning`
- `item.command_execution` → `tool.proposed`, `tool.started`, `tool.completed`
- `item.file_change` → `diff`

### Gemini Mapper (`geminiMapper.ts`)

Parses `--output-format stream-json`:
- `init` → `session`
- `delta` → `message.delta`
- `thinking` → `message.reasoning`
- `message` → `message.final`
- `tool_use` → `tool.proposed`, `tool.started`
- `tool_result` → `tool.completed`

## Configuration

Enable custom interface features in daemon config:

```typescript
{
  approvalQueue: {
    defaultTimeoutMs: 60000,  // 1 minute default timeout
    autoDenyOnTimeout: true,  // Auto-deny if not resolved
  },
  providers: {
    claude: {
      flags: ["--output-format", "stream-json", "--include-partial-messages"],
      resumableSessions: true,
    },
    codex: {
      flags: ["--json", "--ask-for-approval", "never"],
      resumableSessions: true,
    },
    gemini: {
      flags: ["--output-format", "stream-json"],
      resumableSessions: true,
    },
  },
}
```

## Testing

Run the test suite:

```bash
pnpm --filter @vuhlp/daemon test
```

Tests cover:
- Provider mappers (Claude, Codex, Gemini event parsing)
- Approval queue (request/resolve lifecycle, timeouts)
