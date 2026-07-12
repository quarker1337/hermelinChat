<p align="center">
  <img src="docs/invertelin-banner.svg" alt="hermelinChat" width="1020" />
</p>

<h3 align="center">
  <code>hermelinChat</code>
</h3>

<p align="center">
  A browser UI for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> - real terminal, real PTY, real power.<br/>
</p>

<p align="center">
  <sub>🏆 Built for the <a href="https://x.com/NousResearch/status/2029607069934866507">Hermes Agent Hackathon</a> by Nous Research</sub>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#configuration"><strong>Config</strong></a> ·
  <a href="#dev-mode"><strong>Dev Mode</strong></a> ·
  <a href="#deployment"><strong>Deployment</strong></a>
</p>

---

## What is this?

hermelinChat is a hybrid browser interface that wraps Hermes Agent in a proper web UI without losing what makes it powerful - the terminal.

The **main pane** is a real PTY-backed terminal ([xterm.js](https://xtermjs.org/)) running the actual `hermes` CLI process. You get the full agent experience - tools, skills, streaming output - exactly as if you were SSH'd in.

The **sidebar** reads the Hermes Agent SQLite state DB (`~/.hermes/state.db`) directly, giving you session history, full-text search, and quick session switching without touching the terminal.

<p align="center">
  <a href="https://www.youtube.com/watch?v=wnbQeIG-AUo">
    <img src="https://img.youtube.com/vi/wnbQeIG-AUo/maxresdefault.jpg" alt="hermelinChat Demo" width="600" />
  </a>
  <br/>
  <sub>▶ Watch the demo</sub>
</p>

---

## Features

**Terminal-first design** - xterm.js backed by a real PTY. Every keystroke goes to the actual `hermes` process. Tab completion, Ctrl-C, scrollback - it all works.

**Session sidebar** - browse, search, and resume past Hermes sessions. Reads directly from `state.db` with optional auto-generated titles via a metadata DB.

**Artifact panel** - Hermes can create, focus, and manage artifacts (HTML, iframe, code). Complex artifacts can spawn local runner processes, proxied securely through the same origin.

**Built-in artifacts** - optional Strudel editor included with hermelinChat; Hermes can create and focus it once enabled in config

**Runner gateway** - sandboxed iframe artifacts that start their own HTTP servers are proxied via short-lived tokens at `/r/{tab_id}/_t/{token}/...`. No exposed ports, no CORS headaches.

**Single-port deployment** - FastAPI serves the built React SPA, the WebSocket PTY proxy, and the API, all on one port. Throw it behind nginx/caddy and you're done.

---

## Quickstart

```bash
git clone git@github.com:quarker1337/hermelinChat.git
cd hermelinChat

# Creates .hermelin.env (if missing), builds venv + backend deps + frontend
./scripts/install.sh

# Load config
set -a && source .hermelin.env && set +a

# Run
./.venv/bin/hermelin
```

Open **http://127.0.0.1:3000** and you're in.

### Requirements

- **Linux** (PTY-based). macOS may work. Windows is not supported.
- **Python 3.10+**
- **Node.js 18+** (frontend build only)
- **Hermes Agent** installed, with `hermes` on `PATH` and a `state.db` in `~/.hermes/`

---

## Manual install

If you prefer doing things step by step:

**1. Clone**

```bash
git clone git@github.com:quarker1337/hermelinChat.git
cd hermelinChat
```

**2. Backend** (pick one)

```bash
# Option A: uv (recommended)
uv venv && . .venv/bin/activate && uv pip install -e .

# Option B: venv + pip
python3 -m venv .venv && . .venv/bin/activate
pip install -U pip && pip install -e .
```

**3. Frontend**

```bash
cd frontend && npm install && npm run build && cd ..
```

This writes the built SPA into `hermelin/static/`.

**4. Configure**

Create `.hermelin.env` (gitignored):

```dotenv
HERMELIN_ALLOWED_IPS=127.0.0.1,::1
HERMELIN_PASSWORD=change-me
HERMELIN_COOKIE_SECRET=generate-a-long-random-string

# Optional overrides
# HERMELIN_HERMES_CMD=/home/you/.local/bin/hermes
# HERMES_HOME=/home/you/.hermes
# HERMELIN_META_DB_PATH=/home/you/.hermes/hermelin_meta.db
# HERMELIN_SPAWN_CWD=/home/you
# HERMELIN_ARTIFACT_READ_MAX_FILE_BYTES=8388608
# HERMELIN_PTY_PET_ENABLED=1  # opt back into Hermes' terminal-rendered pet; browser canvas pet is default
```

Pet overlay notes:
- The browser overlay follows Hermes' active pet by default and animates from terminal activity using Hermes' canonical pet states: `review`, `run`, `wave`, `jump`, `failed`, `waiting`, and `idle`.
- Position, visible size, and a local pet slug override are available under Settings → UI → Pet overlay.
- The slug override is browser-local; it does not rewrite your Hermes `config.yaml`.

Behind HTTPS? Add `HERMELIN_COOKIE_SECURE=1`.
Behind a trusted reverse proxy? Add `HERMELIN_TRUST_X_FORWARDED_FOR=1`.

```bash
set -a && source .hermelin.env && set +a
```

**5. Run**

```bash
hermelin --host 127.0.0.1 --port 3000
```

---

## Updating

```bash
cd /opt/hermelinChat          # or wherever you cloned it
./scripts/update.sh
sudo systemctl restart hermelin   # if using systemd
```

Or combine update + restart:

```bash
./scripts/update.sh --restart
```

Flags: `--skip-frontend`, `--skip-python`, `--skip-hermes-patch`, `--service NAME`

---

## Hermes artifact tool patch

The artifact panel depends on tools that aren't upstream yet. This repo ships a local patch that adds them to your Hermes install.

Toolsets installed by the patch:
- `artifacts` — generic artifact panel tools (`create_artifact`, `list_artifacts`, runners, focus/remove, etc.)
- `strudel` — Strudel-specific controls (`strudel_get_code`, `strudel_set_code`, `strudel_play`, etc.)

```bash
python3 scripts/install_hermes_artifact_patch.py
```

This detects your installed `hermes` interpreter and patches `model_tools.py` + `toolsets.py` to register the `artifacts` and `strudel` toolsets. The update script runs this automatically unless you pass `--skip-hermes-patch`.

> If your Hermes config uses restricted toolsets, enable `artifacts` for the panel, and add `strudel` only if you want Strudel-specific agent controls.

---

## Built-in Strudel artifact

hermelinChat ships a built-in Strudel editor artifact, but it is now **off by default**. This keeps fresh installs clean while still letting you opt in when you want music tooling available.

Enable it in your Hermes home config (`$HERMES_HOME/config.yaml`, usually `~/.hermes/config.yaml`):

```yaml
hermelin:
  default_artifacts:
    strudel: true
```

Behavior notes:

- No config entry means the built-in Strudel tab is not auto-added.
- Setting `hermelin.default_artifacts.strudel: true` enables the built-in editor.
- User/disk artifacts still win over built-ins, so a custom or video-pack Strudel artifact is unaffected.
- The built-in tab toggle is independent from Hermes toolsets. If you want the agent to control Strudel code/playback too, add `strudel` to your spawned toolsets, for example:

```bash
HERMELIN_HERMES_CMD='hermes chat --toolsets "hermes-cli, artifacts, strudel"'
```

---

## Runner gateway

Some artifacts are sandboxed iframes. More complex ones spawn their own HTTP server ("runner").

**Problem:** if the iframe points to `127.0.0.1:PORT`, it only works when the browser is on the same machine.

**Solution:** hermelinChat proxies runners through a same-origin gateway:

1. UI mints a short-lived token → `POST /api/runners/{tab_id}/token`
2. iframe src is rewritten → `/r/{tab_id}/_t/{token}/...`
3. hermelinChat proxies HTTP, SSE, and WebSockets to the runner
4. Cookies are NOT forwarded; runner `Set-Cookie` headers are stripped

**Runner discovery:** the runner writes a manifest to `$HERMES_HOME/artifacts/runners/projects/{tab_id}/runner.json` containing `scheme`, `host`, and `port`. If no manifest exists, hermelinChat falls back to parsing the port from the iframe src.

**Runner authoring tips:** bind to `127.0.0.1` (never `0.0.0.0`), use relative URLs so the app works behind the `/r/.../_t/...` prefix.

---

## HermelinFleet setup roles

The interactive installer asks one role question:

1. **Local HermelinChat only** (default) — configures no Fleet integration. It does not uninstall Fleet services that were installed previously.
2. **New independent FleetManager** — installs its own Fleet central, local Fleet node, database, credentials, and HermelinChat cockpit. If no `--fleet-source` is supplied, the installer fetches the exact compatible Fleet commit into `~/.local/share/hermelinChat/hermelinfleet-source`. The default private-repository fetch uses GitHub SSH authentication; use `--fleet-source` for an offline/pre-copied checkout or `--fleet-repository` to override the source URL.
3. **Join a remote FleetManager** — enrolls this machine as a managed Fleet node using a five-minute node-bound token. It does not copy the manager's admin/service credential and leaves this machine's local Fleet cockpit disabled. Joining grants that manager trusted tmux command execution as the installing user on this host.

```bash
./scripts/install.sh
```

Scriptable equivalents:

```bash
# Default standalone HermelinChat
./scripts/install.sh --user-service --fleet-role standalone --yes

# Independent loopback-only manager
./scripts/install.sh --user-service --fleet-role manager --yes

# Independent manager reachable by LAN/Tailscale nodes
./scripts/install.sh --user-service --fleet-role manager \
  --fleet-manager-profile overlay \
  --fleet-manager-host 192.168.1.10 \
  --yes

# Join a remote manager without putting the one-time token in argv
umask 077
printf '%s\n' 'PASTE-FRESH-TOKEN' > /tmp/fleet-enrollment.token
./scripts/install.sh --user-service --fleet-role node \
  --fleet-url http://192.168.1.10:8080 \
  --fleet-node-id "$(hostname -s)" \
  --fleet-enrollment-token-file /tmp/fleet-enrollment.token \
  --yes
rm -f /tmp/fleet-enrollment.token
```

For an interactive node join, choose role 3. The installer prints the exact `fleet-enroll <node-id>` command to run on the manager, then reads the fresh token without echoing it.

An overlay manager generates a private CA and IP-SAN server certificate for TLS 1.3 NATS transport. Its HTTP enrollment endpoint remains trusted-LAN/overlay-only; never port-forward ports 8080 or 4222 to the public internet.

Legacy `--fleet-mode off|local|external` automation remains supported. `external` is an advanced cockpit-only bridge and requires a scoped service credential; it is not the normal managed-node join path.

---

## HermelinFleet bridge

hermelinChat can sit next to HermelinFleet without sharing internals. Configure a Fleet central bridge URL on the hermelinChat backend and the UI will show a Fleet cockpit from the topbar `fleet` button:

```dotenv
HERMELIN_FLEET_MODE=external
HERMELIN_FLEET_URL=http://127.0.0.1:8080
HERMELIN_FLEET_SERVICE_TOKEN=[REDACTED]
```

The browser never receives the scoped service credential. It calls hermelinChat's same-origin `/api/fleet/*` routes, and hermelinChat forwards to Fleet's versioned `/api/v1/*` bridge API server-side. The service credential cannot log into Fleet's dashboard, access legacy admin APIs, or request secret-bearing metadata.

`--fleet-mode local` accepts only a Fleet checkout with the exact checked-in API contract in `contracts/hermelinfleet-api-v1.json`. Because the managed local Fleet central is a systemd user service, pair local mode with HermelinChat's `--user-service`; system-service mode fails closed instead of writing a dependency that systemd cannot resolve.

The cockpit shows Fleet status, nodes, agents, session metadata, capabilities, logs, and can inject messages into agents that advertise `inject_task` when `HERMELIN_FLEET_SERVICE_TOKEN` is configured.

This Fleet bridge is separate from existing personal Hermes access. For Desktop-style local/personal Hermes chat, run the Hermes dashboard/TUI backend and connect HermelinChat to that path instead of the messaging gateway:

```bash
hermes dashboard --tui --no-open --insecure --host <lan-or-tailscale-ip> --port 9119
```

Fleet-managed Hermes workers should use HermelinFleet's blank-slate `FLEET_HERMES_HOME` plus profile `fleet`; hermelinChat only consumes their Fleet bridge state.

---

## Optional extras

### Auto session titles

Generates readable titles for sessions via a Hermes cron job (runs every 5 min):

```bash
python3 scripts/install_autotitle_cronjob.py
```

Make sure cron ticks run - either via `hermes gateway install` (recommended) or `hermes cron tick` in an OS cron/timer.

### UI whispers

The mascot easter egg can show random short messages:

```bash
python3 scripts/install_whispers_cronjob.py
```

Stored in `hermelin_meta.db` (table: `ui_whispers`), served via `GET /api/whisper`, supports `{user}` placeholder (override with `HERMELIN_DISPLAY_NAME`).

---

## Dev mode

Run backend and frontend separately for hot-reload:

```bash
# Terminal 1: backend
cd hermelinChat && . .venv/bin/activate
hermelin --reload --port 3000

# Terminal 2: frontend
cd frontend && npm run dev
```

Open **http://localhost:5173** - Vite proxies `/api` and `/ws` to the backend.

---

## Deployment

### systemd service

Create `/etc/systemd/system/hermelin.service`:

```ini
[Unit]
Description=hermelinChat
After=network.target

[Service]
Type=simple
User=YOURUSER
WorkingDirectory=/opt/hermelinChat
EnvironmentFile=/opt/hermelinChat/.hermelin.env
ExecStart=/opt/hermelinChat/.venv/bin/hermelin --host 127.0.0.1 --port 3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermelin
```

### Reverse proxy notes

WebSockets are required for `/ws`. If you terminate TLS at the proxy, set `HERMELIN_COOKIE_SECURE=1` and `HERMELIN_TRUST_X_FORWARDED_FOR=1`.

---

## Uninstall / reset

Basic reset (stops service, removes `.venv/` + `hermelin/static/`):

```bash
./scripts/uninstall.sh --yes
```

Full purge:

```bash
./scripts/uninstall.sh \
  --remove-service \
  --remove-node-modules \
  --remove-cronjobs \
  --purge-data \
  --unpatch-hermes \
  --yes
```

> `--purge-data` deletes `hermelin_meta.db` and `$HERMES_HOME/artifacts/` but does **not** touch your Hermes `state.db`.

---

## Configuration reference

### Core

| Variable | Default | Description |
|---|---|---|
| `HERMES_HOME` | `~/.hermes` | Path to Hermes home directory |
| `HERMELIN_HERMES_CMD` | `hermes` | Hermes executable to spawn |
| `HERMELIN_SPAWN_CWD` | current dir | Working directory for the hermes process |
| `HERMELIN_META_DB_PATH` | `$HERMES_HOME/hermelin_meta.db` | Metadata DB for titles and whispers |
| `HERMELIN_DISPLAY_NAME` | `$USER` | Display name for `{user}` substitutions |
| `HERMELIN_HOST` / `HERMELIN_PORT` | `127.0.0.1` / `3000` | Server bind address |

### Security

| Variable | Default | Description |
|---|---|---|
| `HERMELIN_ALLOWED_IPS` | `127.0.0.1,::1` | IP/CIDR allowlist (`*` = allow all) |
| `HERMELIN_PASSWORD` | *(none)* | Enables password login with signed cookie |
| `HERMELIN_COOKIE_SECRET` | *(none)* | Cookie signing secret (recommended) |
| `HERMELIN_SESSION_TTL_SECONDS` | `43200` | Session lifetime |
| `HERMELIN_SESSION_COOKIE` | `hermelin_session` | Cookie name |
| `HERMELIN_ARTIFACT_READ_MAX_FILE_BYTES` | `8388608` | Artifact JSON read cap in bytes; oversized artifacts still list with a load error |
| `HERMELIN_COOKIE_SECURE` | `0` | Set to `1` behind HTTPS |
| `HERMELIN_TRUST_X_FORWARDED_FOR` | `0` | Set to `1` behind a trusted proxy only |

### Runner gateway

| Variable | Default | Description |
|---|---|---|
| `HERMELIN_RUNNER_TOKEN_TTL_SECONDS` | `1800` | Runner token lifetime |
| `HERMELIN_RUNNER_TOKEN_BIND_IP` | `1` | Bind tokens to client IP |
| `HERMELIN_TRUSTED_PROXY_IPS` | *(none)* | Only trust XFF from these IPs |
| `HERMELIN_CORS_ORIGINS` | *(none)* | Cross-origin access (disabled by default) |

### HermelinFleet bridge

| Variable | Default | Description |
|---|---|---|
| `HERMELIN_FLEET_MODE` | `off` for a fresh install | `off`, `external`, or `local`; disabled mode does not probe Fleet |
| `HERMELIN_FLEET_URL` / `FLEET_BRIDGE_URL` | *(none)* | Fleet central bridge base URL, e.g. `http://127.0.0.1:8080` |
| `HERMELIN_FLEET_SERVICE_TOKEN` | *(none)* | Scoped server-side Fleet bridge credential; never returned to the browser |
| `HERMELIN_FLEET_ADMIN_TOKEN` / `FLEET_ADMIN_TOKEN` | *(ignored by bridge)* | Parsed only for old configuration compatibility; administrator identity is never used for Fleet proxy traffic |
| `HERMELIN_FLEET_TIMEOUT_SECONDS` | `10` | Fleet proxy request timeout |

---

## Troubleshooting

**`state.db` not found** - run `hermes` once to initialize it, or set `HERMES_HOME` to the correct path.

**`hermes` not found** - set `HERMELIN_HERMES_CMD` to the absolute path of your `hermes` binary.

**`No module named pip` in venv** - recreate it (`rm -rf .venv && python3 -m venv .venv`) or install `python3-venv` on Debian/Ubuntu.

---

## AI attribution

This repository was built with extensive assistance from [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research) - an automated AI coding assistant. Large portions of the code, documentation, and all SVG assets are AI-generated. Review and test thoroughly before deploying.

---

<p align="center">
  <sub>hermelinChat is not affiliated with Nous Research. Built on top of the Hermes Agent ecosystem with love and too much coffee.</sub>
</p>
