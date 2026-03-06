hermelinChat
===========

Browser UI for Hermes Agent.

Goals:
- Main pane is a real PTY-backed terminal (xterm.js) running the actual `hermes` CLI.
- Sidebar reads `~/.hermes/state.db` to show session history + search.

Dev quickstart
-------------

Backend (FastAPI + WebSocket PTY proxy):

  cd /home/wayne/projects/hermilinChat
  uv venv
  . .venv/bin/activate
  uv pip install -e .
  hermelin --reload --port 3000

Frontend (Vite + React + xterm.js):

  cd frontend
  npm install
  npm run dev

Then open:
  http://localhost:5173

Production build
----------------

  cd frontend
  npm run build

This writes the built SPA into:
  hermelin/static/

Then run:
  hermelin --port 3000

and open:
  http://localhost:3000

Config
------

Env vars:
- HERMES_HOME: path to Hermes home (default: ~/.hermes)
- HERMELIN_HERMES_CMD: hermes executable to spawn (default: hermes)
- HERMELIN_SPAWN_CWD: working directory to start hermes in (default: current working dir)
- HERMELIN_HOST / HERMELIN_PORT: server bind
- HERMELIN_ALLOWED_IPS: comma-separated allowlist of IPs/CIDRs (default: 127.0.0.1,::1)
- HERMELIN_PASSWORD: if set, enables login (password -> signed HttpOnly cookie)
- HERMELIN_COOKIE_SECRET: cookie signing secret (optional but recommended; otherwise sessions reset on restart)
- HERMELIN_SESSION_TTL_SECONDS: session lifetime in seconds (default: 43200)
- HERMELIN_COOKIE_SECURE: set to 1 if serving over HTTPS (sets Secure cookies)
- HERMELIN_TRUST_X_FORWARDED_FOR: set to 1 to trust X-Forwarded-For / X-Real-IP (ONLY behind a trusted reverse proxy)
