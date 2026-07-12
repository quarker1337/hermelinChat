# Secure Remote Deployment

## Supported remote topology

Until native public-mode security is complete, expose HermelinChat only through a trusted TLS edge and carry HermelinChat-to-Fleet and Fleet node traffic over an encrypted private overlay such as Tailscale or WireGuard.

Do not expose these ports directly to the public internet:

- Fleet HTTP/API: 8080
- Fleet NATS transport: 4222
- Hermes dashboard/TUI gateway: 9119

## Recommended layout

1. Browser connects to HermelinChat through HTTPS.
2. HermelinChat authenticates the browser and keeps its scoped `FLEET_HERMELIN_TOKEN` service credential server-side.
3. HermelinChat reaches Fleet central on loopback or an overlay address.
4. Fleet nodes dial central outbound over the overlay.
5. Remote terminals use Fleet's authenticated tmux stream path; do not expose a node's Hermes dashboard directly.

## HermelinChat requirements

- Use `HERMELIN_FLEET_MODE=off` when Fleet is not required.
- Use `local` only for a loopback Fleet central managed on the same host.
- Use `external` only for HTTPS or an explicitly trusted private-overlay endpoint.
- Configure a stable cookie signing secret and Argon2 password hash.
- Use Secure cookies whenever the browser endpoint is HTTPS.
- Trust forwarded headers only from the exact reverse-proxy address.
- Keep `.hermelin.env` mode 0600.
- Do not configure HermelinChat with Fleet's dashboard admin credential; use `HERMELIN_FLEET_SERVICE_TOKEN` or, for reloadable rotation, a mode-0600 `HERMELIN_FLEET_SERVICE_TOKEN_FILE` containing exactly one token.

## Unsupported configurations

- public plain HTTP
- public plain NATS
- credentials in URLs or browser storage
- direct browser access to Fleet central
- directly exposed Hermes dashboard/TUI gateways
- remote terminal access using Fleet's dashboard admin credential

Native public mode remains fail-closed until credential lifecycle for every trust domain, attributable audit review, full compromise/incident tests, and production terminal isolation are implemented and independently verified. Per-node TLS NATS identities/ACLs, signed-command replay protection, and short-lived runtime attach tickets are now present, but those controls alone do not make public mode safe.
