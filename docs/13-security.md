# Security + privacy

## Local-first

v0 runs locally and stores artifacts under `dataDir` (default `data`).

## Credentials

The daemon does not store provider tokens. Authentication is handled by each provider CLI or API environment variables.

## Logs and artifacts

Provider output, tool events, and artifacts are stored for debugging. If you work with sensitive repos:
- keep `data/` out of git
- review artifacts before sharing

## Command execution

- Provider-native tools execute inside the provider CLI.
- Vuhlp tool execution is gated by node capabilities and global mode.
- Approval gating is controlled per node via `cliPermissionsMode`.
