# Codex vuhlp stream-json protocol

This document defines the stream-json (newline-delimited JSON) stdin/stdout protocol used by the local Codex fork in vuhlp.

## Binary and mode
- Local fork: `${VUHLP_APP_ROOT}/packages/providers/codex`
- Build: `cargo build -p codex-cli` (from `${VUHLP_APP_ROOT}/packages/providers/codex`)
- Run: `codex vuhlp`
- Mode: long-lived process with stdin kept open across turns.

## Input (stdin)
Each line is either a JSON object or a reset command.

### User message
```
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

### Reset
```
/new
/clear
```
- Starts a fresh thread and clears in-process context.

### Approval resolution
```
{"type":"approval.resolved","approvalId":"<uuid>","resolution":{"status":"approved|denied|modified","modifiedArgs":{}}}
```
- `modifiedArgs` is optional and ignored by Codex vuhlp mode.

### Session end
```
{"type":"session.end"}
```

## Output (stdout)
Each line is a JSON object. Do not write other output to stdout.

### Message events
```
{"type":"message.assistant.delta","delta":"..."}
{"type":"message.assistant.final","content":"..."}
```

### Thinking events
```
{"type":"message.assistant.thinking.delta","delta":"..."}
{"type":"message.assistant.thinking.final","content":"..."}
```

### Usage events
```
{"type":"telemetry.usage","provider":"codex","model":"<model-id>","usage":{"inputTokens":123,"outputTokens":456,"totalTokens":579}}
```

## Errors
- Fatal errors are written to stderr.
- Emit a final error message before exit:
```
{"type":"message.assistant.final","content":"Error: ..."}
```
- Exit with non-zero status on fatal error.

## Notes
- The process handles one prompt at a time; the next prompt is read only after turn completion.
- Unrecognized JSON events are treated as logs by vuhlp.
