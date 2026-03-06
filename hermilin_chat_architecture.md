# hermelinChat — Full Stack Architecture Plan
# Upstream-Compatible Integration with Hermes Agent

## Key Insight: Two Integration Paths

Looking at the Hermes Agent architecture, there are **two fundamentally different approaches** to building a web interface, and they plug into different parts of the system:

---

## Approach A: PTY Wrapper (Terminal Proxy)

**What it is:** A Node.js server that spawns `hermes` as a subprocess in a pseudo-terminal, then pipes the PTY to xterm.js in the browser via WebSocket.

```
Browser (xterm.js) ←WebSocket→ Node.js (node-pty) ←PTY→ hermes CLI process
```

**Where it sits:** OUTSIDE hermes-agent. It's a separate project that wraps the CLI binary.

**Pros:**
- Zero changes to hermes-agent codebase
- Gets the FULL TUI experience (prompt_toolkit, Rich, KawaiiSpinner, everything)
- Works with any version of hermes immediately
- Simple to build (~100 lines of server code)

**Cons:**
- The sidebar can't easily know about sessions, tools, or agent state
- Can't hook into tool progress, memory, or other internal events
- It's just a dumb pipe — the React chrome is cosmetic only
- Two separate processes to manage

---

## Approach B: Gateway Platform Adapter (Native Integration)

**What it is:** A new platform adapter in `gateway/platforms/` — like Telegram, Discord, and Slack, but for a web interface. It speaks directly to `AIAgent` via Python, and serves a web frontend.

```
Browser (React + custom chat UI) ←WebSocket→ Flask/FastAPI ←Python→ AIAgent.chat()
                                                              ↑
                                                    gateway/platforms/web.py
```

**Where it sits:** INSIDE hermes-agent as a new gateway platform, following the existing `BasePlatformAdapter` pattern.

**Pros:**
- First-class citizen in the hermes ecosystem
- Direct access to AIAgent, session store (SQLite + FTS5), memory, skills
- Can show real tool progress via `tool_progress_callback`
- Sidebar gets REAL session data from `hermes_state.py`
- Could be upstreamed as a PR to NousResearch/hermes-agent
- Single process — no subprocess management

**Cons:**
- Loses the TUI experience (Rich panels, prompt_toolkit, KawaiiSpinner)
- Need to reimplement the output formatting in the web frontend
- More complex — need to understand hermes internals
- The chat output is just text, not the fancy terminal rendering

---

## Approach C: Hybrid (Recommended)

**What it is:** Combine both. Use PTY wrapping for the main terminal experience, but ALSO hook into hermes internals for the sidebar metadata.

```
┌─────────────────────────────────────────────────────────────┐
│                        BROWSER                               │
│                                                              │
│  ┌──────────┐  ┌──────────────────────────────────────────┐  │
│  │ Sidebar  │  │           xterm.js Terminal               │  │
│  │ (React)  │  │                                           │  │
│  │          │  │  Full hermes TUI via PTY proxy            │  │
│  │ Data via │  │  (banner, tools, chat, spinners, etc.)   │  │
│  │ REST API │  │                                           │  │
│  │ reading  │  │  WebSocket ←→ PTY ←→ hermes process      │  │
│  │ hermes   │  │                                           │  │
│  │ state DB │  └──────────────────────────────────────────┘  │
│  └──────────┘                                                │
└──────────────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         REST API     WebSocket     hermes
         (sessions)   (PTY pipe)    state DB
              │            │            │
              └────────────┼────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Python Server                             │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Flask/FastAPI + python-socketio                      │    │
│  │                                                      │    │
│  │  WebSocket handler:                                  │    │
│  │    - Spawns hermes in PTY (via Python pty module)    │    │
│  │    - Pipes stdin/stdout bidirectionally              │    │
│  │                                                      │    │
│  │  REST API:                                           │    │
│  │    - Reads ~/.hermes/hermes_state.db (SQLite)        │    │
│  │    - Imports hermes_state.py for session queries     │    │
│  │    - Returns session list, search results, config    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Key: the server is Python (not Node.js) so it can          │
│  directly import hermes modules for state access.            │
└──────────────────────────────────────────────────────────────┘
```

**Why Python instead of Node.js:** Hermes Agent is Python. The session store is accessed via `hermes_state.py` which uses SQLite with FTS5. The config is read via `hermes_cli/config.py`. By writing the server in Python, we can `import` these directly instead of reimplementing SQLite queries.

---

## Integration Points with Hermes Agent

### 1. Session Store (`hermes_state.py`)
- SQLite DB at `~/.hermes/hermes_state.db`
- FTS5 full-text search on conversation content
- Query via: `from hermes_state import HermesState`
- Used by sidebar for: session list, search, session details

### 2. Configuration (`hermes_cli/config.py`)
- YAML at `~/.hermes/config.yaml`
- Env vars at `~/.hermes/.env`
- Read for: model name, provider, terminal backend, enabled tools

### 3. Session Files (`~/.hermes/sessions/`)
- JSON logs: `session_20260201_143052_a1b2c3.json`
- Used for: session titles, timestamps, metadata

### 4. CLI Entry Point (`hermes_cli/main.py`)
- The `hermes` binary that we spawn in the PTY
- Supports: `hermes` (new session), `hermes --resume <id>`, `hermes --continue`

### 5. Banner (`hermes_cli/banner.py`)
- Could be customized/forked for hermelinChat branding
- Or leave as-is and let hermes render its own banner

### 6. Skills & Memory
- `~/.hermes/skills/` — skill documents
- `~/.hermes/memory/` — persistent memory
- Could expose via REST API for sidebar browsing

---

## Proposed File Structure

```
hermelin-chat/
├── pyproject.toml                 # Python package
├── hermelin/
│   ├── __init__.py
│   ├── __main__.py                # Entry: `python -m hermelin` or `hermelin`
│   ├── server.py                  # Flask/FastAPI + socketio server
│   ├── pty_handler.py             # PTY spawn + WebSocket bridge for hermes
│   ├── state_reader.py            # Imports from hermes_state.py, reads sessions
│   ├── config.py                  # hermelinChat-specific config
│   └── static/                    # Built React frontend (served by Flask)
│       ├── index.html
│       ├── assets/
│       └── ...
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx
│       ├── components/
│       │   ├── Terminal.jsx       # xterm.js wrapper
│       │   ├── Sidebar.jsx        # Session list from REST API
│       │   └── TopBar.jsx         # Branding, model info
│       ├── hooks/
│       │   ├── useTerminal.js     # xterm.js + WebSocket
│       │   └── useSessions.js     # REST API for session list
│       └── theme.js               # Amber/slate colors
└── README.md
```

---

## How It Runs

```bash
# Install alongside hermes-agent
pip install hermelin-chat

# Or from source
git clone https://github.com/you/hermelin-chat
cd hermelin-chat && pip install -e .

# Run it (hermes must be installed and configured)
hermelin                    # Starts web server on localhost:3000
hermelin --port 8080        # Custom port
hermelin --host 0.0.0.0     # Expose to network (careful!)
```

The server:
1. Starts Flask/FastAPI on the configured port
2. Serves the built React frontend
3. On WebSocket connect: spawns `hermes` in a PTY, pipes I/O
4. REST endpoints read hermes state DB for sidebar data

---

## Upstream Compatibility

### To contribute back to hermes-agent:

**Option 1: Standalone companion package**
- `hermelin-chat` is a separate pip package that depends on `hermes-agent`
- Imports `hermes_state`, `hermes_cli.config` for state access
- Zero changes to hermes-agent needed
- Can be listed as a community integration

**Option 2: Built-in `hermes web` command**
- Add `hermelin/` as a subpackage inside hermes-agent
- Register `hermes web` command in `hermes_cli/main.py`
- Users run `hermes web` to start the web interface
- Most upstream-friendly — single install, single project

**Option 3: Gateway platform adapter**
- Add `gateway/platforms/web.py` following the `BasePlatformAdapter` pattern
- `hermes gateway` automatically starts the web interface alongside Telegram/Discord
- Deepest integration but loses the TUI rendering (would need custom chat formatting)

### Recommended path:
Start as **Option 1** (standalone package), prove it works, then propose **Option 2** (`hermes web`) as a PR to NousResearch/hermes-agent.

---

## MVP Phases

### Phase 1: Bare terminal in browser
- Python server with pty spawn
- xterm.js connecting via WebSocket
- hermes runs, renders its own banner, you can chat
- No sidebar, no chrome — just the terminal

### Phase 2: React chrome
- Add sidebar reading from hermes_state.db
- Add top bar with branding
- Session list, click to resume
- Apply amber/slate theme

### Phase 3: Enhanced features
- Session search (using FTS5 from hermes_state)
- Skills browser in sidebar
- Memory viewer
- Terminal resize handling
- Auth if exposed to network

### Phase 4: Upstream proposal
- Package as `hermes web` command
- Write docs
- Submit PR to NousResearch/hermes-agent

---

## Tech Stack (Revised)

### Backend (Python)
- **Flask** or **FastAPI** — HTTP server + static file serving
- **python-socketio** — WebSocket transport
- **pty** (stdlib) or **pexpect** — PTY spawn for hermes process
- **sqlite3** — Direct reads from hermes_state.db
- Optionally: import `hermes_state`, `hermes_cli.config` directly

### Frontend (React)
- **Vite** — Build tool
- **xterm.js** + addons (fit, webgl, web-links)
- **socket.io-client** — WebSocket to server
- **React** — Sidebar, top bar, layout
- Amber/slate theme from our mockup

### Why not Node.js?
hermes-agent is Python. The state DB, config, session store are all Python modules. Using Python for the server means we can `import hermes_state` instead of reverse-engineering the SQLite schema. This makes us upstream-compatible from day one.
