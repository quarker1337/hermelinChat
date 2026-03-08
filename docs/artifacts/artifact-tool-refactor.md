# Artifact Tool Refactor — Step by Step

You are refactoring the render_panel tool into a cleaner artifact system. Follow each step in order. Confirm completion before moving to the next.

---

## Step 1: Rename and restructure the tool file

Rename `tools/render_panel_tool.py` to `tools/artifact_tool.py`.

Replace/Update/Change the two existing methods (`render_pa`, `close_pa`) with these four:

| Method | Purpose |
|--------|---------|
| `create_artifact` | Create or update an artifact in the panel |
| `remove_artifact` | Delete a single artifact by tab_id |
| `clear_artifacts` | Delete multiple artifacts by scope |
| `stop_runner` | Kill a background updater process |

Update all imports in `model_tools.py` and `toolsets.py` to point to `tools.artifact_tool` instead of `tools.render_panel_tool`.

---

## Step 2: Set up the runtime directory structure

All runtime files live under `~/.hermes/` — never inside any git repo.

```
~/.hermes/
└── artifacts/
    ├── session/          # artifacts that get cleaned up when the session ends
    ├── persistent/       # artifacts that survive across sessions
    ├── runners/          # background python scripts the model writes for live artifacts
    └── pids/             # PID files to track running background processes
```

In `artifact_tool.py`, define these paths at the top:

```python
import os

HERMES_HOME = os.path.expanduser("~/.hermes")
ARTIFACTS_HOME = os.path.join(HERMES_HOME, "artifacts")
ARTIFACT_SESSION_DIR = os.path.join(ARTIFACTS_HOME, "session")
ARTIFACT_PERSISTENT_DIR = os.path.join(ARTIFACTS_HOME, "persistent")
RUNNERS_DIR = os.path.join(ARTIFACTS_HOME, "runners")
PIDS_DIR = os.path.join(ARTIFACTS_HOME, "pids")
```

Each method should call `os.makedirs(..., exist_ok=True)` for whatever directory it writes to.

---

## Step 3: Implement create_artifact

```python
def create_artifact(
    artifact_type: str,    # "chart", "table", "map", "logs", "html", "markdown", "iframe"
    title: str,
    data: str,             # JSON string, schema depends on artifact_type
    tab_id: str = "",
    persistent: bool = False,
    live: bool = False,
    refresh_seconds: int = 0,
) -> str:
```

Behavior:
- Generate `tab_id` if not provided: `f"artifact_{int(time.time() * 1000)}"`
- Validate `data` is valid JSON, return error if not
- Choose target dir: `ARTIFACT_PERSISTENT_DIR` if `persistent=True`, else `ARTIFACT_SESSION_DIR`
- Write the artifact JSON to `{target_dir}/{tab_id}.json`
- Also write to `{HERMES_HOME}/artifacts/_latest.json` so hermelinChat can quick-poll
- Return JSON with: `artifact_id`, `status: "created"`, `path`, `type`, `title`, `persistent`

---

## Step 4: Implement remove_artifact

```python
def remove_artifact(tab_id: str) -> str:
```

Behavior:
- Check both `ARTIFACT_SESSION_DIR` and `ARTIFACT_PERSISTENT_DIR` for `{tab_id}.json`
- Delete the file if found
- Call `stop_runner(tab_id)` to kill any associated background process
- Return JSON with: `status: "removed"`, `tab_id`

---

## Step 5: Implement clear_artifacts

```python
def clear_artifacts(scope: str = "session") -> str:
```

Behavior:
- `scope="session"`: delete all files in `ARTIFACT_SESSION_DIR`, kill all runners that match session artifacts
- `scope="all"`: delete all files in both `ARTIFACT_SESSION_DIR` and `ARTIFACT_PERSISTENT_DIR`, kill all runners
- `scope="persistent"`: delete all files in `ARTIFACT_PERSISTENT_DIR` only
- Write `_close_signal.json` to `{HERMES_HOME}/artifacts/` so hermelinChat knows to close the panel
- Return JSON with: `status: "cleared"`, `scope`, `count` of deleted artifacts

---

## Step 6: Implement stop_runner

```python
def stop_runner(tab_id: str) -> str:
```

Behavior:
- Read PID from `{PIDS_DIR}/{tab_id}.pid`
- If found, send `SIGTERM` to that PID (use `os.kill(pid, signal.SIGTERM)`)
- Delete the PID file
- Delete the runner script from `{RUNNERS_DIR}/{tab_id}_runner.py` if it exists
- Return JSON with: `status: "stopped"` or `status: "not_running"`
- Wrap everything in try/except — process may already be dead

---

## Step 7: Write the tool schemas

Create OpenAI-style function schemas for all four methods: `CREATE_ARTIFACT_SCHEMA`, `REMOVE_ARTIFACT_SCHEMA`, `CLEAR_ARTIFACTS_SCHEMA`, `STOP_RUNNER_SCHEMA`.

The `create_artifact` schema description must include the live artifact pattern so models know how to use it:

```
"description": (
    "Create or update an artifact in hermelinChat's side panel. "
    "Supports types: chart, table, map, logs, html, markdown, iframe. "
    "Set persistent=true for artifacts that should survive across sessions. "
    "\n\n"
    "For live-updating artifacts:\n"
    "1. Call create_artifact with live=true, refresh_seconds=N, tab_id='my_id'\n"
    "2. Write an updater script to ~/.hermes/artifacts/runners/{tab_id}_runner.py\n"
    "3. The script must write its PID to ~/.hermes/artifacts/pids/{tab_id}.pid on startup\n"
    "4. The script loops, gathers data, and overwrites the artifact JSON\n"
    "5. Launch with: nohup python3 ~/.hermes/artifacts/runners/{tab_id}_runner.py &\n"
    "6. NEVER place scripts inside any git repository\n"
    "7. Handle SIGTERM gracefully for clean shutdown"
),
```

---

## Step 8: Register all four tools

```python
for name, schema, handler in [
    ("create_artifact", CREATE_ARTIFACT_SCHEMA, lambda args, **kw: create_artifact(**args)),
    ("remove_artifact", REMOVE_ARTIFACT_SCHEMA, lambda args, **kw: remove_artifact(**args)),
    ("clear_artifacts", CLEAR_ARTIFACTS_SCHEMA, lambda args, **kw: clear_artifacts(**args)),
    ("stop_runner", STOP_RUNNER_SCHEMA, lambda args, **kw: stop_runner(**args)),
]:
    registry.register(
        name=name,
        toolset="artifacts",
        schema=schema,
        handler=handler,
        check_fn=lambda: True,
    )
```

Update `toolsets.py`:
```python
"artifacts": {
    "description": "Create and manage artifacts in hermelinChat's side panel",
    "tools": ["create_artifact", "remove_artifact", "clear_artifacts", "stop_runner"],
},
```

Update the hermelinchat platform preset to include `"artifacts"`.

---

## Step 9: Update hermelinChat backend

The backend API endpoints need to know about the new directory structure:

- `GET /api/artifacts/latest` — reads `~/.hermes/artifacts/_latest.json`
- `GET /api/artifacts` — reads from BOTH `session/` and `persistent/` dirs, merges results, returns as array (add a `persistent: true/false` field to each so the frontend knows)
- `DELETE /api/artifacts/:id` — checks both dirs, deletes the file

If using chokidar/file watcher, watch both `session/` and `persistent/` subdirectories.

---

## Step 10: Clean up the panel header UI

Simplify the panel header in the frontend:

- **Row 1**: artifact title (left), action buttons — pin, refresh, maximize, close (right)
- **Row 2**: dropdown tab selector — icon + active tab title + "N tabs" badge + chevron
- **Remove** the "via render_panel · type · task ID" line. Put that metadata behind a small ⓘ icon that shows a tooltip on hover with: source tool, artifact type, tab id, created timestamp, persistent vs session
- **Footer**: make it more subtle — smaller font, lower opacity. "updated Xs ago" left, "auto-refresh: Ns" or "manual refresh" right

---

## Step 11: Upgrade the markdown renderer

Add proper code highlighting to the markdown artifact renderer:

- Use `marked.js` for markdown parsing
- Use `highlight.js` for syntax highlighting in fenced code blocks
- Support language tags: python, javascript, bash, yaml, json, typescript, go, rust, html, css, sql
- Code blocks: dark elevated background, 1px border, monospace font, optional line numbers
- Inline code (single backtick): subtle background pill slightly lighter than surface color
- Full markdown support: headings, bold/italic, lists, links, tables, blockquotes, horizontal rules, images

---

## Step 12: Verify everything works

Test this sequence:

1. Ask the model to create a markdown artifact — confirm it renders with code highlighting
2. Ask for a table artifact — confirm it shows in the panel
3. Ask for a second artifact — confirm the dropdown shows "2 tabs" and you can switch between them
4. Ask the model to remove one — confirm it disappears and the dropdown updates
5. Ask the model to create a persistent artifact — confirm it lands in `~/.hermes/artifacts/persistent/`
6. Restart the session — confirm the persistent artifact is still there, session ones are gone
7. Ask the model to clear all — confirm everything is cleaned up

If all 7 pass, the refactor is complete.
