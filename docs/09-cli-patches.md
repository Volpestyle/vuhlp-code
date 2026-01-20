# CLI Patches for Multi-Turn Streaming

This document outlines how to patch OpenAI Codex CLI and Google Gemini CLI to support persistent multi-turn streaming like Claude Code.

## Approach: Tracking Branches, Not Forks

Rather than maintaining separate forks, we keep **feature branches** that track upstream:

```bash
# Initial setup
git clone https://github.com/openai/codex.git
cd codex
git remote add upstream https://github.com/openai/codex.git
git checkout -b vuhlp/daemon-mode

# Stay current with upstream
git fetch upstream
git rebase upstream/main
# Resolve conflicts in your daemon additions, push
```

This keeps the daemon additions as a thin layer that rebases cleanly on upstream updates.

## Why Patch?

Claude Code supports a **daemon mode** where:
1. stdin stays open between turns
2. Structured JSON events stream to stdout
3. Conversation history persists in-process
4. Tool approvals can be resolved via stdin

Codex and Gemini CLIs are currently one-shot: they exit after each response. Our patches add the same daemon capability.

## Wire Protocol

Both patches implement the same protocol for consistency with vuhlp's `cli-adapter.ts`.

### Input (stdin)

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"type":"approval.resolved","approvalId":"xxx","resolution":{"status":"approved"}}
{"type":"session.end"}
```

### Output (stdout)

```json
{"type":"message.assistant.delta","delta":"Hello"}
{"type":"message.assistant.thinking.delta","delta":"Let me think..."}
{"type":"message.assistant.thinking.final","content":"Full thinking block"}
{"type":"tool.proposed","tool":{"id":"xxx","name":"bash","args":{"command":"ls"}}}
{"type":"approval.requested","approvalId":"xxx","tool":{"id":"xxx","name":"bash","args":{}}}
{"type":"message.assistant.final","content":"Done.","toolCalls":[]}
{"type":"telemetry.usage","provider":"openai","model":"o3","usage":{"inputTokens":100,"outputTokens":50}}
{"type":"message_stop"}
```

### Protocol Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `user` | stdin | User message to process |
| `approval.resolved` | stdin | Response to an approval request |
| `session.end` | stdin | Graceful shutdown signal |
| `message.assistant.delta` | stdout | Streaming text chunk |
| `message.assistant.thinking.delta` | stdout | Streaming thinking chunk |
| `message.assistant.thinking.final` | stdout | Complete thinking block |
| `message.assistant.final` | stdout | Complete response with tool calls |
| `tool.proposed` | stdout | Tool about to be called (for visibility) |
| `approval.requested` | stdout | Tool needs approval before execution |
| `telemetry.usage` | stdout | Token usage for the turn |
| `message_stop` | stdout | Turn complete, ready for next input |

## OpenAI Codex Patch

**Upstream:** https://github.com/openai/codex
**Branch:** `vuhlp-stream-json`
**Language:** Rust
**Entry point:** `codex vuhlp` subcommand

### Current Status

The daemon mode is implemented via the `Vuhlp` subcommand. The stdin loop, session persistence, streaming deltas, and approval workflow events are supported.

### File Structure

All daemon logic lives in a single file for minimal upstream diff:

```
codex-rs/
├── cli/src/main.rs          # Vuhlp subcommand entry point
└── exec/src/vuhlp.rs        # Daemon loop, protocol types, session management
```

### Protocol Types

```rust
// exec/src/vuhlp.rs

#[derive(Deserialize)]
#[serde(tag = "type")]
enum VuhlpInput {
    #[serde(rename = "user")]
    User { message: VuhlpMessage },

    #[serde(rename = "approval.resolved")]
    ApprovalResolved {
        #[serde(rename = "approvalId")]
        approval_id: String,
        resolution: ApprovalResolution,
    },

    #[serde(rename = "session.end")]
    SessionEnd,
}

#[derive(Deserialize)]
struct VuhlpMessage {
    role: String,
    content: Vec<VuhlpContentPart>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum VuhlpContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct ApprovalResolution {
    status: String,
    #[serde(rename = "modifiedArgs")]
    modified_args: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum VuhlpOutput {
    #[serde(rename = "message.assistant.delta")]
    AssistantDelta { delta: String },

    #[serde(rename = "message.assistant.thinking.delta")]
    ThinkingDelta { delta: String },

    #[serde(rename = "message.assistant.thinking.final")]
    ThinkingFinal { content: String },

    #[serde(rename = "message.assistant.final")]
    AssistantFinal { content: String },

    #[serde(rename = "tool.proposed")]
    ToolProposed { tool: ToolCall },

    #[serde(rename = "approval.requested")]
    ApprovalRequested {
        #[serde(rename = "approvalId")]
        approval_id: String,
        tool: ToolCall,
    },

    #[serde(rename = "telemetry.usage")]
    TelemetryUsage { provider: String, model: String, usage: Usage },

    #[serde(rename = "message_stop")]
    MessageStop,
}
```

### CLI Entry Point

```rust
// cli/src/main.rs

#[derive(Subcommand)]
enum Subcommand {
    // ... other subcommands
    Vuhlp(VuhlpCli),
}

// In main():
Some(Subcommand::Vuhlp(mut vuhlp_cli)) => {
    codex_exec::run_vuhlp(vuhlp_cli, codex_linux_sandbox_exe).await?
}
```

### Daemon Loop (Existing)

The stdin loop and session persistence already work:

```rust
// exec/src/vuhlp.rs - run_vuhlp()

let stdin = BufReader::new(tokio::io::stdin());
let mut lines = stdin.lines();
let mut thread: Option<CodexThread> = None;

loop {
    let Some(line) = lines.next_line().await? else {
        break; // EOF - graceful shutdown
    };

    let input: VuhlpInput = serde_json::from_str(&line)?;

    match input {
        VuhlpInput::User { message } => {
            let prompt = extract_prompt(&message)?;
            // Create or reuse session
            if thread.is_none() {
                thread = Some(CodexThread::new(config.clone()).await?);
            }

            // Stream response
            thread.as_mut().unwrap().run_turn(prompt, |event| {
                println!("{}", serde_json::to_string(&event).unwrap());
            }).await?;

            println!("{}", serde_json::to_string(&VuhlpOutput::MessageStop)?);
        }
        VuhlpInput::ApprovalResolved { approval_id, resolution } => {
            thread.as_mut().unwrap().resolve_approval(approval_id, resolution).await?;
        }
        VuhlpInput::SessionEnd => break,
    }
}
```

### What's Missing (TODO)

None for Codex at the moment (approval workflow, `message_stop`, and `telemetry.usage` are implemented).

## Google Gemini CLI Patch

**Upstream:** https://github.com/google-gemini/gemini-cli
**Branch:** `vuhlp/daemon-mode`
**Language:** TypeScript
**Entry point:** `--input-format stream-json` flag

### Current Status

The daemon mode is **partially implemented** via the `--input-format stream-json` flag. The core stdin loop works (including `message_stop` and `telemetry.usage`), but approval workflow events are missing.

### File Structure

All daemon logic lives in the main CLI file for minimal upstream diff:

```
packages/
└── cli/src/
    ├── gemini.tsx           # Stream-json input loop, protocol handling
    ├── config/config.ts     # CLI args (input-format, core-tools)
    └── nonInteractiveCli.ts # telemetry.usage emission
```

### CLI Flag

```typescript
// packages/cli/src/config/config.ts

.option('--input-format <format>', 'Input format: interactive or stream-json')
.option('--core-tools <tools>', 'Core tools to enable (use "none" to disable all core tools)')

// In main():
if (argv.inputFormat === 'stream-json') {
  await runStreamJsonInputLoop(config, argv);
} else {
  await runInteractive(config);
}
```

### Daemon Loop (Existing)

```typescript
// packages/cli/src/gemini.tsx - runStreamJsonInputLoop()

import * as readline from "readline";

async function runStreamJsonInputLoop(config: Config, argv: Args) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let sessionData: SessionData | undefined;

  for await (const line of rl) {
    const input = JSON.parse(line);

    if (input.type === "message") {
      const result = await runNonInteractive({
        prompt: input.content,
        resumedSessionData: sessionData,
        // Callbacks for streaming
        onDelta: (delta) => emit({ type: "message.assistant.delta", delta }),
        onThinking: (delta) => emit({ type: "message.assistant.thinking.delta", delta }),
        onComplete: (content, tools) => emit({ type: "message.assistant.final", content, toolCalls: tools }),
      });

      sessionData = result.sessionData; // Persist for next turn
      emit({ type: "message_stop" });

    } else if (input.type === "session.end") {
      break;
    }

    // TODO: Handle approval.resolved
  }
}

function emit(event: Record<string, unknown>) {
  console.log(JSON.stringify(event));
}
```

### What's Missing (TODO)

1. **Approval workflow**: Emit `tool.proposed` / `approval.requested` events and apply `approval.resolved` inputs
2. **thinking.final**: Emit complete thinking block (currently only deltas)

## Vuhlp Integration

Once patches are complete, update `packages/providers/src/cli-adapter.ts`:

```typescript
// Remove Claude-only restriction
private shouldUseStreamJsonInput(): boolean {
  return this.config.protocol === "stream-json";
}
```

Then configure the patched binaries:

```bash
# Codex - uses subcommand
VUHLP_CODEX_COMMAND=/path/to/codex/target/release/codex
VUHLP_CODEX_ARGS="vuhlp"
VUHLP_CODEX_PROTOCOL=stream-json

# Gemini - uses flag
VUHLP_GEMINI_COMMAND=/path/to/gemini-cli/bundle/gemini.js
# Optional: add --core-tools none if you want Gemini CLI to disable native tools.
VUHLP_GEMINI_ARGS="--core-tools none"
VUHLP_GEMINI_PROTOCOL=stream-json
```

## Keeping Up with Upstream

```bash
# Codex
cd /path/to/codex
git fetch upstream
git rebase upstream/main
cargo build --release

# Gemini
cd /path/to/gemini-cli
git fetch upstream
git rebase upstream/main
npm run bundle
```

Conflicts are rare since daemon mode changes are additive and localized. If upstream adds their own daemon mode, we can deprecate our patches.

## Implementation Status

| Feature | Codex | Gemini |
|---------|-------|--------|
| Stdin loop | Done | Done |
| Session persistence | Done | Done |
| Streaming deltas | Done | Done |
| Thinking deltas | Done | Done |
| `message_stop` | Done | Done |
| `telemetry.usage` | Done | Done |
| `tool.proposed` | Done | N/A (uses TOOL_USE) |
| `approval.requested` | Done | TODO |
| `approval.resolved` input | Done | Done (parsing only) |

## Remaining Work

| Component | Codex (Rust) | Gemini (TS) |
|-----------|--------------|-------------|
| Approval workflow integration | Needs testing | ~50 lines (tool execution pause) |
| **Total remaining** | Testing | ~50 lines |

**Note:** Codex has upstream type changes that need syncing. Gemini has pre-existing type errors in the sandbox that are unrelated to daemon mode.

## Testing

1. Start the patched CLI in daemon mode
   - Codex: `codex vuhlp`
   - Gemini: `gemini --input-format stream-json`
2. Send a user message via stdin
3. Verify streaming deltas arrive on stdout
4. Verify `message_stop` signals turn completion
5. Send another message, verify session continuity
6. Test tool approval flow:
   - Trigger a tool call (e.g., "list files in current directory")
   - Verify `approval.requested` event
   - Send `approval.resolved` with `{"status":"approved"}`
   - Verify tool executes and result streams back
7. Test skip permissions mode:
   - Codex: `codex vuhlp --dangerously-bypass-approvals-and-sandbox`
   - Verify tools auto-execute without `approval.requested`
