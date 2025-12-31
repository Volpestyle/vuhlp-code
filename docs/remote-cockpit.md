# Remote cockpit (peek/pilot from iPhone)

The harness is **local-first**: `agentd` runs on the machine that has the repo.
To view/approve runs from another device, you typically expose the daemon through a secure tunnel.

## Option A: Tailscale Serve (recommended)

1. Install and sign in to Tailscale on your workstation and iPhone.
2. Start `agentd` bound to localhost:
   ```bash
   ./bin/agentd --listen 127.0.0.1:8787
   ```
3. Use Tailscale Serve to expose a local port to your tailnet (private).
4. Set `HARNESS_AUTH_TOKEN` on the daemon and in your client.

Then open `http(s)://<tailscale-name>:8787/` on your phone.

## Option B: Cloudflare Tunnel (public, Zero Trust)

1. Configure Cloudflare Access + a Tunnel to your machine.
2. Route a hostname to `http://127.0.0.1:8787`.
3. Enforce SSO at Cloudflare and keep `HARNESS_AUTH_TOKEN` enabled.

## Safety tips

- Do not bind `agentd` to `0.0.0.0` without a tunnel + auth.
- Keep approvals enabled for any command that can modify state (infra/shell).
- Avoid writing secrets to specs or logs.
