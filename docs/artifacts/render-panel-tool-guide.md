# `render_panel` — Dynamic Artifact Panel Tool for Hermes-Agent

## What This Does

Adds a new Hermes-Agent tool called `render_panel` that lets the agent push dynamic content (dashboards, maps, tables, log streams, HTML) into hermelinChat's right-side panel — the same panel currently used for search/peek.

When the agent calls `render_panel`, it returns a JSON payload. hermelinChat's frontend picks it up and renders it in the artifact panel instead of (or alongside) the terminal output.

---

## Part 1: The Hermes-Agent Tool

Create `tools/render_panel_tool.py` following the existing tool pattern:

```python
"""
render_panel — Push dynamic artifacts to hermelinChat's side panel.

The agent calls this tool to render dashboards, tables, maps, log views,
or arbitrary HTML in the hermelinChat artifact panel. The tool writes
the artifact payload to a shared location that hermelinChat polls or
receives via WebSocket.
"""

import json
import os
import time
from tools.registry import registry

# ─── Where artifacts are exchanged ─────────────────────────────────
# hermelinChat and hermes-agent run on the same host, so we use a
# shared directory. hermelinChat watches this dir (or gets notified
# via WebSocket) for new artifact files.
ARTIFACT_DIR = os.path.expanduser("~/.hermes/artifacts")


def render_panel(
    artifact_type: str,
    title: str,
    data: str,
    tab_id: str = "",
    live: bool = False,
    refresh_seconds: int = 0,
) -> str:
    """
    Push an artifact to hermelinChat's side panel.

    Args:
        artifact_type: One of: chart, table, map, logs, html, markdown, iframe
        title: Display title shown in the panel tab
        data: JSON string containing the artifact payload (schema depends on type)
        tab_id: Optional ID for the tab (allows updating existing tabs)
        live: Whether this artifact should auto-refresh
        refresh_seconds: Auto-refresh interval (0 = manual refresh only)

    Returns:
        JSON string with artifact_id and status
    """
    os.makedirs(ARTIFACT_DIR, exist_ok=True)

    artifact_id = tab_id or f"artifact_{int(time.time() * 1000)}"

    # Parse the data to validate it's proper JSON
    try:
        parsed_data = json.loads(data)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"Invalid JSON in data: {str(e)}"})

    artifact = {
        "id": artifact_id,
        "type": artifact_type,
        "title": title,
        "data": parsed_data,
        "live": live,
        "refresh_seconds": refresh_seconds,
        "timestamp": time.time(),
        "session_id": os.environ.get("HERMES_SESSION_ID", "unknown"),
    }

    # Write artifact to shared directory
    artifact_path = os.path.join(ARTIFACT_DIR, f"{artifact_id}.json")
    with open(artifact_path, "w") as f:
        json.dump(artifact, f)

    # Also write to a "latest" symlink/file so hermelinChat can quick-poll
    latest_path = os.path.join(ARTIFACT_DIR, "_latest.json")
    with open(latest_path, "w") as f:
        json.dump(artifact, f)

    return json.dumps({
        "artifact_id": artifact_id,
        "status": "rendered",
        "path": artifact_path,
        "type": artifact_type,
        "title": title,
    })


def close_panel(tab_id: str = "") -> str:
    """Close a specific artifact tab or the entire panel."""
    if tab_id:
        artifact_path = os.path.join(ARTIFACT_DIR, f"{tab_id}.json")
        if os.path.exists(artifact_path):
            os.remove(artifact_path)
        return json.dumps({"status": "closed", "tab_id": tab_id})
    else:
        # Signal hermelinChat to close the panel
        signal_path = os.path.join(ARTIFACT_DIR, "_close_signal.json")
        with open(signal_path, "w") as f:
            json.dump({"action": "close_all", "timestamp": time.time()}, f)
        return json.dumps({"status": "panel_closed"})


# ─── Tool Schemas ──────────────────────────────────────────────────

RENDER_PANEL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "render_panel",
        "description": (
            "Render a dynamic artifact in hermelinChat's side panel. "
            "Use this to display dashboards, tables, maps, log streams, "
            "or custom HTML alongside the terminal conversation. "
            "Supported types: chart (recharts-compatible), table (rows/columns), "
            "map (lat/lng markers), logs (streaming log lines), "
            "html (raw HTML/CSS/JS), markdown (rendered MD). "
            "The data parameter must be a JSON string matching the type's schema."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "artifact_type": {
                    "type": "string",
                    "enum": ["chart", "table", "map", "logs", "html", "markdown", "iframe"],
                    "description": "The type of artifact to render",
                },
                "title": {
                    "type": "string",
                    "description": "Display title for the panel tab",
                },
                "data": {
                    "type": "string",
                    "description": (
                        "JSON string with the artifact payload. "
                        "For 'table': {\"columns\": [...], \"rows\": [[...], ...]}. "
                        "For 'chart': {\"chart_type\": \"line|bar|area\", \"series\": [...], \"x_axis\": [...]}. "
                        "For 'map': {\"markers\": [{\"lat\": ..., \"lng\": ..., \"label\": ...}]}. "
                        "For 'logs': {\"lines\": [{\"ts\": ..., \"level\": ..., \"msg\": ...}]}. "
                        "For 'html': {\"html\": \"<div>...</div>\"}. "
                        "For 'markdown': {\"content\": \"# Hello\"}."
                    ),
                },
                "tab_id": {
                    "type": "string",
                    "description": "Optional tab identifier. Reuse to update an existing tab.",
                    "default": "",
                },
                "live": {
                    "type": "boolean",
                    "description": "If true, hermelinChat will poll for updates to this artifact.",
                    "default": False,
                },
                "refresh_seconds": {
                    "type": "integer",
                    "description": "Auto-refresh interval in seconds (0 = no auto-refresh).",
                    "default": 0,
                },
            },
            "required": ["artifact_type", "title", "data"],
        },
    },
}

CLOSE_PANEL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "close_panel",
        "description": "Close a specific artifact tab or the entire artifact panel in hermelinChat.",
        "parameters": {
            "type": "object",
            "properties": {
                "tab_id": {
                    "type": "string",
                    "description": "ID of the tab to close. Empty string closes all.",
                    "default": "",
                },
            },
            "required": [],
        },
    },
}


# ─── Requirements Check ────────────────────────────────────────────

def _check_requirements() -> bool:
    """Always available — only needs the filesystem."""
    return True


# ─── Register with Hermes ──────────────────────────────────────────

registry.register(
    name="render_panel",
    toolset="ui_panel",
    schema=RENDER_PANEL_SCHEMA,
    handler=lambda args, **kw: render_panel(**args),
    check_fn=_check_requirements,
)

registry.register(
    name="close_panel",
    toolset="ui_panel",
    schema=CLOSE_PANEL_SCHEMA,
    handler=lambda args, **kw: close_panel(**args),
    check_fn=_check_requirements,
)
```

### Registration Steps

1. Save as `tools/render_panel_tool.py`

2. Add the import to `model_tools.py` in the `_modules` list:
```python
_modules = [
    # ... existing modules ...
    "tools.render_panel_tool",
]
```

3. Add the toolset to `toolsets.py`:
```python
"ui_panel": {
    "description": "Render dynamic artifacts in hermelinChat's side panel",
    "tools": ["render_panel", "close_panel"],
},
```

4. Include it in the `hermelinchat` platform preset (or whatever preset hermelinChat uses):
```python
"hermelinchat": {
    "includes": ["default", "ui_panel"],
    # ...
},
```

That's it for the agent side. The registry handles everything else automatically.

---

## Part 2: The hermelinChat Frontend

hermelinChat needs to know when the agent has pushed a new artifact. Since both run on the same box, there are two approaches ranked by complexity:

### Option A: File Polling (Simplest, start here)

hermelinChat polls `~/.hermes/artifacts/_latest.json` every 1-2 seconds.

```javascript
// In your hermelinChat backend (Node/Express or whatever serves the UI)
const ARTIFACT_DIR = path.join(os.homedir(), '.hermes', 'artifacts');

// API endpoint hermelinChat frontend calls
app.get('/api/artifacts/latest', (req, res) => {
  const latestPath = path.join(ARTIFACT_DIR, '_latest.json');
  if (fs.existsSync(latestPath)) {
    const artifact = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    res.json(artifact);
  } else {
    res.json(null);
  }
});

// List all active artifact tabs
app.get('/api/artifacts', (req, res) => {
  if (!fs.existsSync(ARTIFACT_DIR)) return res.json([]);
  const files = fs.readdirSync(ARTIFACT_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, f), 'utf8')));
  res.json(files);
});
```

Frontend polling:
```javascript
// In the React component
useEffect(() => {
  const interval = setInterval(async () => {
    const res = await fetch('/api/artifacts/latest');
    const artifact = await res.json();
    if (artifact && artifact.timestamp > lastSeenTimestamp) {
      setLastSeenTimestamp(artifact.timestamp);
      setPanelOpen(true);
      addOrUpdateTab(artifact);
    }
  }, 1500);
  return () => clearInterval(interval);
}, [lastSeenTimestamp]);
```

### Option B: WebSocket Push (Better UX, do this second)

Since hermelinChat already uses xterm.js and likely has a WebSocket connection to the backend, add artifact events to the existing WS channel:

```javascript
// Backend: watch the artifacts directory with chokidar or fs.watch
const chokidar = require('chokidar');
const watcher = chokidar.watch(ARTIFACT_DIR, { ignoreInitial: true });

watcher.on('add', (filePath) => {
  if (path.basename(filePath).startsWith('_')) return;
  const artifact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  // Broadcast to all connected hermelinChat clients
  wss.clients.forEach(client => {
    client.send(JSON.stringify({ type: 'artifact', payload: artifact }));
  });
});

watcher.on('change', (filePath) => {
  // Same — artifact updated (live refresh)
});
```

Frontend:
```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'artifact') {
    setPanelOpen(true);
    addOrUpdateTab(msg.payload);
  }
};
```

---

## Part 3: Rendering Artifacts by Type

The panel receives a JSON artifact and needs to render it based on `type`. Here's the contract for each:

### `table`
```json
{
  "type": "table",
  "data": {
    "columns": ["Namespace", "Pod", "Status", "CPU", "Memory"],
    "rows": [
      ["production", "hermes-api-7f8d4", "Running", "240m", "512Mi"],
      ["staging", "msp-panel-3a9f", "CrashLoopBackOff", "0m", "0Mi"]
    ],
    "highlight_rules": {
      "Status": { "CrashLoopBackOff": "danger", "Running": "success" }
    }
  }
}
```
Renderer: map columns to a `<table>`, apply conditional coloring from highlight_rules.

### `chart`
```json
{
  "type": "chart",
  "data": {
    "chart_type": "line",
    "title": "GPU Utilization (15min)",
    "x_axis": ["14:30", "14:31", "14:32", "..."],
    "series": [
      { "name": "GPU 0", "values": [88, 91, 85, "..."], "color": "#f5b731" },
      { "name": "GPU 1", "values": [82, 85, 88, "..."], "color": "#60a5fa" }
    ]
  }
}
```
Renderer: use recharts (already in the frontend) or Chart.js.

### `map`
```json
{
  "type": "map",
  "data": {
    "center": { "lat": 52.34, "lng": 13.64 },
    "zoom": 14,
    "markers": [
      { "lat": 52.34, "lng": 13.64, "label": "DGX Rack", "icon": "server", "color": "#f5b731" }
    ]
  }
}
```
Renderer: Leaflet.js with dark tile layer, or a simple SVG floor plan like in the mockup.

### `logs`
```json
{
  "type": "logs",
  "data": {
    "lines": [
      { "ts": "08:45:02.331", "level": "INFO", "source": "hermes-api", "msg": "POST /v1/chat 200" },
      { "ts": "08:45:05.001", "level": "ERROR", "source": "cronjob", "msg": "blogwatcher timeout" }
    ],
    "follow": true
  }
}
```
Renderer: scrollable log view with level-based coloring, filter buttons.

### `html`
```json
{
  "type": "html",
  "data": {
    "html": "<div style='padding:20px'>Custom content</div>",
    "sandbox": true
  }
}
```
Renderer: sandboxed `<iframe srcdoc="...">` — this is the most powerful type. The agent can generate entire mini-apps. Set `sandbox="allow-scripts"` but NOT `allow-same-origin` for security.

### `markdown`
```json
{
  "type": "markdown",
  "data": {
    "content": "# Report\n\nSome **markdown** content with `code`."
  }
}
```
Renderer: simple markdown-to-HTML renderer (marked.js or similar).

---

## Part 4: Live Artifacts

When `live: true` and `refresh_seconds: N`, hermelinChat re-fetches the artifact file every N seconds. The agent can update the artifact by calling `render_panel` again with the same `tab_id` — this overwrites the JSON file, and hermelinChat picks up the new version.

For truly real-time data (GPU metrics, log tailing), the agent can:

1. Spawn a background process via `execute_code` or `terminal(background=true)` that continuously updates the artifact JSON file
2. hermelinChat polls the file or gets notified via WebSocket watcher

Example: the agent writes a small Python script that tails journalctl and updates the logs artifact every second:

```python
# Agent calls execute_code with this script:
import json, subprocess, time, os

ARTIFACT_PATH = os.path.expanduser("~/.hermes/artifacts/live_logs.json")
proc = subprocess.Popen(
    ["journalctl", "-f", "--output=json", "-n", "50"],
    stdout=subprocess.PIPE, text=True
)
lines = []
for line in proc.stdout:
    try:
        entry = json.loads(line)
        lines.append({
            "ts": entry.get("__REALTIME_TIMESTAMP", ""),
            "level": entry.get("PRIORITY", "6"),
            "source": entry.get("SYSLOG_IDENTIFIER", ""),
            "msg": entry.get("MESSAGE", ""),
        })
        lines = lines[-100:]  # keep last 100
        with open(ARTIFACT_PATH, "w") as f:
            json.dump({
                "id": "live_logs", "type": "logs", "title": "Live Logs",
                "data": {"lines": lines, "follow": True},
                "live": True, "refresh_seconds": 1,
                "timestamp": time.time(),
            }, f)
    except:
        pass
```

---

## Architecture Summary

```
┌──────────────────────┐     ~/.hermes/artifacts/     ┌──────────────────────┐
│                      │     ┌──────────────────┐     │                      │
│   Hermes-Agent       │────▶│  gpu_dash.json   │◀────│   hermelinChat       │
│                      │     │  k8s_pods.json   │     │   (frontend)         │
│  render_panel tool   │     │  live_logs.json  │     │                      │
│  writes artifact     │     │  _latest.json    │     │  polls/watches dir   │
│  JSON to shared dir  │     └──────────────────┘     │  renders in panel    │
│                      │              │                │                      │
│  (or via WebSocket)  │              │                │  (or via WebSocket)  │
│                      │     fs.watch / chokidar      │                      │
└──────────────────────┘                               └──────────────────────┘
```

The beauty of this: zero coupling. The agent just writes JSON files. hermelinChat just reads them. You can test artifacts by manually dropping JSON into `~/.hermes/artifacts/`. You can also build a CLI viewer later, or pipe artifacts to Discord/Telegram embeds through the gateway.

---

## Getting Started (Recommended Order)

1. Create `tools/render_panel_tool.py` with the code above
2. Register it in `model_tools.py` and `toolsets.py`
3. Add the `/api/artifacts/latest` endpoint to hermelinChat's backend
4. Add a simple panel renderer that handles `table` and `markdown` types first
5. Test by asking Hermes: "show me a table of running pods"
6. Add `chart` and `logs` renderers
7. Add `html` type with sandboxed iframe for maximum flexibility
8. Add WebSocket push to replace polling
9. Add live artifact support with background process updating
