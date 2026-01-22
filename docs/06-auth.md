# Authentication

v0 is local-first and delegates authentication to provider CLIs. The daemon does not store provider tokens or manage provider sessions.

## Provider auth

- Authenticate using each provider CLI's login flow or supported API key environment variables.
- Vuhlp only resolves the CLI binary (preferring local forks for Codex/Gemini) and logs if the CLI is missing.
- There are no explicit "health check" commands; failures surface when a node starts and the CLI cannot execute.

## Security note

vuhlp code should never log tokens or copy credentials out of provider stores.
