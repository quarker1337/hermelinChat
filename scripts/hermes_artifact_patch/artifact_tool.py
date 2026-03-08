#!/usr/bin/env python3
"""Artifact side-panel tools for hermilinChat.

This module is installed into Hermes as: tools/artifact_tool.py

Step 1 refactor (see docs/artifacts/artifact-tool-refactor.md):
- Renamed from tools/render_panel_tool.py -> tools/artifact_tool.py
- New tool surface area:
  - create_artifact
  - remove_artifact
  - clear_artifacts
  - stop_runner

NOTE: Steps 2+ will further evolve runtime directories (session/persistent)
and add background runner processes for live artifacts.
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


def create_artifact(
    artifact_type: str,
    title: str,
    data: str,
    tab_id: str = "",
    persistent: bool = False,
    live: bool = False,
    refresh_seconds: int = 0,
    task_id: str | None = None,
) -> str:
    """Create or update an artifact for hermilinChat's side panel.

    NOTE: Step 1 keeps the existing single-directory storage model.
    Step 2+ will split this into session/ vs persistent/ directories.
    """

    kind = (artifact_type or "").strip().lower()
    if kind not in ALLOWED_ARTIFACT_TYPES:
        return json.dumps(
            {"error": f"Unsupported artifact_type: {artifact_type}. Allowed: {sorted(ALLOWED_ARTIFACT_TYPES)}"},
            ensure_ascii=False,
        )

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
        "persistent": bool(persistent),
        "timestamp": now,
        "created_at": existing.get("created_at", now) if isinstance(existing, dict) else now,
        "updated_at": now,
        "source": "create_artifact",
        "task_id": task_id,
        "session_id": os.getenv("HERMES_SESSION_ID") or None,
        "version": 1,
    }

    _write_json_atomic(path, artifact)
    _write_json_atomic(_ensure_artifact_dir() / "_latest.json", artifact)

    return json.dumps(
        {
            "artifact_id": artifact_id,
            "status": "created",
            "path": str(path),
            "type": kind,
            "title": title,
            "updated_at": now,
            "persistent": bool(persistent),
        },
        ensure_ascii=False,
    )


def remove_artifact(tab_id: str, task_id: str | None = None) -> str:
    """Delete a single artifact tab by its tab_id."""

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    root = _ensure_artifact_dir()
    target = root / f"{artifact_id}.json"
    now = time.time()

    if not target.exists():
        return json.dumps({"status": "not_found", "tab_id": artifact_id, "removed": False}, ensure_ascii=False)

    try:
        target.unlink()
    except OSError as exc:
        return json.dumps({"error": f"Failed to remove artifact '{artifact_id}': {exc}"}, ensure_ascii=False)

    _recompute_latest()

    # Optional: allow UI to react immediately (server may choose to forward this).
    _write_close_signal({
        "action": "close",
        "id": artifact_id,
        "task_id": task_id,
        "timestamp": now,
    })

    return json.dumps({"status": "removed", "tab_id": artifact_id, "removed": True}, ensure_ascii=False)


def clear_artifacts(scope: str = "session", task_id: str | None = None) -> str:
    """Clear artifacts by scope.

    NOTE: Step 1 still uses a single artifacts directory, so scope is accepted
    but currently behaves the same for all values.
    """

    scope_value = (scope or "session").strip().lower()
    if scope_value not in {"session", "persistent", "all"}:
        return json.dumps({"error": "scope must be one of: session, persistent, all"}, ensure_ascii=False)

    now = time.time()

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

    return json.dumps(
        {
            "status": "cleared",
            "scope": scope_value,
            "count": len(removed_ids),
            "artifact_ids": removed_ids,
        },
        ensure_ascii=False,
    )


def stop_runner(tab_id: str) -> str:
    """Stop a background runner process for a live artifact.

    Step 1 stub: runner processes are implemented in later steps.
    """

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    return json.dumps({"status": "not_implemented", "tab_id": artifact_id}, ensure_ascii=False)


CREATE_ARTIFACT_SCHEMA = {
    "name": "create_artifact",
    "description": (
        "Create or update a structured artifact in hermilinChat's right-side panel. "
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
            "persistent": {
                "type": "boolean",
                "description": "Whether this artifact should survive across Hermes sessions (Step 2+).",
                "default": False,
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


REMOVE_ARTIFACT_SCHEMA = {
    "name": "remove_artifact",
    "description": "Remove a specific artifact tab by its tab_id.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {
                "type": "string",
                "description": "Artifact tab ID to remove.",
            }
        },
        "required": ["tab_id"],
    },
}


CLEAR_ARTIFACTS_SCHEMA = {
    "name": "clear_artifacts",
    "description": "Clear multiple artifacts by scope (session/persistent/all).",
    "parameters": {
        "type": "object",
        "properties": {
            "scope": {
                "type": "string",
                "enum": ["session", "persistent", "all"],
                "description": "Which artifact scope to clear.",
                "default": "session",
            }
        },
        "required": [],
    },
}


STOP_RUNNER_SCHEMA = {
    "name": "stop_runner",
    "description": "Stop a live artifact updater runner process for a given tab_id.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {
                "type": "string",
                "description": "Artifact tab ID whose runner should be stopped.",
            }
        },
        "required": ["tab_id"],
    },
}


def _check_requirements() -> bool:
    return True


def _handle_create_artifact(args, **kw):
    return create_artifact(
        artifact_type=args.get("artifact_type", ""),
        title=args.get("title", ""),
        data=args.get("data", ""),
        tab_id=args.get("tab_id", ""),
        persistent=args.get("persistent", False),
        live=args.get("live", False),
        refresh_seconds=args.get("refresh_seconds", 0),
        task_id=kw.get("task_id"),
    )


def _handle_remove_artifact(args, **kw):
    return remove_artifact(tab_id=args.get("tab_id", ""), task_id=kw.get("task_id"))


def _handle_clear_artifacts(args, **kw):
    return clear_artifacts(scope=args.get("scope", "session"), task_id=kw.get("task_id"))


def _handle_stop_runner(args, **kw):
    return stop_runner(tab_id=args.get("tab_id", ""))


registry.register(
    name="create_artifact",
    toolset="ui_panel",
    schema=CREATE_ARTIFACT_SCHEMA,
    handler=_handle_create_artifact,
    check_fn=_check_requirements,
)

registry.register(
    name="remove_artifact",
    toolset="ui_panel",
    schema=REMOVE_ARTIFACT_SCHEMA,
    handler=_handle_remove_artifact,
    check_fn=_check_requirements,
)

registry.register(
    name="clear_artifacts",
    toolset="ui_panel",
    schema=CLEAR_ARTIFACTS_SCHEMA,
    handler=_handle_clear_artifacts,
    check_fn=_check_requirements,
)

registry.register(
    name="stop_runner",
    toolset="ui_panel",
    schema=STOP_RUNNER_SCHEMA,
    handler=_handle_stop_runner,
    check_fn=_check_requirements,
)
