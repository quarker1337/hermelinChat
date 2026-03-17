<p align="center">
  <img src="docs/invertelin-banner.svg" alt="hermilinChat" width="1020" />
</p>

<h3 align="center">
  <code>hermilinChat</code>
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

hermilinChat is a hybrid browser interface that wraps Hermes Agent in a proper web UI without losing what makes it powerful - the terminal.

The **main pane** is a real PTY-backed terminal ([xterm.js](https://xtermjs.org/)) running the actual `hermes` CLI process. You get the full agent experience - tools, skills, streaming output - exactly as if you were SSH'd in.

The **sidebar** reads the Hermes Agent SQLite state DB (`~/.hermes/state.db`) directly, giving you session history, full-text search, and quick session switching without touching the terminal.

<p align="center">
  <a href="https://www.youtube.com/watch?v=wnbQeIG-AUo">
    <img src="https://img.youtube.com/vi/wnbQeIG-AUo/maxresdefault.jpg" alt="hermilinChat Demo" width="600" />
  </a>
  <br/>
  <sub>▶ Watch the demo</sub>
</p>

---

## Features

**Terminal-first design** - xterm.js backed by a real PTY. Every keystroke goes to the actual `hermes` process. Tab completion, Ctrl-C, scrollback - it all works.

**Session sidebar** - browse, search, and resume past Hermes sessions. Reads directly from `state.db` with optional auto-generated titles via a metadata DB.

**Artifact panel** - Hermes can create, focus, and manage artifacts (HTML, iframe, code). Complex artifacts can spawn local runner processes, proxied securely through the same origin.

**Built-in artifacts** - optional Strudel editor included with hermilinChat; Hermes can create and focus it once enabled in config

**Runner gateway** - sandboxed iframe artifacts that start their own HTTP servers are proxied via short-lived tokens at `/r/{tab_id}/_t/{token}/...`. No exposed ports, no CORS headaches.

**Single-port deployment** - FastAPI serves the built React SPA, the WebSocket PTY proxy, and the API, all on one port. Throw it behind nginx/caddy and you're done.

---

## Quickstart

```bash
git clone git@github.com:quarker1337/hermilinChat.git
cd hermilinChat

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
git clone git@github.com:quarker1337/hermilinChat.git
cd hermilinChat
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
# HERMELIN_META_DB_PATH=/home/you/.hermes/hermilin_meta.db
# HERMELIN_SPAWN_CWD=/home/you
```

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
cd /opt/hermilinChat          # or wherever you cloned it
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

The artifact panel depends on tools that aren't upstream yet. This repo ships a local patch that adds them to your Hermes install:

`create_artifact` · `remove_artifact` · `clear_artifacts` · `list_artifacts` · `focus_artifact` · `start_runner` · `tail_runner_log` · `stop_runner`

```bash
python3 scripts/install_hermes_artifact_patch.py
```

This detects your installed `hermes` interpreter and patches `model_tools.py` + `toolsets.py` to register the `artifacts` toolset. The update script runs this automatically unless you pass `--skip-hermes-patch`.

> If your Hermes config uses restricted toolsets, make sure `artifacts` or `all` is enabled.

---

## Built-in Strudel artifact

hermilinChat ships a built-in Strudel editor artifact, but it is now **off by default**. This keeps fresh installs clean while still letting you opt in when you want music tooling available.

Enable it in your Hermes home config (`$HERMES_HOME/config.yaml`, usually `~/.hermes/config.yaml`):

```yaml
hermilin:
  default_artifacts:
    strudel: true
```

Behavior notes:

- No config entry means the built-in Strudel tab is not auto-added.
- Setting `hermilin.default_artifacts.strudel: true` enables the built-in editor.
- User/disk artifacts still win over built-ins, so a custom or video-pack Strudel artifact is unaffected.

---

## Runner gateway

Some artifacts are sandboxed iframes. More complex ones spawn their own HTTP server ("runner").

**Problem:** if the iframe points to `127.0.0.1:PORT`, it only works when the browser is on the same machine.

**Solution:** hermilinChat proxies runners through a same-origin gateway:

1. UI mints a short-lived token → `POST /api/runners/{tab_id}/token`
2. iframe src is rewritten → `/r/{tab_id}/_t/{token}/...`
3. hermilinChat proxies HTTP, SSE, and WebSockets to the runner
4. Cookies are NOT forwarded; runner `Set-Cookie` headers are stripped

**Runner discovery:** the runner writes a manifest to `$HERMES_HOME/artifacts/runners/projects/{tab_id}/runner.json` containing `scheme`, `host`, and `port`. If no manifest exists, hermilinChat falls back to parsing the port from the iframe src.

**Runner authoring tips:** bind to `127.0.0.1` (never `0.0.0.0`), use relative URLs so the app works behind the `/r/.../_t/...` prefix.

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

Stored in `hermilin_meta.db` (table: `ui_whispers`), served via `GET /api/whisper`, supports `{user}` placeholder (override with `HERMELIN_DISPLAY_NAME`).

---

## Dev mode

Run backend and frontend separately for hot-reload:

```bash
# Terminal 1: backend
cd hermilinChat && . .venv/bin/activate
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
Description=hermilinChat
After=network.target

[Service]
Type=simple
User=YOURUSER
WorkingDirectory=/opt/hermilinChat
EnvironmentFile=/opt/hermilinChat/.hermelin.env
ExecStart=/opt/hermilinChat/.venv/bin/hermelin --host 127.0.0.1 --port 3000
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

> `--purge-data` deletes `hermilin_meta.db` and `$HERMES_HOME/artifacts/` but does **not** touch your Hermes `state.db`.

---

## Configuration reference

### Core

| Variable | Default | Description |
|---|---|---|
| `HERMES_HOME` | `~/.hermes` | Path to Hermes home directory |
| `HERMELIN_HERMES_CMD` | `hermes` | Hermes executable to spawn |
| `HERMELIN_SPAWN_CWD` | current dir | Working directory for the hermes process |
| `HERMELIN_META_DB_PATH` | `$HERMES_HOME/hermilin_meta.db` | Metadata DB for titles and whispers |
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
| `HERMELIN_COOKIE_SECURE` | `0` | Set to `1` behind HTTPS |
| `HERMELIN_TRUST_X_FORWARDED_FOR` | `0` | Set to `1` behind a trusted proxy only |

### Runner gateway

| Variable | Default | Description |
|---|---|---|
| `HERMELIN_RUNNER_TOKEN_TTL_SECONDS` | `1800` | Runner token lifetime |
| `HERMELIN_RUNNER_TOKEN_BIND_IP` | `1` | Bind tokens to client IP |
| `HERMELIN_TRUSTED_PROXY_IPS` | *(none)* | Only trust XFF from these IPs |
| `HERMELIN_CORS_ORIGINS` | *(none)* | Cross-origin access (disabled by default) |

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
  <sub>hermilinChat is not affiliated with Nous Research. Built on top of the Hermes Agent ecosystem with love and too much coffee.</sub>
</p>
