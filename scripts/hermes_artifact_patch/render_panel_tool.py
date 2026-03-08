#!/usr/bin/env python3
"""Artifact side-panel tools for hermilinChat.

These tools let Hermes write structured UI artifacts to a shared filesystem
location that hermilinChat can read and render in its right-side artifact
panel.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from tools.registry import registry


ALLOWED_ARTIFACT_TYPES = {"chart", "table", "map", "logs", "html", "markdown", "iframe"}


def _artifact_dir() -> Path:
    hermes_home = os.path.expanduser(os.getenv("HERMES_HOME", "~/.hermes"))
    return Path(hermes_home) / "artifacts"


def _ensure_artifact_dir() -> Path:
    path = _artifact_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sanitize_artifact_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    safe = safe.strip("._-")
    return safe[:120]


def _artifact_path(artifact_id: str) -> Path:
    return _ensure_artifact_dir() / f"{artifact_id}.json"


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _list_artifact_paths() -> list[Path]:
    root = _ensure_artifact_dir()
    return sorted(
        [p for p in root.glob("*.json") if not p.name.startswith("_")],
        key=lambda p: p.name,
    )


def _iter_artifacts() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for path in _list_artifact_paths():
        payload = _read_json(path)
        if isinstance(payload, dict):
            items.append(payload)
    return items


def _recompute_latest() -> None:
    latest_path = _ensure_artifact_dir() / "_latest.json"
    artifacts = _iter_artifacts()
    if not artifacts:
        try:
            latest_path.unlink(missing_ok=True)
        except Exception:
            pass
        return

    latest = max(artifacts, key=lambda item: float(item.get("timestamp") or 0.0))
    _write_json_atomic(latest_path, latest)


def _write_close_signal(payload: dict[str, Any]) -> None:
    signal_path = _ensure_artifact_dir() / "_close_signal.json"
    _write_json_atomic(signal_path, payload)


def render_panel(
    artifact_type: str,
    title: str,
    data: str,
    tab_id: str = "",
    live: bool = False,
    refresh_seconds: int = 0,
    task_id: str | None = None,
) -> str:
    """Render or update an artifact for hermilinChat's side panel."""
    kind = (artifact_type or "").strip().lower()
    if kind not in ALLOWED_ARTIFACT_TYPES:
        return json.dumps({
            "error": f"Unsupported artifact_type: {artifact_type}. Allowed: {sorted(ALLOWED_ARTIFACT_TYPES)}"
        }, ensure_ascii=False)

    title = (title or "").strip()
    if not title:
        return json.dumps({"error": "title is required"}, ensure_ascii=False)

    try:
        parsed_data = json.loads(data)
    except json.JSONDecodeError as exc:
        return json.dumps({"error": f"Invalid JSON in data: {exc}"}, ensure_ascii=False)

    if not isinstance(parsed_data, dict):
        return json.dumps({"error": "data must decode to a JSON object"}, ensure_ascii=False)

    try:
        refresh_value = max(0, int(refresh_seconds or 0))
    except (TypeError, ValueError):
        return json.dumps({"error": "refresh_seconds must be an integer"}, ensure_ascii=False)

    artifact_id = _sanitize_artifact_id(tab_id) or f"artifact_{int(time.time() * 1000)}"
    path = _artifact_path(artifact_id)
    existing = _read_json(path) if path.exists() else None
    now = time.time()

    artifact = {
        "id": artifact_id,
        "type": kind,
        "title": title,
        "data": parsed_data,
        "live": bool(live),
        "refresh_seconds": refresh_value,
        "timestamp": now,
        "created_at": existing.get("created_at", now) if isinstance(existing, dict) else now,
        "updated_at": now,
        "source": "render_panel",
        "task_id": task_id,
        "session_id": os.getenv("HERMES_SESSION_ID") or None,
        "version": 1,
    }

    _write_json_atomic(path, artifact)
    _write_json_atomic(_ensure_artifact_dir() / "_latest.json", artifact)

    return json.dumps(
        {
            "artifact_id": artifact_id,
            "status": "rendered",
            "path": str(path),
            "type": kind,
            "title": title,
            "updated_at": now,
        },
        ensure_ascii=False,
    )


def close_panel(tab_id: str = "", task_id: str | None = None) -> str:
    """Close one artifact tab, or close the whole panel.

    Notes:
    - If tab_id is provided: remove that artifact file.
    - If tab_id is omitted/empty: remove *all* artifacts (panel reset) and emit a close signal.

    We intentionally do NOT scope this to Hermes "task_id" because task IDs can change between
    consecutive user turns, which makes "close_panel()" appear to do nothing.
    """

    root = _ensure_artifact_dir()
    requested_id = _sanitize_artifact_id(tab_id)
    now = time.time()

    if requested_id:
        target = root / f"{requested_id}.json"

        if not target.exists():
            return json.dumps(
                {"status": "not_found", "tab_id": requested_id, "removed": False},
                ensure_ascii=False,
            )

        try:
            target.unlink()
        except OSError as exc:
            return json.dumps({"error": f"Failed to remove artifact '{requested_id}': {exc}"}, ensure_ascii=False)

        _recompute_latest()

        # Optional: allow UI to react immediately (server may choose to forward this).
        _write_close_signal({
            "action": "close",
            "id": requested_id,
            "task_id": task_id,
            "timestamp": now,
        })

        return json.dumps({"status": "closed", "tab_id": requested_id, "removed": True}, ensure_ascii=False)

    removed_ids: list[str] = []
    for path in _list_artifact_paths():
        payload = _read_json(path)
        if not isinstance(payload, dict):
            continue

        try:
            path.unlink(missing_ok=True)
            artifact_id = payload.get("id")
            if artifact_id:
                removed_ids.append(str(artifact_id))
        except OSError:
            continue

    _recompute_latest()

    # Always emit close_all even if no artifacts existed (lets UI close the empty-state panel).
    _write_close_signal({
        "action": "close_all",
        "task_id": task_id,
        "artifact_ids": removed_ids,
        "timestamp": now,
    })

    return json.dumps({"status": "panel_closed", "artifact_ids": removed_ids}, ensure_ascii=False)


RENDER_PANEL_SCHEMA = {
    "name": "render_panel",
    "description": (
        "Render or update a structured artifact in hermilinChat's right-side panel. "
        "Use this for dashboards, tables, maps, logs, markdown reports, HTML mini-apps, "
        "or iframe views that should appear alongside the terminal conversation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "artifact_type": {
                "type": "string",
                "enum": sorted(ALLOWED_ARTIFACT_TYPES),
                "description": "Artifact renderer type.",
            },
            "title": {
                "type": "string",
                "description": "Tab title shown in the artifact panel.",
            },
            "data": {
                "type": "string",
                "description": (
                    "JSON string containing the artifact payload. "
                    "Examples: table={\"columns\":[...],\"rows\":[...]}, "
                    "chart={\"chart_type\":\"line\",\"x_axis\":[...],\"series\":[...]}, "
                    "logs={\"lines\":[{\"ts\":...,\"level\":...,\"source\":...,\"msg\":...}]}, "
                    "markdown={\"content\":\"# Report\"}, "
                    "html={\"html\":\"<div>...</div>\"}, "
                    "map={\"markers\":[...]} or {\"floor_plan\": ...}, "
                    "iframe={\"src\":\"https://...\"} or {\"srcdoc\":\"...\"}."
                ),
            },
            "tab_id": {
                "type": "string",
                "description": "Optional stable tab identifier. Reuse it to update an existing artifact in place.",
                "default": "",
            },
            "live": {
                "type": "boolean",
                "description": "Whether this artifact is expected to receive live updates.",
                "default": False,
            },
            "refresh_seconds": {
                "type": "integer",
                "description": "Suggested refresh interval in seconds for live artifacts. Use 0 for manual refresh only.",
                "default": 0,
                "minimum": 0,
            },
        },
        "required": ["artifact_type", "title", "data"],
    },
}


CLOSE_PANEL_SCHEMA = {
    "name": "close_panel",
    "description": "Close a specific artifact tab, or close all artifact tabs for the current task when tab_id is omitted.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {
                "type": "string",
                "description": "Artifact tab ID to close. Leave empty to close all artifacts for the current task.",
                "default": "",
            }
        },
        "required": [],
    },
}


def _check_requirements() -> bool:
    return True


def _handle_render_panel(args, **kw):
    return render_panel(
        artifact_type=args.get("artifact_type", ""),
        title=args.get("title", ""),
        data=args.get("data", ""),
        tab_id=args.get("tab_id", ""),
        live=args.get("live", False),
        refresh_seconds=args.get("refresh_seconds", 0),
        task_id=kw.get("task_id"),
    )


def _handle_close_panel(args, **kw):
    return close_panel(tab_id=args.get("tab_id", ""), task_id=kw.get("task_id"))


registry.register(
    name="render_panel",
    toolset="ui_panel",
    schema=RENDER_PANEL_SCHEMA,
    handler=_handle_render_panel,
    check_fn=_check_requirements,
)

registry.register(
    name="close_panel",
    toolset="ui_panel",
    schema=CLOSE_PANEL_SCHEMA,
    handler=_handle_close_panel,
    check_fn=_check_requirements,
)
