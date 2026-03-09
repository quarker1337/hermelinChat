#!/usr/bin/env python3
"""Artifact side-panel tools for hermilinChat.

This module is installed into Hermes as: tools/artifact_tool.py

See docs/artifacts/artifact-tool-refactor.md for rationale.

Provides tools:
- list_artifacts
- focus_artifact
- create_artifact
- remove_artifact
- clear_artifacts
- stop_runner

Artifacts are written under:
- $HERMES_HOME/artifacts/session/
- $HERMES_HOME/artifacts/persistent/

$HERMES_HOME/artifacts/_latest.json is updated for quick polling.

For live artifacts, a background runner can be written to:
- $HERMES_HOME/artifacts/runners/{tab_id}_runner.py
and its PID must be written to:
- $HERMES_HOME/artifacts/pids/{tab_id}.pid

stop_runner() sends SIGTERM and cleans up the PID + runner script.
"""

from __future__ import annotations

import json
import os
import signal
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from tools.registry import registry


ALLOWED_ARTIFACT_TYPES = {"chart", "table", "map", "logs", "html", "markdown", "iframe"}


# -----------------------------------------------------------------------------
# Runtime directory layout (Step 2)
#
# All runtime files must live under ~/.hermes (or $HERMES_HOME if overridden).
# Never write runtime state inside a git repository.
# -----------------------------------------------------------------------------

HERMES_HOME = os.path.expanduser(os.getenv("HERMES_HOME", "~/.hermes"))

ARTIFACTS_HOME = os.path.join(HERMES_HOME, "artifacts")

ARTIFACT_SESSION_DIR = os.path.join(ARTIFACTS_HOME, "session")
ARTIFACT_PERSISTENT_DIR = os.path.join(ARTIFACTS_HOME, "persistent")

# Root artifacts dir holds metadata helper files like _latest.json and
# _close_signal.json.
ARTIFACTS_ROOT_DIR = ARTIFACTS_HOME

RUNNERS_DIR = os.path.join(ARTIFACTS_HOME, "runners")
PIDS_DIR = os.path.join(ARTIFACTS_HOME, "pids")

# Legacy (pre-move) locations
LEGACY_RUNNERS_DIR = os.path.join(HERMES_HOME, "runners")
LEGACY_PIDS_DIR = os.path.join(HERMES_HOME, "pids")


def _ensure_dir(path: str) -> Path:
    os.makedirs(path, exist_ok=True)
    return Path(path)


def _ensure_artifacts_root_dir() -> Path:
    return _ensure_dir(ARTIFACTS_ROOT_DIR)


def _migrate_legacy_runner_layout() -> None:
    """Move legacy runner/PID files into artifacts/ (best-effort)."""

    def _migrate_dir(src_dir: str, dest_dir: str, pattern: str) -> None:
        src_root = Path(src_dir)
        if not src_root.exists() or not src_root.is_dir():
            return

        candidates = [p for p in src_root.glob(pattern) if p.is_file()]
        if not candidates:
            return

        dest_root = _ensure_dir(dest_dir)
        for src_path in candidates:
            dest_path = dest_root / src_path.name
            try:
                if dest_path.exists():
                    # Already migrated: remove the legacy copy.
                    try:
                        src_path.unlink()
                    except Exception:
                        pass
                    continue
                os.replace(src_path, dest_path)
            except Exception:
                # Best-effort fallback: try copy+delete.
                try:
                    dest_path.write_bytes(src_path.read_bytes())
                    src_path.unlink()
                except Exception:
                    pass

        # If the legacy directory is now empty, try to remove it.
        try:
            if not any(src_root.iterdir()):
                src_root.rmdir()
        except Exception:
            pass

    # Only migrate files that match our expected naming patterns.
    _migrate_dir(LEGACY_RUNNERS_DIR, RUNNERS_DIR, "*_runner.py")
    _migrate_dir(LEGACY_PIDS_DIR, PIDS_DIR, "*.pid")


# Run migration once on import (safe/no-op if nothing to move).
try:
    _migrate_legacy_runner_layout()
except Exception:
    pass


def _sanitize_artifact_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    safe = safe.strip("._-")
    return safe[:120]


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    os.makedirs(path.parent, exist_ok=True)
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
    paths: list[Path] = []
    for dir_path in (ARTIFACT_SESSION_DIR, ARTIFACT_PERSISTENT_DIR):
        root = _ensure_dir(dir_path)
        paths.extend([p for p in root.glob("*.json") if p.is_file() and not p.name.startswith("_")])

    # Sort for deterministic output: by directory scope (session/persistent) then filename.
    return sorted(paths, key=lambda p: (p.parent.name, p.name))


def _iter_artifacts() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for path in _list_artifact_paths():
        payload = _read_json(path)
        if isinstance(payload, dict):
            items.append(payload)
    return items


def _recompute_latest() -> None:
    latest_path = _ensure_artifacts_root_dir() / "_latest.json"
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
    signal_path = _ensure_artifacts_root_dir() / "_close_signal.json"
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

    Step 3 behavior:
    - Writes artifacts to ~/.hermes/artifacts/session/ by default
    - Writes artifacts to ~/.hermes/artifacts/persistent/ when persistent=True
    - Always updates ~/.hermes/artifacts/_latest.json for quick polling
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

    target_dir = ARTIFACT_PERSISTENT_DIR if persistent else ARTIFACT_SESSION_DIR
    target_root = _ensure_dir(target_dir)
    path = target_root / f"{artifact_id}.json"

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
    _write_json_atomic(_ensure_artifacts_root_dir() / "_latest.json", artifact)

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
    """Delete a single artifact tab by its tab_id.

    Step 4 behavior:
    - Deletes {tab_id}.json from BOTH the session/ and persistent/ directories if present
    - Calls stop_runner(tab_id) to terminate any live updater
    """

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    removed_paths: list[str] = []

    for dir_path in (ARTIFACT_SESSION_DIR, ARTIFACT_PERSISTENT_DIR):
        target = Path(dir_path) / f"{artifact_id}.json"
        if not target.exists():
            continue
        try:
            target.unlink()
            removed_paths.append(str(target))
        except OSError as exc:
            return json.dumps({"error": f"Failed to remove artifact '{artifact_id}': {exc}"}, ensure_ascii=False)

    if removed_paths:
        try:
            _recompute_latest()
        except Exception:
            pass

    # Stop any live runner, even if the artifact file wasn't found.
    runner_result: dict[str, Any] | None = None
    try:
        runner_result = json.loads(stop_runner(tab_id))
    except Exception:
        runner_result = None

    if not removed_paths:
        return json.dumps(
            {"status": "not_found", "tab_id": artifact_id, "removed": False, "runner": runner_result},
            ensure_ascii=False,
        )

    return json.dumps(
        {"status": "removed", "tab_id": artifact_id, "removed": True, "paths": removed_paths, "runner": runner_result},
        ensure_ascii=False,
    )


def clear_artifacts(scope: str = "session", task_id: str | None = None) -> str:
    """Clear artifacts by scope.

    Step 5 behavior:
    - scope="session": delete all files in ARTIFACT_SESSION_DIR
    - scope="persistent": delete all files in ARTIFACT_PERSISTENT_DIR
    - scope="all": delete all files in both

    Always emits a close_all signal so hermelinChat can hide the panel.
    """

    scope_value = (scope or "session").strip().lower()
    if scope_value not in {"session", "persistent", "all"}:
        return json.dumps({"error": "scope must be one of: session, persistent, all"}, ensure_ascii=False)

    now = time.time()

    dirs_to_clear: list[str] = []
    if scope_value in {"session", "all"}:
        dirs_to_clear.append(ARTIFACT_SESSION_DIR)
    if scope_value in {"persistent", "all"}:
        dirs_to_clear.append(ARTIFACT_PERSISTENT_DIR)

    removed_paths: list[str] = []
    removed_ids: list[str] = []

    # Stop runners first (best-effort), then delete artifacts.
    # This avoids races where a live runner recreates the artifact file.
    ids_to_stop: set[str] = set()
    for dir_path in dirs_to_clear:
        root = _ensure_dir(dir_path)
        for path in root.glob("*.json"):
            if not path.is_file() or path.name.startswith("_"):
                continue
            ids_to_stop.add(path.stem)

    # scope=all should stop any remaining runners too (even if their artifact files are missing)
    if scope_value == "all":
        try:
            pid_root = _ensure_dir(PIDS_DIR)
            for pid_path in pid_root.glob("*.pid"):
                if pid_path.is_file():
                    ids_to_stop.add(pid_path.stem)
        except Exception:
            pass

    for artifact_id in sorted(ids_to_stop):
        try:
            stop_runner(artifact_id)
        except Exception:
            pass

    for dir_path in dirs_to_clear:
        root = _ensure_dir(dir_path)
        for path in sorted(root.glob("*.json"), key=lambda p: p.name):
            if not path.is_file() or path.name.startswith("_"):
                continue
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError as exc:
                return json.dumps({"error": f"Failed to remove artifact '{path.name}': {exc}"}, ensure_ascii=False)

            removed_paths.append(str(path))
            removed_ids.append(path.stem)

    try:
        _recompute_latest()
    except Exception:
        pass

    # Always emit close_all even if no artifacts existed (lets UI close the empty-state panel).
    _write_close_signal({
        "action": "close_all",
        "task_id": task_id,
        "scope": scope_value,
        "artifact_ids": sorted(set(removed_ids)),
        "timestamp": now,
    })

    return json.dumps(
        {
            "status": "cleared",
            "scope": scope_value,
            "count": len(removed_paths),
            "artifact_ids": sorted(set(removed_ids)),
        },
        ensure_ascii=False,
    )


def _is_pid_running(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False

    try:
        # Signal 0 does not kill the process; it just performs error checking.
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # The process exists, but we don't have permission to signal it.
        return True
    except Exception:
        return False


def list_artifacts(scope: str = "all") -> str:
    """List artifacts for the model so it can discover existing panel tabs.

    scope="all": list from both session/ and persistent/
    scope="session": list only session/
    scope="persistent": list only persistent/

    For each artifact file we return a summary:
    {id, type, title, persistent, live, timestamp, runner_active}

    runner_active is determined by checking for a matching PID file under
    ~/.hermes/artifacts/pids/ and then verifying the PID still exists.
    """

    scope_value = (scope or "all").strip().lower()
    if scope_value not in {"session", "persistent", "all"}:
        return json.dumps({"error": "scope must be one of: session, persistent, all"}, ensure_ascii=False)

    dirs_to_list: list[str] = []
    if scope_value in {"session", "all"}:
        dirs_to_list.append(ARTIFACT_SESSION_DIR)
    if scope_value in {"persistent", "all"}:
        dirs_to_list.append(ARTIFACT_PERSISTENT_DIR)

    pid_root = _ensure_dir(PIDS_DIR)

    summaries: list[dict[str, Any]] = []
    for dir_path in dirs_to_list:
        root = _ensure_dir(dir_path)
        for path in sorted(root.glob("*.json"), key=lambda p: p.name):
            if not path.is_file() or path.name.startswith("_"):
                continue

            payload = _read_json(path)
            if not isinstance(payload, dict):
                payload = {}

            artifact_id_raw = payload.get("id") or path.stem
            artifact_id = _sanitize_artifact_id(str(artifact_id_raw)) or path.stem

            kind = str(payload.get("type") or "")
            title = str(payload.get("title") or "")
            persistent_flag = path.parent.name == "persistent"
            live_flag = bool(payload.get("live"))

            timestamp_value: float
            if "timestamp" in payload:
                try:
                    timestamp_value = float(payload.get("timestamp") or 0.0)
                except Exception:
                    timestamp_value = 0.0
            else:
                try:
                    timestamp_value = float(path.stat().st_mtime)
                except Exception:
                    timestamp_value = 0.0

            runner_active = False
            pid_path = pid_root / f"{artifact_id}.pid"
            if pid_path.exists() and pid_path.is_file():
                try:
                    pid_value = int(pid_path.read_text(encoding="utf-8").strip())
                except Exception:
                    pid_value = -1

                runner_active = _is_pid_running(pid_value)

            summaries.append(
                {
                    "id": artifact_id,
                    "type": kind,
                    "title": title,
                    "persistent": persistent_flag,
                    "live": live_flag,
                    "timestamp": timestamp_value,
                    "runner_active": runner_active,
                }
            )

    def _sort_key(item: dict[str, Any]) -> tuple[float, str]:
        try:
            ts = float(item.get("timestamp") or 0.0)
        except Exception:
            ts = 0.0
        return (-ts, str(item.get("id") or ""))

    summaries.sort(key=_sort_key)
    return json.dumps(summaries, ensure_ascii=False)


def focus_artifact(tab_id: str) -> str:
    """Write a focus signal so hermilinChat switches the active artifact tab."""

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    candidates = [
        Path(ARTIFACT_SESSION_DIR) / f"{artifact_id}.json",
        Path(ARTIFACT_PERSISTENT_DIR) / f"{artifact_id}.json",
        # Legacy (older layouts may have root-level artifacts)
        Path(ARTIFACTS_ROOT_DIR) / f"{artifact_id}.json",
    ]

    if not any(path.exists() for path in candidates):
        return json.dumps({"error": f"artifact not found: {artifact_id}"}, ensure_ascii=False)

    now = time.time()
    payload = {
        "action": "focus",
        "tab_id": artifact_id,
        "timestamp": now,
    }

    try:
        _write_json_atomic(_ensure_artifacts_root_dir() / "_focus.json", payload)
    except Exception as exc:
        return json.dumps({"error": f"failed to write focus signal: {exc}"}, ensure_ascii=False)

    return json.dumps({"status": "focused", "tab_id": artifact_id}, ensure_ascii=False)


def stop_runner(tab_id: str) -> str:
    """Stop a background runner process for a live artifact.

    Step 6 behavior:
    - Read PID from ~/.hermes/artifacts/pids/{tab_id}.pid
    - If found, send SIGTERM to that PID
    - Delete the PID file
    - Delete the runner script ~/.hermes/artifacts/runners/{tab_id}_runner.py if it exists

    Best-effort: processes may already be dead; cleanup should still succeed.
    """

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    pid_root = _ensure_dir(PIDS_DIR)
    runner_root = _ensure_dir(RUNNERS_DIR)

    pid_path = pid_root / f"{artifact_id}.pid"
    runner_path = runner_root / f"{artifact_id}_runner.py"

    had_pid_file = pid_path.exists()

    warning: str | None = None
    if not had_pid_file and runner_path.exists():
        warning = (
            f"WARNING: stop_runner: PID file not found for tab_id='{artifact_id}'. "
            f"Expected: {pid_path}. "
            "Background runners MUST write PID files as plain text on startup or they become orphaned."
        )
        try:
            print(f"[artifact_tool] {warning}")
        except Exception:
            pass

    pid: int | None = None
    if had_pid_file:
        try:
            pid_text = pid_path.read_text(encoding="utf-8").strip()
            pid = int(pid_text)
        except Exception:
            pid = None

    killed = False
    kill_error: str | None = None

    if pid is not None:
        try:
            os.kill(pid, signal.SIGTERM)
            killed = True
        except ProcessLookupError:
            kill_error = "process_not_found"
        except PermissionError:
            kill_error = "permission_denied"
        except Exception as exc:
            kill_error = str(exc)

    pid_file_removed = False
    runner_script_removed = False

    try:
        if pid_path.exists():
            pid_path.unlink()
            pid_file_removed = True
    except Exception:
        pass

    try:
        if runner_path.exists():
            runner_path.unlink()
            runner_script_removed = True
    except Exception:
        pass

    status = "stopped" if had_pid_file else "not_running"

    return json.dumps(
        {
            "status": status,
            "tab_id": artifact_id,
            "pid": pid,
            "killed": killed,
            "kill_error": kill_error,
            "pid_file_removed": pid_file_removed,
            "runner_script_removed": runner_script_removed,
            "warning": warning,
        },
        ensure_ascii=False,
    )


LIST_ARTIFACTS_SCHEMA = {
    "name": "list_artifacts",
    "description": (
        "List existing artifacts so the model can discover what tabs already exist. "
        "Returns a JSON array of summaries with runner status."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "scope": {
                "type": "string",
                "enum": ["all", "session", "persistent"],
                "description": "Which artifact scope to list.",
                "default": "all",
            }
        },
        "required": [],
    },
}


FOCUS_ARTIFACT_SCHEMA = {
    "name": "focus_artifact",
    "description": (
        "Switch hermilinChat's artifact panel to display a specific artifact by its tab_id. "
        "Also opens the panel if it is currently closed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {
                "type": "string",
                "description": "Artifact tab ID to focus.",
            }
        },
        "required": ["tab_id"],
    },
}


CREATE_ARTIFACT_SCHEMA = {
    "name": "create_artifact",
    "description": (
        "Create or update an artifact in hermilinChat's side panel. "
        "Supports types: chart, table, map, logs, html, markdown, iframe. "
        "Set persistent=true for artifacts that should survive across sessions."
        "\n\n"
        "For live-updating artifacts:\n"
        "IMPORTANT: Background runners MUST write a PID file. Without it, the process "
        "becomes orphaned and cannot be stopped by future sessions or session cleanup.\n"
        "The PID file must contain only the process ID as plain text.\n"
        "Example runner startup:\n"
        "  import os\n"
        "  with open(os.path.expanduser('~/.hermes/artifacts/pids/{tab_id}.pid'), 'w') as f:\n"
        "      f.write(str(os.getpid()))\n"
        "\n"
        "1) Call create_artifact with live=true, refresh_seconds=N, tab_id='my_id'\n"
        "2) Write an updater script to ~/.hermes/artifacts/runners/{tab_id}_runner.py\n"
        "3) The script must write its PID to ~/.hermes/artifacts/pids/{tab_id}.pid on startup\n"
        "4) The script loops, gathers data, and overwrites the artifact JSON file\n"
        "   in ~/.hermes/artifacts/session/{tab_id}.json (or persistent/ if persistent=true)\n"
        "5) Launch with: nohup python3 ~/.hermes/artifacts/runners/{tab_id}_runner.py &\n"
        "6) NEVER place runner scripts inside any git repository\n"
        "7) Handle SIGTERM gracefully for clean shutdown (stop_runner sends SIGTERM)\n"
        "\n"
        "Use stop_runner(tab_id) to terminate the updater and clean up PID + runner script."
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


def _handle_list_artifacts(args, **kw):
    return list_artifacts(scope=args.get("scope", "all"))


def _handle_focus_artifact(args, **kw):
    return focus_artifact(tab_id=args.get("tab_id", ""))


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
    name="list_artifacts",
    toolset="artifacts",
    schema=LIST_ARTIFACTS_SCHEMA,
    handler=_handle_list_artifacts,
    check_fn=_check_requirements,
)

registry.register(
    name="focus_artifact",
    toolset="artifacts",
    schema=FOCUS_ARTIFACT_SCHEMA,
    handler=_handle_focus_artifact,
    check_fn=_check_requirements,
)

registry.register(
    name="create_artifact",
    toolset="artifacts",
    schema=CREATE_ARTIFACT_SCHEMA,
    handler=_handle_create_artifact,
    check_fn=_check_requirements,
)

registry.register(
    name="remove_artifact",
    toolset="artifacts",
    schema=REMOVE_ARTIFACT_SCHEMA,
    handler=_handle_remove_artifact,
    check_fn=_check_requirements,
)

registry.register(
    name="clear_artifacts",
    toolset="artifacts",
    schema=CLEAR_ARTIFACTS_SCHEMA,
    handler=_handle_clear_artifacts,
    check_fn=_check_requirements,
)

registry.register(
    name="stop_runner",
    toolset="artifacts",
    schema=STOP_RUNNER_SCHEMA,
    handler=_handle_stop_runner,
    check_fn=_check_requirements,
)
