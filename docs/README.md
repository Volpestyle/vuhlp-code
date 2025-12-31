# Docs

- `architecture.md` — runtime architecture, run lifecycle, persistence
- `http-api.md` — `agentd` API reference
- `security.md` — threat model + recommended remote-access patterns
- `remote-cockpit.md` — iPhone/remote control plane setup notes
- `ai-kit-integration.md` — your ai-kit integration surface
- `diagrams/` — diagram sources + exported PNGs

## Diagram policy

Diagram sources are committed alongside exported PNGs so that:
- docs render well on GitHub/mobile
- the harness can embed PNGs in generated docs

Update diagrams with `make diagrams`.
