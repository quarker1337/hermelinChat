# HermelinFleet Compatibility Contract

HermelinChat is standalone. Fleet integration is optional and must never be required for local Hermes terminals, local tmux runtimes, sessions, artifacts, or settings.

## Development compatibility line

- HermelinChat branch: `hermelinfleet` (based on `e33eb20` or newer)
- HermelinFleet branch: `feat/hermelinchat-bridge-runtimes` (based on `b342515` or newer)
- Bridge protocol: HTTP/WebSocket `/api/v1`
- Executable schema fixture: `contracts/hermelinfleet-api-v1.json` (`hermelinfleet-api-v1-2026-07-11`)

Release tags and exact minimum release commits replace the branch references when this feature is merged.

## Required Fleet endpoints

Read/control clients negotiate capabilities rather than assuming every endpoint exists:

- `GET /api/v1/status`
- `GET /api/v1/nodes`
- `GET /api/v1/agents`
- `GET /api/v1/agents/{id}`
- `GET /api/v1/agents/{id}/logs`
- `POST /api/v1/agents/{id}/inject`
- `GET /api/v1/sessions`
- `GET /api/v1/capabilities`

Remote tmux support additionally requires:

- `GET /api/v1/runtimes`
- `GET|POST /api/v1/nodes/{node}/runtimes`
- `POST /api/v1/nodes/{node}/runtimes/{runtime_id}/stop`
- `POST /api/v1/nodes/{node}/runtimes/{runtime_id}/attach-ticket`
- `GET /api/v1/nodes/{node}/runtimes/{runtime_id}/attach` (WebSocket upgrade with the single-use ticket plus the exact `X-Fleet-Attach-User-ID` and `X-Fleet-Attach-Session-ID` values bound when the ticket was minted)

## Capability behavior

- Missing Fleet configuration means Fleet is off; HermelinChat makes no Fleet data requests.
- Missing runtime endpoints degrades to cockpit-only mode.
- Mutating and sensitive read endpoints require the configured server-side Fleet credential.
- The browser never receives Fleet credentials or arbitrary upstream WebSocket URLs.
- `runtime_list`, `runtime_create`, and `runtime_stop` require an upgraded `fleet-node`; rerun the Fleet join/upgrade flow after central changes.
- Remote runtime records must use `can_attach`, `can_stop`, `state`, and `attach_ws_path` rather than UI guesses.

## Security boundary

The supported first remote deployment is loopback or an encrypted private overlay. Direct public exposure of Fleet HTTP, NATS, or Hermes dashboard ports is unsupported until native TLS, scoped identities, per-node authorization, enrollment, and replay protection are enabled.
