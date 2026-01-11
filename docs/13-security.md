# Security + privacy

## Local-first by design

v0 runs locally and stores artifacts on your machine.

## No token handling

v0 does not manage provider tokens.

- Authentication is delegated to Codex/Claude/Gemini harnesses.
- v0 should never print tokens to logs.

## Artifact redaction

v0 stores raw provider outputs to support debugging.
If you use vuhlp code on sensitive codebases:

- keep `.vuhlp/` out of git
- add redaction filters (v1)
- avoid exporting runs without review

## Command execution

Verification commands execute locally.

In v0:
- there is no allowlist enforcement
- treat it like any local dev tool

In v1:
- add command allowlists + path allowlists
- add “approval prompts” for dangerous commands
