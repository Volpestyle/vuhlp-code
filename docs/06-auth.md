# Authentication

## Principle

v0 is **local-first** and delegates authentication to the provider harnesses.

vuhlp code does not store provider tokens itself.

## Codex

- Authenticate using Codex CLI’s built-in login flow.
- vuhlp code simply checks availability by running a minimal command.

## Claude Code

- Authenticate with Claude Code CLI setup.
- vuhlp code can run `claude -p "ping"` to check auth readiness.

## Gemini

- Authenticate with Gemini CLI’s built-in Google flow.
- vuhlp code can run `gemini -p "ping" --output-format json` to check readiness.

## UI “Connect” buttons (v1)

In v0, authentication steps are documented.

In v1, add:
- “Connect OpenAI” button that opens an embedded terminal to run `codex login`
- “Connect Anthropic” button that runs `claude` auth flow
- “Connect Google” button that runs `gemini` auth flow

## Security note

vuhlp code should never:
- copy tokens out of the harness credential stores
- transmit tokens to remote servers
- log tokens into artifacts
