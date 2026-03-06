hermilinChat
===========

Browser UI for Hermes Agent.

This is intentionally a hybrid UI:
- Main pane is a real PTY-backed terminal (xterm.js) running the actual `hermes` CLI.
- Sidebar reads the Hermes Agent SQLite state DB (`~/.hermes/state.db`) for session history + full-text search.


Requirements
------------

- Linux (PTY-based). macOS may work. Windows is not supported.
- Python 3.12+
- Node.js 18+ (only needed to build/run the frontend)
- A working Hermes Agent install, providing:
  - `hermes` on PATH (or configure `HERMELIN_HERMES_CMD`)
  - a Hermes home directory with `state.db` (default: `~/.hermes/state.db`)


Install / run (single-port, "production-style")
-----------------------------------------------

1) Clone:

  git clone git@github.com:quarker1337/hermilinChat.git
  cd hermilinChat

2) Backend (pick one):

Option A: uv (recommended)

  uv venv
  . .venv/bin/activate
  uv pip install -e .

Option B: venv + pip

  python3 -m venv .venv
  . .venv/bin/activate
  pip install -U pip
  pip install -e .

3) Build the frontend into the Python package (served by FastAPI):

  cd frontend
  npm install
  npm run build
  cd ..

This writes the built SPA into:
  hermelin/static/

4) (Recommended) Create a local env file:

Create `.hermelin.env` (gitignored) and put your settings there. Example:

  # Security
  HERMELIN_ALLOWED_IPS=127.0.0.1,::1
  HERMELIN_PASSWORD=change-me
  HERMELIN_COOKIE_SECRET=generate-a-long-random-string

  # Optional
  # HERMELIN_HERMES_CMD=/home/you/.local/bin/hermes
  # HERMES_HOME=/home/you/.hermes
  # HERMELIN_SPAWN_CWD=/home/you

If you are serving behind HTTPS (recommended for any non-localhost use):

  HERMELIN_COOKIE_SECURE=1

If you are behind a trusted reverse proxy and want real client IPs enforced:

  HERMELIN_TRUST_X_FORWARDED_FOR=1

Load the file into your shell:

  set -a; source .hermelin.env; set +a

5) Run:

  hermelin --host 127.0.0.1 --port 3000

Open:
  http://localhost:3000


Dev mode (2 processes)
----------------------

Backend (FastAPI + WebSocket PTY proxy):

  cd hermilinChat
  . .venv/bin/activate
  hermelin --reload --port 3000

Frontend (Vite + React + xterm.js):

  cd frontend
  npm install
  npm run dev

Open:
  http://localhost:5173

(Vite proxies /api and /ws to http://localhost:3000.)


Running as a systemd service (example)
--------------------------------------

1) Put the repo somewhere stable (example: /opt/hermilinChat), then create venv + install + build frontend.

2) Create /opt/hermilinChat/.hermelin.env with at least:

  HERMELIN_ALLOWED_IPS=...
  HERMELIN_PASSWORD=...
  HERMELIN_COOKIE_SECRET=...
  HERMELIN_HERMES_CMD=...
  HERMES_HOME=...

3) Create:
  /etc/systemd/system/hermelin.service

Example unit file:

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

Then:

  sudo systemctl daemon-reload
  sudo systemctl enable --now hermelin


Reverse proxy notes
-------------------

- WebSockets are required for `/ws`.
- If you terminate TLS at the proxy, set:
  - HERMELIN_COOKIE_SECURE=1
  - HERMELIN_TRUST_X_FORWARDED_FOR=1 (ONLY behind a trusted proxy)


Config reference
----------------

Env vars:
- HERMES_HOME: path to Hermes home (default: ~/.hermes)
- HERMELIN_HERMES_CMD: hermes executable to spawn (default: hermes)
- HERMELIN_SPAWN_CWD: working directory to start hermes in (default: current working dir)
- HERMELIN_HOST / HERMELIN_PORT: server bind

Security:
- HERMELIN_ALLOWED_IPS: comma-separated allowlist of IPs/CIDRs (default: 127.0.0.1,::1)
  - Use '*' to allow all (NOT recommended unless behind strong auth + TLS)
- HERMELIN_PASSWORD: if set, enables password login (signed HttpOnly cookie)
- HERMELIN_COOKIE_SECRET: cookie signing secret (recommended; otherwise sessions reset on restart)
- HERMELIN_SESSION_TTL_SECONDS: session lifetime in seconds (default: 43200)
- HERMELIN_SESSION_COOKIE: cookie name (default: hermelin_session)
- HERMELIN_COOKIE_SECURE: set to 1 if serving over HTTPS
- HERMELIN_TRUST_X_FORWARDED_FOR: set to 1 to trust X-Forwarded-For / X-Real-IP (ONLY behind a trusted reverse proxy)


Troubleshooting
---------------

- state.db not found: run `hermes` once to initialize, or set HERMES_HOME correctly.
- hermes not found: set HERMELIN_HERMES_CMD to the absolute path to your `hermes` binary.
