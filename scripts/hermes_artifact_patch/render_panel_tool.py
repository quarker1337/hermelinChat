     1|#!/usr/bin/env python3
     2|"""Artifact side-panel tools for hermilinChat.
     3|
     4|These tools let Hermes write structured UI artifacts to a shared filesystem
     5|location that hermilinChat can read and render in its right-side artifact
     6|panel.
     7|"""
     8|
     9|from __future__ import annotations
    10|
    11|import json
    12|import os
    13|import re
    14|import tempfile
    15|import time
    16|from pathlib import Path
    17|from typing import Any
    18|
    19|from tools.registry import registry
    20|
    21|
    22|ALLOWED_ARTIFACT_TYPES = {"chart", "table", "map", "logs", "html", "markdown", "iframe"}
    23|
    24|
    25|def _artifact_dir() -> Path:
    26|    hermes_home = os.path.expanduser(os.getenv("HERMES_HOME", "~/.hermes"))
    27|    return Path(hermes_home) / "artifacts"
    28|
    29|
    30|def _ensure_artifact_dir() -> Path:
    31|    path = _artifact_dir()
    32|    path.mkdir(parents=True, exist_ok=True)
    33|    return path
    34|
    35|
    36|def _sanitize_artifact_id(value: str) -> str:
    37|    raw = (value or "").strip()
    38|    if not raw:
    39|        return ""
    40|    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    41|    safe = safe.strip("._-")
    42|    return safe[:120]
    43|
    44|
    45|def _artifact_path(artifact_id: str) -> Path:
    46|    return _ensure_artifact_dir() / f"{artifact_id}.json"
    47|
    48|
    49|def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    50|    path.parent.mkdir(parents=True, exist_ok=True)
    51|    tmp_fd, tmp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    52|    try:
    53|        with os.fdopen(tmp_fd, "w", encoding="utf-8") as handle:
    54|            json.dump(payload, handle, ensure_ascii=False, indent=2)
    55|            handle.flush()
    56|            os.fsync(handle.fileno())
    57|        os.replace(tmp_path, path)
    58|    finally:
    59|        try:
    60|            if os.path.exists(tmp_path):
    61|                os.remove(tmp_path)
    62|        except OSError:
    63|            pass
    64|
    65|
    66|def _read_json(path: Path) -> dict[str, Any] | None:
    67|    try:
    68|        return json.loads(path.read_text(encoding="utf-8"))
    69|    except Exception:
    70|        return None
    71|
    72|
    73|def _list_artifact_paths() -> list[Path]:
    74|    root = _ensure_artifact_dir()
    75|    return sorted(
    76|        [p for p in root.glob("*.json") if not p.name.startswith("_")],
    77|        key=lambda p: p.name,
    78|    )
    79|
    80|
    81|def _iter_artifacts() -> list[dict[str, Any]]:
    82|    items: list[dict[str, Any]] = []
    83|    for path in _list_artifact_paths():
    84|        payload = _read_json(path)
    85|        if isinstance(payload, dict):
    86|            items.append(payload)
    87|    return items
    88|
    89|
    90|def _recompute_latest() -> None:
    91|    latest_path = _ensure_artifact_dir() / "_latest.json"
    92|    artifacts = _iter_artifacts()
    93|    if not artifacts:
    94|        try:
    95|            latest_path.unlink(missing_ok=True)
    96|        except Exception:
    97|            pass
    98|        return
    99|
   100|    latest = max(artifacts, key=lambda item: float(item.get("timestamp") or 0.0))
   101|    _write_json_atomic(latest_path, latest)
   102|
   103|
   104|def _write_close_signal(payload: dict[str, Any]) -> None:
   105|    signal_path = _ensure_artifact_dir() / "_close_signal.json"
   106|    _write_json_atomic(signal_path, payload)
   107|
   108|
   109|def render_panel(
   110|    artifact_type: str,
   111|    title: str,
   112|    data: str,
   113|    tab_id: str = "",
   114|    live: bool = False,
   115|    refresh_seconds: int = 0,
   116|    task_id: str | None = None,
   117|) -> str:
   118|    """Render or update an artifact for hermilinChat's side panel."""
   119|    kind = (artifact_type or "").strip().lower()
   120|    if kind not in ALLOWED_ARTIFACT_TYPES:
   121|        return json.dumps({
   122|            "error": f"Unsupported artifact_type: {artifact_type}. Allowed: {sorted(ALLOWED_ARTIFACT_TYPES)}"
   123|        }, ensure_ascii=False)
   124|
   125|    title = (title or "").strip()
   126|    if not title:
   127|        return json.dumps({"error": "title is required"}, ensure_ascii=False)
   128|
   129|    try:
   130|        parsed_data = json.loads(data)
   131|    except json.JSONDecodeError as exc:
   132|        return json.dumps({"error": f"Invalid JSON in data: {exc}"}, ensure_ascii=False)
   133|
   134|    if not isinstance(parsed_data, dict):
   135|        return json.dumps({"error": "data must decode to a JSON object"}, ensure_ascii=False)
   136|
   137|    try:
   138|        refresh_value = max(0, int(refresh_seconds or 0))
   139|    except (TypeError, ValueError):
   140|        return json.dumps({"error": "refresh_seconds must be an integer"}, ensure_ascii=False)
   141|
   142|    artifact_id = _sanitize_artifact_id(tab_id) or f"artifact_{int(time.time() * 1000)}"
   143|    path = _artifact_path(artifact_id)
   144|    existing = _read_json(path) if path.exists() else None
   145|    now = time.time()
   146|
   147|    artifact = {
   148|        "id": artifact_id,
   149|        "type": kind,
   150|        "title": title,
   151|        "data": parsed_data,
   152|        "live": bool(live),
   153|        "refresh_seconds": refresh_value,
   154|        "timestamp": now,
   155|        "created_at": existing.get("created_at", now) if isinstance(existing, dict) else now,
   156|        "updated_at": now,
   157|        "source": "render_panel",
   158|        "task_id": task_id,
   159|        "session_id": os.getenv("HERMES_SESSION_ID") or None,
   160|        "version": 1,
   161|    }
   162|
   163|    _write_json_atomic(path, artifact)
   164|    _write_json_atomic(_ensure_artifact_dir() / "_latest.json", artifact)
   165|
   166|    return json.dumps(
   167|        {
   168|            "artifact_id": artifact_id,
   169|            "status": "rendered",
   170|            "path": str(path),
   171|            "type": kind,
   172|            "title": title,
   173|            "updated_at": now,
   174|        },
   175|        ensure_ascii=False,
   176|    )
   177|
   178|
   179|def close_panel(tab_id: str = "", task_id: str | None = None) -> str:
   180|    """Close one artifact tab or all artifacts for the current task."""
   181|    root = _ensure_artifact_dir()
   182|    requested_id = _sanitize_artifact_id(tab_id)
   183|    now = time.time()
   184|
   185|    if requested_id:
   186|        target = root / f"{requested_id}.json"
   187|        removed = False
   188|        try:
   189|            if target.exists():
   190|                target.unlink()
   191|                removed = True
   192|        except OSError as exc:
   193|            return json.dumps({"error": f"Failed to remove artifact '{requested_id}': {exc}"}, ensure_ascii=False)
   194|
   195|        _recompute_latest()
   196|        _write_close_signal({
   197|            "action": "close",
   198|            "id": requested_id,
   199|            "task_id": task_id,
   200|            "timestamp": now,
   201|        })
   202|        return json.dumps({"status": "closed", "tab_id": requested_id, "removed": removed}, ensure_ascii=False)
   203|
   204|    removed_ids: list[str] = []
   205|    for path in _list_artifact_paths():
   206|        payload = _read_json(path)
   207|        if not isinstance(payload, dict):
   208|            continue
   209|        payload_task_id = payload.get("task_id")
   210|        if task_id and payload_task_id and payload_task_id != task_id:
   211|            continue
   212|        try:
   213|            path.unlink(missing_ok=True)
   214|            artifact_id = payload.get("id")
   215|            if artifact_id:
   216|                removed_ids.append(str(artifact_id))
   217|        except OSError:
   218|            continue
   219|
   220|    _recompute_latest()
   221|    _write_close_signal({
   222|        "action": "close_all",
   223|        "task_id": task_id,
   224|        "artifact_ids": removed_ids,
   225|        "timestamp": now,
   226|    })
   227|    return json.dumps({"status": "panel_closed", "artifact_ids": removed_ids}, ensure_ascii=False)
   228|
   229|
   230|RENDER_PANEL_SCHEMA = {
   231|    "name": "render_panel",
   232|    "description": (
   233|        "Render or update a structured artifact in hermilinChat's right-side panel. "
   234|        "Use this for dashboards, tables, maps, logs, markdown reports, HTML mini-apps, "
   235|        "or iframe views that should appear alongside the terminal conversation."
   236|    ),
   237|    "parameters": {
   238|        "type": "object",
   239|        "properties": {
   240|            "artifact_type": {
   241|                "type": "string",
   242|                "enum": sorted(ALLOWED_ARTIFACT_TYPES),
   243|                "description": "Artifact renderer type.",
   244|            },
   245|            "title": {
   246|                "type": "string",
   247|                "description": "Tab title shown in the artifact panel.",
   248|            },
   249|            "data": {
   250|                "type": "string",
   251|                "description": (
   252|                    "JSON string containing the artifact payload. "
   253|                    "Examples: table={\"columns\":[...],\"rows\":[...]}, "
   254|                    "chart={\"chart_type\":\"line\",\"x_axis\":[...],\"series\":[...]}, "
   255|                    "logs={\"lines\":[{\"ts\":...,\"level\":...,\"source\":...,\"msg\":...}]}, "
   256|                    "markdown={\"content\":\"# Report\"}, "
   257|                    "html={\"html\":\"<div>...</div>\"}, "
   258|                    "map={\"markers\":[...]} or {\"floor_plan\": ...}, "
   259|                    "iframe={\"src\":\"https://...\"} or {\"srcdoc\":\"...\"}."
   260|                ),
   261|            },
   262|            "tab_id": {
   263|                "type": "string",
   264|                "description": "Optional stable tab identifier. Reuse it to update an existing artifact in place.",
   265|                "default": "",
   266|            },
   267|            "live": {
   268|                "type": "boolean",
   269|                "description": "Whether this artifact is expected to receive live updates.",
   270|                "default": False,
   271|            },
   272|            "refresh_seconds": {
   273|                "type": "integer",
   274|                "description": "Suggested refresh interval in seconds for live artifacts. Use 0 for manual refresh only.",
   275|                "default": 0,
   276|                "minimum": 0,
   277|            },
   278|        },
   279|        "required": ["artifact_type", "title", "data"],
   280|    },
   281|}
   282|
   283|
   284|CLOSE_PANEL_SCHEMA = {
   285|    "name": "close_panel",
   286|    "description": "Close a specific artifact tab, or close all artifact tabs for the current task when tab_id is omitted.",
   287|    "parameters": {
   288|        "type": "object",
   289|        "properties": {
   290|            "tab_id": {
   291|                "type": "string",
   292|                "description": "Artifact tab ID to close. Leave empty to close all artifacts for the current task.",
   293|                "default": "",
   294|            }
   295|        },
   296|        "required": [],
   297|    },
   298|}
   299|
   300|
   301|def _check_requirements() -> bool:
   302|    return True
   303|
   304|
   305|def _handle_render_panel(args, **kw):
   306|    return render_panel(
   307|        artifact_type=args.get("artifact_type", ""),
   308|        title=args.get("title", ""),
   309|        data=args.get("data", ""),
   310|        tab_id=args.get("tab_id", ""),
   311|        live=args.get("live", False),
   312|        refresh_seconds=args.get("refresh_seconds", 0),
   313|        task_id=kw.get("task_id"),
   314|    )
   315|
   316|
   317|def _handle_close_panel(args, **kw):
   318|    return close_panel(tab_id=args.get("tab_id", ""), task_id=kw.get("task_id"))
   319|
   320|
   321|registry.register(
   322|    name="render_panel",
   323|    toolset="ui_panel",
   324|    schema=RENDER_PANEL_SCHEMA,
   325|    handler=_handle_render_panel,
   326|    check_fn=_check_requirements,
   327|)
   328|
   329|registry.register(
   330|    name="close_panel",
   331|    toolset="ui_panel",
   332|    schema=CLOSE_PANEL_SCHEMA,
   333|    handler=_handle_close_panel,
   334|    check_fn=_check_requirements,
   335|)
   336|