# render_panel Implementation Prompts for Hermes-Agent

Feed these to your agent session in order. Each prompt is self-contained but builds on the previous step. Copy-paste one at a time.

---

## Prompt 1 — Create the render_panel tool

```
I need you to create a new Hermes-Agent tool called `render_panel`. This tool lets you push dynamic artifacts (dashboards, tables, maps, log views, HTML, markdown) into hermelinChat's right-side panel.

Create the file `tools/render_panel_tool.py` following our existing tool pattern with these specs:

**Two functions:**

1. `render_panel(artifact_type, title, data, tab_id="", live=False, refresh_seconds=0)`
   - artifact_type: one of "chart", "table", "map", "logs", "html", "markdown", "iframe"
   - title: display name for the panel tab
   - data: JSON string containing the artifact payload (schema varies by type)
   - tab_id: optional — reuse to update an existing tab
   - live: whether hermelinChat should auto-refresh this artifact
   - refresh_seconds: polling interval (0 = manual only)
   - Writes a JSON artifact file to `~/.hermes/artifacts/{artifact_id}.json`
   - Also writes `~/.hermes/artifacts/_latest.json` so hermelinChat can quick-poll
   - Returns JSON with artifact_id, status, path, type, title

2. `close_panel(tab_id="")`
   - Removes a specific artifact file, or writes `_close_signal.json` to close all

Both need full OpenAI-style function schemas (RENDER_PANEL_SCHEMA and CLOSE_PANEL_SCHEMA) and should be registered with the tool registry under toolset "artifacts":

```python
registry.register(
    name="render_panel",
    toolset="artifacts",
    schema=RENDER_PANEL_SCHEMA,
    handler=lambda args, **kw: render_panel(**args),
    check_fn=_check_requirements,
)
```

The check_fn always returns True since this only needs filesystem access. Include proper JSON validation on the data parameter and os.makedirs for the artifact directory.
```

---

## Prompt 2 — Register the tool in Hermes

```
Now register the render_panel tool so Hermes picks it up automatically.

1. In `model_tools.py`, add `"tools.render_panel_tool"` to the `_modules` list

2. In `toolsets.py`, add a new toolset entry:
```python
"artifacts": {
    "description": "Render dynamic artifacts in hermelinChat's side panel",
    "tools": ["render_panel", "close_panel"],
},
```

3. In the hermelinchat platform preset (or whatever preset hermelinChat sessions use), include `"artifacts"` in the `includes` list:
```python
"hermelinchat": {
    "includes": ["default", "artifacts"],
},
```

Show me the diffs for each file.
```

---

## Prompt 3 — hermelinChat backend: artifact API endpoints

```
hermelinChat needs backend endpoints to serve artifacts to the frontend. Add these to the hermelinChat Express/Node backend:

1. `GET /api/artifacts/latest` — reads `~/.hermes/artifacts/_latest.json` and returns the JSON (or null if no file exists)

2. `GET /api/artifacts` — lists all active artifact tabs by reading every `.json` file in `~/.hermes/artifacts/` that doesn't start with `_`, parses each, and returns them as an array

3. `DELETE /api/artifacts/:id` — removes a specific artifact file

Set `ARTIFACT_DIR` to `path.join(os.homedir(), '.hermes', 'artifacts')`.

Use fs.existsSync checks and proper error handling. This is Option A (file polling) — we'll add WebSocket push later.
```

---

## Prompt 4 — Frontend: artifact polling and panel state

```
In the hermelinChat React frontend, add artifact polling and panel state management.

Add this to the main chat component:

- State: `panelOpen` (boolean), `artifactTabs` (array of artifact objects), `activeTabId` (string), `lastSeenTimestamp` (number)
- A `useEffect` that polls `/api/artifacts/latest` every 1500ms. When it finds an artifact with a timestamp newer than `lastSeenTimestamp`, it:
  - Updates `lastSeenTimestamp`
  - Sets `panelOpen = true`
  - Calls `addOrUpdateTab(artifact)` which either adds a new tab or updates an existing one (matched by `artifact.id`)
- An `addOrUpdateTab` function that manages the `artifactTabs` array — upsert by id, set the new/updated tab as active

The panel should slide in from the right (like in our mockup). Include a close button, pin toggle, and tab bar showing all active artifact tabs.

Reference the mockup JSX I gave you earlier for the exact panel layout — it has the header with pin/refresh/maximize/close buttons, the tab bar, a "via render_panel" source indicator, and a footer showing last update time and refresh interval.
```

---

## Prompt 5 — Artifact renderers: table and markdown (start simple)

```
Build the first two artifact type renderers for the hermelinChat panel. These render inside the panel's content area based on the artifact's `type` field.

**Table renderer** — for `type: "table"`:
Expected data schema:
```json
{
  "columns": ["Namespace", "Pod", "Status", "CPU", "Memory"],
  "rows": [
    ["production", "hermes-api-7f8d4", "Running", "240m", "512Mi"],
    ["staging", "msp-panel-3a9f", "CrashLoopBackOff", "0m", "0Mi"]
  ],
  "highlight_rules": {
    "Status": { "CrashLoopBackOff": "danger", "Running": "success" }
  }
}
```
- Render a styled `<table>` with our existing terminal/monospace aesthetic
- Apply conditional coloring from `highlight_rules` — map "danger" to our red, "success" to green, "warning" to amber
- Match the style from the K8sPodsTable in our mockup

**Markdown renderer** — for `type: "markdown"`:
Expected data: `{ "content": "# Hello\n\nSome **markdown**" }`
- Use marked.js (or similar) to render markdown to HTML
- Style it with our dark theme colors and monospace font

Create an `ArtifactRenderer` component that takes an artifact object and switches on `artifact.type` to render the right component. Unknown types should show a "unsupported artifact type" message.
```

---

## Prompt 6 — Artifact renderers: chart and logs

```
Add two more artifact renderers to the panel:

**Chart renderer** — for `type: "chart"`:
Expected data:
```json
{
  "chart_type": "line",
  "title": "GPU Utilization (15min)",
  "x_axis": ["14:30", "14:31", "14:32"],
  "series": [
    { "name": "GPU 0", "values": [88, 91, 85], "color": "#f5b731" },
    { "name": "GPU 1", "values": [82, 85, 88], "color": "#60a5fa" }
  ]
}
```
- Support chart_type: "line", "bar", "area"
- Use recharts (we already have it in the frontend) with our dark theme
- Style axes, grid, and tooltips to match our terminal aesthetic — dark background, amber/muted colors, monospace labels

**Log stream renderer** — for `type: "logs"`:
Expected data:
```json
{
  "lines": [
    { "ts": "08:45:02.331", "level": "INFO", "source": "hermes-api", "msg": "POST /v1/chat 200" }
  ],
  "follow": true
}
```
- Scrollable log view with auto-scroll when `follow: true`
- Color-code by level: ERROR=red, WARN=amber, INFO=default, DEBUG=muted
- Filter buttons for each level (like in our mockup's LogStream component)
- Show source as a purple tag

Add both to the ArtifactRenderer switch.
```

---

## Prompt 7 — Artifact renderers: map and html

```
Add the final two artifact renderers:

**Map renderer** — for `type: "map"`:
Expected data:
```json
{
  "center": { "lat": 52.34, "lng": 13.64 },
  "zoom": 14,
  "markers": [
    { "lat": 52.34, "lng": 13.64, "label": "DGX Rack", "icon": "server", "color": "#f5b731" }
  ]
}
```
- Use Leaflet.js with a dark tile layer (CartoDB dark_all or similar)
- Custom colored markers matching our palette
- Popup on click showing label and any extra data
- If no geo markers but we get a `floor_plan` field, render an SVG floor plan like in our HaFloorMap mockup instead

**HTML renderer** — for `type: "html"`:
Expected data: `{ "html": "<div>Custom content</div>", "sandbox": true }`
- Render in a sandboxed iframe using `srcdoc`
- Set `sandbox="allow-scripts"` but NOT `allow-same-origin` for security
- This is the most powerful type — the agent can generate entire mini-apps

Add both to the ArtifactRenderer switch. We now have all 6 core types covered.
```

---

## Prompt 8 — WebSocket push (replace polling)

```
Upgrade from file polling to WebSocket push for artifact delivery. hermelinChat already has a WebSocket connection for the terminal, so we'll add artifact events to the same channel.

**Backend:**
- Use chokidar (or fs.watch) to watch `~/.hermes/artifacts/` for new and changed files
- Ignore files starting with `_`
- On `add` or `change`, parse the JSON and broadcast to all connected hermelinChat clients:
  ```json
  { "type": "artifact", "payload": { ...artifact } }
  ```
- Watch for `_close_signal.json` and broadcast `{ "type": "artifact_close", "payload": { "action": "close_all" } }`

**Frontend:**
- In the existing WebSocket `onmessage` handler, add cases for `artifact` and `artifact_close` message types
- On `artifact`: call `addOrUpdateTab(msg.payload)` and open the panel
- On `artifact_close`: close specified tab or all tabs
- Remove the polling `useEffect` — WebSocket replaces it entirely
- Keep the REST endpoints as fallback for initial load (fetch `/api/artifacts` on mount to restore any existing tabs)
```

---

## Prompt 9 — Live artifact support with background processes

```
Implement live artifact auto-refresh. When an artifact has `live: true` and `refresh_seconds: N`, it should update automatically.

The pattern is:
1. Agent calls `render_panel` with `live=True, refresh_seconds=5, tab_id="gpu_dash"`
2. Agent then spawns a background process (via execute_code or terminal with background=true) that continuously updates the same artifact JSON file
3. hermelinChat detects the file change via chokidar/WebSocket and re-renders

**Frontend changes:**
- Show a "live" indicator (green pulsing dot) on tabs where `artifact.live === true`
- Show the refresh interval in the panel footer: "auto-refresh: 5s"
- Add a "pause" toggle that stops re-rendering updates for that tab

**Test it** by asking me to "show live GPU stats" — I should:
1. Call render_panel with `artifact_type="chart", tab_id="gpu_live", live=True, refresh_seconds=2`
2. Spawn a background Python script that runs `nvidia-smi` in a loop, parses the output, and overwrites `~/.hermes/artifacts/gpu_live.json` every 2 seconds
3. hermelinChat picks up each update and re-renders the chart in real-time

Write the background monitoring script template too so I have it ready.
```

---

## Prompt 10 — Integration test: end-to-end flow

```
Let's test the full render_panel pipeline end-to-end. Run through this sequence:

1. Call render_panel with type="table" showing current k8s pods (use kubectl get pods -A -o json, parse it, build the columns/rows/highlight_rules payload)
2. Call render_panel with type="chart" showing GPU utilization (use nvidia-smi, build a line chart payload)  
3. Call render_panel with type="logs" tailing the last 50 journal lines (use journalctl --output=json -n 50)
4. Verify all three tabs appear in the hermelinChat panel
5. Update the k8s table by calling render_panel again with the same tab_id — confirm it updates in-place rather than creating a new tab
6. Call close_panel on the logs tab — confirm it disappears
7. Call close_panel with no tab_id — confirm the entire panel closes

Report any issues you find. If everything works, we're ready to ship it.
```
