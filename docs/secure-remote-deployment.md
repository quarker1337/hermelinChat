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

## Installer roles

- `--fleet-role standalone` is the default and installs no Fleet components.
- `--fleet-role manager` installs an independent central, local node, and HermelinChat cockpit. `--fleet-manager-profile local` is loopback-only; `overlay` requires an explicit private LAN/Tailscale IPv4 and generates one private CA plus an exact IP-SAN server identity for both HTTPS central traffic and TLS 1.3 NATS.
- `--fleet-role node` enrolls this host from a protected mode-0600 bundle carrying the exact HTTPS manager URL, node ID, five-minute one-use token, and public CA. It does not copy a remote manager's service/admin credentials into HermelinChat and explicitly grants the manager trusted tmux command execution as the installing user.
- Legacy `--fleet-mode external` is cockpit-only. Use only a scoped HermelinChat service credential, never the dashboard administrator token.

## HermelinChat requirements

- Use `HERMELIN_FLEET_MODE=off` when Fleet is not required.
- Use `local` only for a loopback Fleet central managed on the same host.
- Use `external` only for HTTPS or an explicitly trusted private-overlay endpoint.
- Configure a stable cookie signing secret and Argon2 password hash.
- Use Secure cookies whenever the browser endpoint is HTTPS.
- Trust forwarded headers only from the exact reverse-proxy address.
- Keep `.hermelin.env` mode 0600.
- Require HTTPS/WSS for every non-loopback Fleet bridge, enrollment, and runtime-attach URL. For a managed overlay, trust the generated private CA through `HERMELIN_FLEET_CA_FILE`; HermelinChat loads that owner-controlled, non-writable trust anchor into both HTTP and WebSocket clients. Loopback HTTP/WS is the only production exception.
- Prefer `fleet-enroll --bundle <node-id> <file>` for node enrollment. Transfer the resulting mode-0600 file over an authenticated secure channel; it binds the exact manager URL, node ID, one-time token, and public CA.
- Do not configure HermelinChat with Fleet's dashboard admin credential; use `HERMELIN_FLEET_SERVICE_TOKEN` or, for reloadable rotation, a mode-0600 `HERMELIN_FLEET_SERVICE_TOKEN_FILE` containing exactly one token.

## Unsupported configurations

- public plain HTTP
- public plain NATS
- credentials in URLs or browser storage
- direct browser access to Fleet central
- directly exposed Hermes dashboard/TUI gateways
- remote terminal access using Fleet's dashboard admin credential

Native public mode remains fail-closed until credential lifecycle for every trust domain, attributable audit review, full compromise/incident tests, and production terminal isolation are implemented and independently verified. Per-node TLS NATS identities/ACLs, signed-command replay protection, and short-lived runtime attach tickets are now present, but those controls alone do not make public mode safe.
