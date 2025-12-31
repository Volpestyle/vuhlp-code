# Security

## Threat model

The harness can:
- read/write files in your workspace
- execute shell commands (approval-gated)
- potentially interact with AWS tooling

Risks:
- remote attackers reaching your daemon
- token leakage (logs, screenshots, copied commands)
- unsafe command execution

## Defaults

- `agentd` binds to `127.0.0.1` by default.
- If `HARNESS_AUTH_TOKEN` is set, it must be presented on every API request.

## Recommended remote access patterns

### 1) Tailscale Serve (private)

Expose the daemon over your tailnet only. Use an auth token anyway.

### 2) Cloudflare Tunnel (public with Zero Trust)

Run a tunnel from the machine hosting `agentd`. Enforce:
- SSO/Access policies
- mTLS where appropriate
- token auth at the app layer (`HARNESS_AUTH_TOKEN`)

## Operational guidance

- Do not disable approvals for destructive operations.
- Store run artifacts in a private folder (default is under your home directory).
- Never write secrets into specs; reference secret names instead.
