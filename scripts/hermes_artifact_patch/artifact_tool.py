#!/usr/bin/env python3
"""Artifact side-panel tools for hermelinChat.

This module is installed into Hermes as: tools/artifact_tool.py

Provides tools:

artifacts toolset
- list_artifacts
- focus_artifact
- create_artifact
- remove_artifact
- clear_artifacts
- start_runner
- stop_runner
- tail_runner_log
- artifact_bridge_command
- artifact_bridge_read_state

strudel toolset
- strudel_get_code
- strudel_set_code
- strudel_load_file
- strudel_append_code
- strudel_replace_range
- strudel_get_cursor
- strudel_set_cursor
- strudel_play
- strudel_stop

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
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception:  # pragma: no cover - safe fallback if PyYAML is unavailable
    yaml = None

from tools.registry import registry


ALLOWED_ARTIFACT_TYPES = {"chart", "table", "map", "logs", "html", "markdown", "iframe"}

DEFAULT_ARTIFACT_SUMMARIES = (
    {
        "id": "strudel",
        "type": "iframe",
        "title": "Strudel",
        "persistent": False,
        "live": False,
        "timestamp": 0.0,
        "runner_active": False,
        "default": True,
    },
)

DEFAULT_ARTIFACT_ENABLED_DEFAULTS = {
    "strudel": False,
}


def _load_default_artifact_flags() -> dict[str, bool]:
    config_path = Path(HERMES_HOME).expanduser() / "config.yaml"
    if yaml is None or not config_path.is_file():
        return {}

    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

    if not isinstance(data, dict):
        return {}

    node: Any = data
    for key in ("hermelin", "default_artifacts"):
        if not isinstance(node, dict):
            return {}
        node = node.get(key, {})

    if not isinstance(node, dict):
        return {}

    flags: dict[str, bool] = {}
    for key, value in node.items():
        artifact_id = str(key or "").strip()
        if artifact_id:
            flags[artifact_id] = bool(value)
    return flags


def _enabled_default_artifact_summaries() -> list[dict[str, Any]]:
    flags = _load_default_artifact_flags()
    out: list[dict[str, Any]] = []
    for item in DEFAULT_ARTIFACT_SUMMARIES:
        artifact_id = str(item.get("id") or "").strip()
        if not artifact_id:
            continue
        enabled = flags.get(artifact_id, DEFAULT_ARTIFACT_ENABLED_DEFAULTS.get(artifact_id, True))
        if enabled:
            out.append(dict(item))
    return out


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
RUNNER_PROJECTS_DIR = os.path.join(RUNNERS_DIR, "projects")
PIDS_DIR = os.path.join(ARTIFACTS_HOME, "pids")
BRIDGE_DIR = os.path.join(ARTIFACTS_HOME, "bridge")
BRIDGE_COMMANDS_DIR = os.path.join(BRIDGE_DIR, "commands")
BRIDGE_RESPONSES_DIR = os.path.join(BRIDGE_DIR, "responses")
BRIDGE_STATE_DIR = os.path.join(BRIDGE_DIR, "state")

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


def _sanitize_bridge_name(value: str) -> str:
    return _sanitize_artifact_id(value)


def _bridge_commands_dir() -> Path:
    return _ensure_dir(BRIDGE_COMMANDS_DIR)


def _bridge_responses_dir() -> Path:
    return _ensure_dir(BRIDGE_RESPONSES_DIR)


def _bridge_state_dir() -> Path:
    return _ensure_dir(BRIDGE_STATE_DIR)


def _bridge_state_path(tab_id: str, channel: str) -> Path:
    return _bridge_state_dir() / tab_id / f"{channel}.json"


def _bridge_response_path(request_id: str) -> Path:
    return _bridge_responses_dir() / f"{request_id}.json"


def _queue_bridge_command(payload: dict[str, Any]) -> Path:
    commands_dir = _bridge_commands_dir()
    command_id = _sanitize_bridge_name(str(payload.get("command_id") or "")) or f"cmd_{int(time.time() * 1000)}"
    artifact_id = _sanitize_bridge_name(str(payload.get("artifact_id") or "")) or "artifact"
    path = commands_dir / f"{int(time.time() * 1000)}_{artifact_id}_{command_id}.json"
    _write_json_atomic(path, payload)
    return path


def _wait_for_bridge_response(request_id: str, timeout_seconds: float = 10.0) -> dict[str, Any] | None:
    safe_id = _sanitize_bridge_name(request_id)
    if not safe_id:
        return None
    path = _bridge_response_path(safe_id)
    deadline = time.time() + max(0.1, float(timeout_seconds or 0))
    while time.time() < deadline:
        payload = _read_json(path)
        if isinstance(payload, dict):
            return payload
        time.sleep(0.1)
    return None


def artifact_bridge_command(
    tab_id: str,
    channel: str,
    command: str,
    payload_json: str = "{}",
    expect_response: bool = False,
    timeout_seconds: float = 10.0,
) -> str:
    """Queue a one-shot bridge command for an artifact iframe and optionally wait for a response."""

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    bridge_channel = _sanitize_bridge_name(channel)
    if not bridge_channel:
        return json.dumps({"error": "channel is required"}, ensure_ascii=False)

    action = str(command or "").strip()
    if not action:
        return json.dumps({"error": "command is required"}, ensure_ascii=False)

    try:
        payload_obj = json.loads(payload_json or "{}")
    except json.JSONDecodeError as exc:
        return json.dumps({"error": f"Invalid JSON in payload_json: {exc}"}, ensure_ascii=False)

    if not isinstance(payload_obj, dict):
        return json.dumps({"error": "payload_json must decode to a JSON object"}, ensure_ascii=False)

    request_id = _sanitize_bridge_name(f"req_{int(time.time() * 1000)}_{os.getpid()}")
    command_payload = {
        "command_id": request_id,
        "artifact_id": artifact_id,
        "channel": bridge_channel,
        "command": action,
        "payload": payload_obj,
        "timestamp": time.time(),
    }

    try:
        command_path = _queue_bridge_command(command_payload)
    except Exception as exc:
        return json.dumps({"error": f"failed to queue bridge command: {exc}"}, ensure_ascii=False)

    out: dict[str, Any] = {
        "status": "queued",
        "artifact_id": artifact_id,
        "channel": bridge_channel,
        "command": action,
        "command_id": request_id,
        "path": str(command_path),
    }

    if expect_response:
        resp = _wait_for_bridge_response(request_id, timeout_seconds=timeout_seconds)
        if resp is None:
            out["status"] = "timeout"
            out["timeout_seconds"] = float(timeout_seconds or 0)
            last_state = _read_json(_bridge_state_path(artifact_id, bridge_channel))
            if isinstance(last_state, dict):
                out["state"] = last_state
                if last_state.get("ready") is not True:
                    out["hint"] = "Bridge has not reported ready yet. Focus/open the artifact tab and ensure the bridge-enabled video pack is installed."
            else:
                out["hint"] = "No bridge response received. Focus/open the artifact tab and ensure the bridge-enabled video pack is installed."
        else:
            out["status"] = "ok"
            out["response"] = resp

    return json.dumps(out, ensure_ascii=False)


def artifact_bridge_read_state(tab_id: str, channel: str = "strudel") -> str:
    """Read the latest bridge state snapshot for an artifact/channel."""

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    bridge_channel = _sanitize_bridge_name(channel)
    if not bridge_channel:
        return json.dumps({"error": "channel is required"}, ensure_ascii=False)

    path = _bridge_state_path(artifact_id, bridge_channel)
    payload = _read_json(path)
    if not isinstance(payload, dict):
        return json.dumps({"status": "not_found", "artifact_id": artifact_id, "channel": bridge_channel}, ensure_ascii=False)
    return json.dumps(payload, ensure_ascii=False)


def _coerce_timeout_seconds(value: Any, default: float = 20.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = float(default)
    return max(0.1, min(120.0, parsed))


def _resolve_local_text_path(path: str) -> Path:
    raw = str(path or "").strip()
    if not raw:
        raise ValueError("path is required")
    file_path = Path(os.path.expanduser(raw))
    if not file_path.is_absolute():
        file_path = (Path.cwd() / file_path).absolute()
    return file_path


def strudel_get_code(tab_id: str, timeout_seconds: float = 20.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "get-code",
        "{}",
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 20.0),
    )


def strudel_set_code(tab_id: str, code: str, timeout_seconds: float = 20.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "set-code",
        json.dumps({"code": str(code)}, ensure_ascii=False),
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 20.0),
    )


def strudel_load_file(tab_id: str, path: str, timeout_seconds: float = 30.0) -> str:
    try:
        file_path = _resolve_local_text_path(path)
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)

    if not file_path.exists():
        return json.dumps({"error": f"file not found: {file_path}"}, ensure_ascii=False)
    if not file_path.is_file():
        return json.dumps({"error": f"not a file: {file_path}"}, ensure_ascii=False)

    try:
        code = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return json.dumps({"error": f"file is not valid UTF-8 text: {file_path}"}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"error": f"failed to read file: {exc}"}, ensure_ascii=False)

    line_count = 0 if code == "" else code.count("\n") + 1
    result_raw = strudel_set_code(tab_id=tab_id, code=code, timeout_seconds=timeout_seconds)
    try:
        result_obj = json.loads(result_raw)
    except Exception:
        result_obj = {"raw": result_raw}

    return json.dumps(
        {
            "tab_id": _sanitize_artifact_id(tab_id),
            "path": str(file_path),
            "chars": len(code),
            "line_count": line_count,
            "result": result_obj,
        },
        ensure_ascii=False,
    )


def strudel_append_code(tab_id: str, text: str, timeout_seconds: float = 20.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "append-code",
        json.dumps({"text": str(text)}, ensure_ascii=False),
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 20.0),
    )


def strudel_replace_range(tab_id: str, start: int, end: int, text: str, timeout_seconds: float = 20.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "replace-range",
        json.dumps({"from": int(start), "to": int(end), "text": str(text)}, ensure_ascii=False),
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 20.0),
    )


def strudel_get_cursor(tab_id: str, timeout_seconds: float = 20.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "get-cursor",
        "{}",
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 20.0),
    )


def strudel_set_cursor(tab_id: str, position: int, timeout_seconds: float = 10.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "set-cursor",
        json.dumps({"position": int(position)}, ensure_ascii=False),
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 10.0),
    )


def strudel_play(tab_id: str, timeout_seconds: float = 10.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "play",
        "{}",
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 10.0),
    )


def strudel_stop(tab_id: str, timeout_seconds: float = 10.0) -> str:
    return artifact_bridge_command(
        tab_id,
        "strudel",
        "stop",
        "{}",
        expect_response=True,
        timeout_seconds=_coerce_timeout_seconds(timeout_seconds, 10.0),
    )


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
    """Create or update an artifact for hermelinChat's side panel.

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


def _terminate_pid(pid: int) -> tuple[bool, str | None, str | None]:
    """Best-effort SIGTERM with optional process-group termination.

    Returns: (killed, method, error)
      method: 'killpg' or 'kill'
      error: None | 'process_not_found' | 'permission_denied' | <exception str>
    """

    if not isinstance(pid, int) or pid <= 0:
        return False, None, "invalid_pid"

    method = "kill"
    try:
        use_pgid = False
        if hasattr(os, "getpgid") and hasattr(os, "killpg"):
            try:
                pgid = os.getpgid(pid)
                use_pgid = pgid == pid
            except Exception:
                use_pgid = False

        if use_pgid:
            method = "killpg"
            os.killpg(pid, signal.SIGTERM)
        else:
            method = "kill"
            os.kill(pid, signal.SIGTERM)

        return True, method, None
    except ProcessLookupError:
        return False, method, "process_not_found"
    except PermissionError:
        return False, method, "permission_denied"
    except Exception as exc:
        return False, method, str(exc)


def list_artifacts(scope: str = "all") -> str:
    """List artifacts for the model so it can discover existing panel tabs.

    scope="all": list from both session/ and persistent/
    scope="session": list only session/ plus built-in default tabs
    scope="persistent": list only persistent/
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

            summaries.append({
                "id": artifact_id,
                "type": kind,
                "title": title,
                "persistent": persistent_flag,
                "live": live_flag,
                "timestamp": timestamp_value,
                "runner_active": runner_active,
            })

    if scope_value in {"session", "all"}:
        seen_ids = {str(item.get("id") or "") for item in summaries}
        for item in _enabled_default_artifact_summaries():
            artifact_id = str(item.get("id") or "").strip()
            if not artifact_id or artifact_id in seen_ids:
                continue
            summaries.append(dict(item))

    def _sort_key(item: dict[str, Any]) -> tuple[float, str]:
        try:
            ts = float(item.get("timestamp") or 0.0)
        except Exception:
            ts = 0.0
        return (-ts, str(item.get("id") or ""))

    summaries.sort(key=_sort_key)
    return json.dumps(summaries, ensure_ascii=False)


def focus_artifact(tab_id: str) -> str:
    """Write a focus signal so hermelinChat switches the active artifact tab."""

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


def start_runner(
    tab_id: str,
    runner_code: str = "",
    command: str = "",
    restart: bool = False,
) -> str:
    """Start a background runner process for a live artifact.

    - Project workspace: ~/.hermes/artifacts/runners/projects/{tab_id}/
    - Runner script (optional): ~/.hermes/artifacts/runners/{tab_id}_runner.py
    - PID file (plain text): ~/.hermes/artifacts/pids/{tab_id}.pid
    - Logs: ~/.hermes/artifacts/runners/projects/{tab_id}/runner.log
    - Runner manifest (recommended): ~/.hermes/artifacts/runners/projects/{tab_id}/runner.json
      Example:
        {"scheme": "http", "host": "127.0.0.1", "port": 43123}

    hermelinChat can proxy localhost-bound runners for remote operator browsers.
    If your iframe artifact points at http://127.0.0.1:PORT/, the UI will rewrite it
    to a same-origin, authenticated proxy URL so it works even when the operator is
    on a different machine.

    Provide either:
    - runner_code: Python source to write to the runner script (then it is executed), OR
    - command: a command line to execute (split with shlex; no shell).

    If restart=True and a runner is already active, it is stopped first (but the runner
    script is kept so you can restart without re-sending runner_code).
    """

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    pid_root = _ensure_dir(PIDS_DIR)
    runner_root = _ensure_dir(RUNNERS_DIR)
    projects_root = _ensure_dir(RUNNER_PROJECTS_DIR)
    project_dir = _ensure_dir(str(projects_root / artifact_id))

    pid_path = pid_root / f"{artifact_id}.pid"
    runner_path = runner_root / f"{artifact_id}_runner.py"
    log_path = project_dir / "runner.log"

    existing_pid: int | None = None
    if pid_path.exists() and pid_path.is_file():
        try:
            existing_pid = int(pid_path.read_text(encoding="utf-8").strip())
        except Exception:
            existing_pid = None

    if existing_pid is not None and _is_pid_running(existing_pid):
        if not restart:
            return json.dumps(
                {
                    "status": "already_running",
                    "tab_id": artifact_id,
                    "pid": existing_pid,
                    "pid_path": str(pid_path),
                    "runner_path": str(runner_path) if runner_path.exists() else None,
                    "project_dir": str(project_dir),
                    "log_path": str(log_path),
                },
                ensure_ascii=False,
            )

        # Stop but keep runner script (restart semantics).
        try:
            stop_runner(tab_id=artifact_id, keep_script=True)
        except Exception:
            pass
    else:
        # Clean up stale PID file.
        if pid_path.exists():
            try:
                pid_path.unlink()
            except Exception:
                pass

    # If runner_code is provided, write/update the runner script now.
    if runner_code:
        try:
            runner_path.write_text(str(runner_code), encoding="utf-8")
        except Exception as exc:
            return json.dumps({"error": f"failed to write runner script: {exc}"}, ensure_ascii=False)

    mode = "command" if str(command or "").strip() else "python"

    argv: list[str]
    if mode == "command":
        try:
            argv = shlex.split(str(command))
        except Exception as exc:
            return json.dumps({"error": f"invalid command: {exc}"}, ensure_ascii=False)
        if not argv:
            return json.dumps({"error": "command is empty"}, ensure_ascii=False)
    else:
        if not runner_path.exists():
            return json.dumps(
                {
                    "error": f"runner script not found: {runner_path}. Provide runner_code or command.",
                    "tab_id": artifact_id,
                },
                ensure_ascii=False,
            )
        argv = [sys.executable, str(runner_path)]

    # Spawn detached so the PTY lifecycle doesn't SIGHUP-kill it.
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env["HERMES_ARTIFACT_TAB_ID"] = artifact_id
    env["HERMES_ARTIFACTS_HOME"] = str(Path(ARTIFACTS_HOME))
    env["HERMES_ARTIFACT_PROJECT_DIR"] = str(project_dir)

    log_handle = None
    try:
        log_handle = log_path.open("ab")
        try:
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            log_handle.write(
                f"\n\n[artifact_tool] start_runner {artifact_id} at {stamp} (mode={mode})\n".encode("utf-8")
            )
            log_handle.flush()
        except Exception:
            pass

        proc = subprocess.Popen(
            argv,
            cwd=str(project_dir),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )
    except Exception as exc:
        try:
            if log_handle:
                log_handle.close()
        except Exception:
            pass
        return json.dumps({"error": f"failed to start runner: {exc}"}, ensure_ascii=False)
    finally:
        try:
            if log_handle:
                log_handle.close()
        except Exception:
            pass

    try:
        pid_path.write_text(str(proc.pid), encoding="utf-8")
    except Exception as exc:
        # If we can't write the PID file, immediately stop the runner so it doesn't become orphaned.
        try:
            _terminate_pid(proc.pid)
        except Exception:
            pass
        return json.dumps({"error": f"failed to write pid file: {exc}"}, ensure_ascii=False)

    return json.dumps(
        {
            "status": "started",
            "tab_id": artifact_id,
            "pid": proc.pid,
            "mode": mode,
            "argv": argv,
            "runner_path": str(runner_path) if runner_path.exists() else None,
            "pid_path": str(pid_path),
            "project_dir": str(project_dir),
            "log_path": str(log_path),
        },
        ensure_ascii=False,
    )


def stop_runner(tab_id: str, keep_script: bool = False) -> str:
    """Stop a background runner process for a live artifact.

    Step 6 behavior:
    - Read PID from ~/.hermes/artifacts/pids/{tab_id}.pid
    - If found, send SIGTERM to that PID
    - Delete the PID file
    - Delete the runner script ~/.hermes/artifacts/runners/{tab_id}_runner.py unless keep_script=true

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
    kill_method: str | None = None
    kill_error: str | None = None

    if pid is not None:
        try:
            killed, kill_method, kill_error = _terminate_pid(pid)
        except Exception as exc:
            killed = False
            kill_method = None
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
        if not keep_script and runner_path.exists():
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
            "kill_method": kill_method,
            "kill_error": kill_error,
            "pid_file_removed": pid_file_removed,
            "runner_script_removed": runner_script_removed,
            "keep_script": bool(keep_script),
            "warning": warning,
        },
        ensure_ascii=False,
    )


def _tail_text_file(path: Path, lines: int, max_bytes: int = 200_000) -> tuple[list[str], bool]:
    """Return the last N lines from a UTF-8-ish text file.

    Reads from the end in binary mode so large log files don't blow up memory.

    Returns:
      (lines, truncated)

    truncated=True means we hit max_bytes before collecting enough newlines.
    """

    if lines <= 0:
        return [], False

    block_size = 8192
    data = b""
    truncated = False

    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            remaining = handle.tell()

            while remaining > 0 and data.count(b"\n") <= lines and len(data) < max_bytes:
                read_size = min(block_size, remaining)
                remaining -= read_size
                handle.seek(remaining)
                chunk = handle.read(read_size)
                data = chunk + data

            if remaining > 0 and len(data) >= max_bytes:
                truncated = True

    except Exception:
        # Fallback: small files or weird environments.
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            all_lines = text.splitlines()
            return all_lines[-lines:], False
        except Exception:
            return [], False

    text = data.decode("utf-8", errors="replace")
    out_lines = text.splitlines()[-lines:]
    return out_lines, truncated


def tail_runner_log(tab_id: str, lines: int = 200) -> str:
    """Return the last N lines of the runner.log for a given artifact tab."""

    artifact_id = _sanitize_artifact_id(tab_id)
    if not artifact_id:
        return json.dumps({"error": "tab_id is required"}, ensure_ascii=False)

    try:
        requested = int(lines or 0)
    except (TypeError, ValueError):
        requested = 200

    requested = max(1, min(2000, requested))

    projects_root = _ensure_dir(RUNNER_PROJECTS_DIR)
    log_path = Path(projects_root) / artifact_id / "runner.log"

    if not log_path.exists() or not log_path.is_file():
        return json.dumps(
            {
                "status": "not_found",
                "tab_id": artifact_id,
                "log_path": str(log_path),
                "requested_lines": requested,
                "lines": [],
            },
            ensure_ascii=False,
        )

    try:
        file_size = log_path.stat().st_size
    except Exception:
        file_size = None

    out_lines, truncated = _tail_text_file(log_path, requested)

    return json.dumps(
        {
            "status": "ok",
            "tab_id": artifact_id,
            "log_path": str(log_path),
            "requested_lines": requested,
            "returned_lines": len(out_lines),
            "truncated": bool(truncated),
            "file_size": file_size,
            "lines": out_lines,
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
        "Switch hermelinChat's artifact panel to display a specific artifact by its tab_id. "
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
        "Create or update an artifact in hermelinChat's side panel. "
        "Supports types: chart, table, map, logs, html, markdown, iframe. "
        "Set persistent=true for artifacts that should survive across sessions."
        "\n\n"
        "WHEN TO USE ARTIFACTS:\n"
        "Prefer create_artifact over printing large content to the terminal. "
        "Tables, reports, dashboards, logs, code reviews, long markdown -- anything "
        "over ~30 lines is better as an artifact. The side panel has more space, "
        "supports rich rendering, and the user can keep it open while chatting.\n"
        "For themed HTML/iframe artifacts, CSS variables alone are NOT enough. "
        "You MUST also include the postMessage listener and applyHermesTheme() JS "
        "from examples/artifacts/iframe_theme_skeleton.html. Without that wiring, "
        "the artifact will not update when the user switches themes at runtime. "
        "The skeleton has the full pattern: THEME_DEFAULTS, normalizeThemeColors(), "
        "applyHermesTheme(), and the window.addEventListener(message) handler.\n\n"
        "For live-updating artifacts:\n"
        "IMPORTANT: Background runners MUST write a PID file. Without it, the process "
        "becomes orphaned and cannot be stopped by future sessions or session cleanup.\n"
        "The PID file must contain only the process ID as plain text.\n"
        "Example runner startup (write PID + use a safe project cwd):\n"
        "  import os, pathlib\n"
        "  project_dir = pathlib.Path(os.path.expanduser('~/.hermes/artifacts/runners/projects/{tab_id}'))\n"
        "  project_dir.mkdir(parents=True, exist_ok=True)\n"
        "  os.chdir(project_dir)\n"
        "  with open(os.path.expanduser('~/.hermes/artifacts/pids/{tab_id}.pid'), 'w') as f:\n"
        "      f.write(str(os.getpid()))\n"
        "\n"
        "1) Call create_artifact with live=true, refresh_seconds=N, tab_id='my_id'\n"
        "2) Write an updater script to ~/.hermes/artifacts/runners/{tab_id}_runner.py\n"
        "   (If you need a mini project, put it under ~/.hermes/artifacts/runners/projects/{tab_id}/ — never in ~ or a git repo.)\n"
        "3) The script must write its PID to ~/.hermes/artifacts/pids/{tab_id}.pid on startup\n"
        "4) The script loops, gathers data, and overwrites the artifact JSON file\n"
        "   in ~/.hermes/artifacts/session/{tab_id}.json (or persistent/ if persistent=true)\n"
        "   IMPORTANT: The file you write is the full artifact envelope (id/type/title/data/etc), not just the payload.\n"
        "   Minimal on-disk JSON example (payload goes under the top-level 'data' key):\n"
        "   {\n"
        "     \"id\": \"{tab_id}\",\n"
        "     \"type\": \"logs\",\n"
        "     \"title\": \"Demo logs\",\n"
        "     \"data\": {\"lines\": []},\n"
        "     \"live\": true,\n"
        "     \"refresh_seconds\": 2,\n"
        "     \"timestamp\": 0\n"
        "   }\n"
        "   Payload examples for each type (the 'data' object) live in examples/artifacts/payloads.json.\n"
        "5) Prefer launching via start_runner(tab_id='{tab_id}', runner_code=...) so Hermes manages PID files and a safe cwd automatically.\n"
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


START_RUNNER_SCHEMA = {
    "name": "start_runner",
    "description": (
        "Start a background runner process for a live artifact. "
        "This tool enforces a safe workspace under ~/.hermes/artifacts/runners/projects/{tab_id}/ "
        "and always writes a plain-text PID file to ~/.hermes/artifacts/pids/{tab_id}.pid so "
        "stop_runner() and session cleanup can terminate it reliably. "
        "Runner output is appended to ~/.hermes/artifacts/runners/projects/{tab_id}/runner.log."
        "\n\n"
        "IMPORTANT: Your runner must write a FULL artifact JSON envelope to:\n"
        "  $HERMES_ARTIFACTS_HOME/session/{tab_id}.json\n"
        "(payload goes under the top-level 'data' key; see examples/artifacts/README.md + payloads.json)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {
                "type": "string",
                "description": "Artifact tab ID whose runner should be started.",
            },
            "runner_code": {
                "type": "string",
                "description": (
                    "Optional Python source code to write to ~/.hermes/artifacts/runners/{tab_id}_runner.py "
                    "before starting it. If omitted, start_runner will run the existing runner script."
                ),
                "default": "",
            },
            "command": {
                "type": "string",
                "description": (
                    "Optional command line to run instead of a Python runner script (split with shlex; no shell). "
                    "Example: 'npm run dev -- --port 5173'."
                ),
                "default": "",
            },
            "restart": {
                "type": "boolean",
                "description": "If true and a runner is already active, stop it first (keeping the script) then start again.",
                "default": False,
            },
        },
        "required": ["tab_id"],
    },
}


TAIL_RUNNER_LOG_SCHEMA = {
    "name": "tail_runner_log",
    "description": (
        "Return the last N lines of the background runner log for a given artifact tab_id "
        "(from ~/.hermes/artifacts/runners/projects/{tab_id}/runner.log)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {
                "type": "string",
                "description": "Artifact tab ID whose runner.log should be tailed.",
            },
            "lines": {
                "type": "integer",
                "description": "Number of lines to return from the end of the log file.",
                "default": 200,
                "minimum": 1,
                "maximum": 2000,
            },
        },
        "required": ["tab_id"],
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
            },
            "keep_script": {
                "type": "boolean",
                "description": "If true, keep ~/.hermes/artifacts/runners/{tab_id}_runner.py on disk (useful for restart).",
                "default": False,
            },
        },
        "required": ["tab_id"],
    },
}


ARTIFACT_BRIDGE_COMMAND_SCHEMA = {
    "name": "artifact_bridge_command",
    "description": "Low-level escape hatch for artifact iframe bridge commands. Prefer the typed strudel_* tools unless you need a custom command.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "channel": {"type": "string", "description": "Bridge channel name (e.g. strudel).", "default": "strudel"},
            "command": {"type": "string", "description": "Command name to send to the iframe bridge."},
            "payload_json": {"type": "string", "description": "JSON object payload encoded as a string.", "default": "{}"},
            "expect_response": {"type": "boolean", "description": "Whether to wait for a response file from the iframe bridge.", "default": False},
            "timeout_seconds": {"type": "number", "description": "Max wait time when expect_response=true.", "default": 10.0, "minimum": 0.1, "maximum": 120.0},
        },
        "required": ["tab_id", "channel", "command"],
    },
}


ARTIFACT_BRIDGE_READ_STATE_SCHEMA = {
    "name": "artifact_bridge_read_state",
    "description": "Read the latest bridge state snapshot for an artifact iframe channel.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "channel": {"type": "string", "description": "Bridge channel name.", "default": "strudel"},
        },
        "required": ["tab_id"],
    },
}


STRUDEL_GET_CODE_SCHEMA = {
    "name": "strudel_get_code",
    "description": "Read the live Strudel editor buffer. Use after the artifact is focused/open; do not run concurrently with focus_artifact on the same tab.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "timeout_seconds": {"type": "number", "default": 10.0, "minimum": 0.1, "maximum": 120.0},
        },
        "required": ["tab_id"],
    },
}


STRUDEL_SET_CODE_SCHEMA = {
    "name": "strudel_set_code",
    "description": "Replace the entire Strudel editor buffer with code already in context. For local files or large songs, prefer strudel_load_file.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "code": {"type": "string", "description": "Full code to place in the editor. Prefer strudel_load_file for local files or large songs."},
        },
        "required": ["tab_id", "code"],
    },
}


STRUDEL_LOAD_FILE_SCHEMA = {
    "name": "strudel_load_file",
    "description": "Load a local UTF-8 text file into the Strudel editor. Prefer this over read_file + strudel_set_code for .strudel songs and other large sources.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "path": {"type": "string", "description": "Path to a local UTF-8 text file to load into the editor."},
            "timeout_seconds": {"type": "number", "default": 30.0, "minimum": 0.1, "maximum": 120.0},
        },
        "required": ["tab_id", "path"],
    },
}


STRUDEL_APPEND_CODE_SCHEMA = {
    "name": "strudel_append_code",
    "description": "Append text at the current cursor location in the Strudel editor. Use for small edits; prefer strudel_load_file or strudel_set_code for full-song loads.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "text": {"type": "string", "description": "Text to append."},
        },
        "required": ["tab_id", "text"],
    },
}


STRUDEL_REPLACE_RANGE_SCHEMA = {
    "name": "strudel_replace_range",
    "description": "Replace a character range in the Strudel editor buffer for surgical edits without reloading the whole song.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "start": {"type": "integer", "description": "Start character offset.", "minimum": 0},
            "end": {"type": "integer", "description": "End character offset.", "minimum": 0},
            "text": {"type": "string", "description": "Replacement text."},
        },
        "required": ["tab_id", "start", "end", "text"],
    },
}


STRUDEL_GET_CURSOR_SCHEMA = {
    "name": "strudel_get_cursor",
    "description": "Ask the Strudel artifact bridge for the current cursor position.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "timeout_seconds": {"type": "number", "default": 10.0, "minimum": 0.1, "maximum": 120.0},
        },
        "required": ["tab_id"],
    },
}


STRUDEL_SET_CURSOR_SCHEMA = {
    "name": "strudel_set_cursor",
    "description": "Move the Strudel editor cursor to a specific character offset.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
            "position": {"type": "integer", "description": "Character offset to place the cursor at.", "minimum": 0},
        },
        "required": ["tab_id", "position"],
    },
}


STRUDEL_PLAY_SCHEMA = {
    "name": "strudel_play",
    "description": "Trigger Play/Evaluate in the Strudel artifact.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
        },
        "required": ["tab_id"],
    },
}


STRUDEL_STOP_SCHEMA = {
    "name": "strudel_stop",
    "description": "Stop playback in the Strudel artifact.",
    "parameters": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "string", "description": "Artifact tab ID."},
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


def _handle_start_runner(args, **kw):
    return start_runner(
        tab_id=args.get("tab_id", ""),
        runner_code=args.get("runner_code", ""),
        command=args.get("command", ""),
        restart=args.get("restart", False),
    )


def _handle_stop_runner(args, **kw):
    return stop_runner(tab_id=args.get("tab_id", ""), keep_script=args.get("keep_script", False))


def _handle_tail_runner_log(args, **kw):
    return tail_runner_log(tab_id=args.get("tab_id", ""), lines=args.get("lines", 200))


def _handle_artifact_bridge_command(args, **kw):
    return artifact_bridge_command(
        tab_id=args.get("tab_id", ""),
        channel=args.get("channel", "strudel"),
        command=args.get("command", ""),
        payload_json=args.get("payload_json", "{}"),
        expect_response=args.get("expect_response", False),
        timeout_seconds=args.get("timeout_seconds", 10.0),
    )


def _handle_artifact_bridge_read_state(args, **kw):
    return artifact_bridge_read_state(tab_id=args.get("tab_id", ""), channel=args.get("channel", "strudel"))


def _handle_strudel_get_code(args, **kw):
    return strudel_get_code(tab_id=args.get("tab_id", ""), timeout_seconds=args.get("timeout_seconds", 10.0))


def _handle_strudel_set_code(args, **kw):
    return strudel_set_code(tab_id=args.get("tab_id", ""), code=args.get("code", ""))


def _handle_strudel_load_file(args, **kw):
    return strudel_load_file(
        tab_id=args.get("tab_id", ""),
        path=args.get("path", ""),
        timeout_seconds=args.get("timeout_seconds", 30.0),
    )


def _handle_strudel_append_code(args, **kw):
    return strudel_append_code(tab_id=args.get("tab_id", ""), text=args.get("text", ""))


def _handle_strudel_replace_range(args, **kw):
    return strudel_replace_range(
        tab_id=args.get("tab_id", ""),
        start=args.get("start", 0),
        end=args.get("end", 0),
        text=args.get("text", ""),
    )


def _handle_strudel_get_cursor(args, **kw):
    return strudel_get_cursor(tab_id=args.get("tab_id", ""), timeout_seconds=args.get("timeout_seconds", 10.0))


def _handle_strudel_set_cursor(args, **kw):
    return strudel_set_cursor(tab_id=args.get("tab_id", ""), position=args.get("position", 0))


def _handle_strudel_play(args, **kw):
    return strudel_play(tab_id=args.get("tab_id", ""))


def _handle_strudel_stop(args, **kw):
    return strudel_stop(tab_id=args.get("tab_id", ""))


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
    name="start_runner",
    toolset="artifacts",
    schema=START_RUNNER_SCHEMA,
    handler=_handle_start_runner,
    check_fn=_check_requirements,
)

registry.register(
    name="tail_runner_log",
    toolset="artifacts",
    schema=TAIL_RUNNER_LOG_SCHEMA,
    handler=_handle_tail_runner_log,
    check_fn=_check_requirements,
)

registry.register(
    name="stop_runner",
    toolset="artifacts",
    schema=STOP_RUNNER_SCHEMA,
    handler=_handle_stop_runner,
    check_fn=_check_requirements,
)

registry.register(
    name="artifact_bridge_command",
    toolset="artifacts",
    schema=ARTIFACT_BRIDGE_COMMAND_SCHEMA,
    handler=_handle_artifact_bridge_command,
    check_fn=_check_requirements,
)

registry.register(
    name="artifact_bridge_read_state",
    toolset="artifacts",
    schema=ARTIFACT_BRIDGE_READ_STATE_SCHEMA,
    handler=_handle_artifact_bridge_read_state,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_get_code",
    toolset="artifacts",
    schema=STRUDEL_GET_CODE_SCHEMA,
    handler=_handle_strudel_get_code,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_set_code",
    toolset="artifacts",
    schema=STRUDEL_SET_CODE_SCHEMA,
    handler=_handle_strudel_set_code,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_load_file",
    toolset="artifacts",
    schema=STRUDEL_LOAD_FILE_SCHEMA,
    handler=_handle_strudel_load_file,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_append_code",
    toolset="artifacts",
    schema=STRUDEL_APPEND_CODE_SCHEMA,
    handler=_handle_strudel_append_code,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_replace_range",
    toolset="artifacts",
    schema=STRUDEL_REPLACE_RANGE_SCHEMA,
    handler=_handle_strudel_replace_range,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_get_cursor",
    toolset="artifacts",
    schema=STRUDEL_GET_CURSOR_SCHEMA,
    handler=_handle_strudel_get_cursor,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_set_cursor",
    toolset="artifacts",
    schema=STRUDEL_SET_CURSOR_SCHEMA,
    handler=_handle_strudel_set_cursor,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_play",
    toolset="artifacts",
    schema=STRUDEL_PLAY_SCHEMA,
    handler=_handle_strudel_play,
    check_fn=_check_requirements,
)

registry.register(
    name="strudel_stop",
    toolset="artifacts",
    schema=STRUDEL_STOP_SCHEMA,
    handler=_handle_strudel_stop,
    check_fn=_check_requirements,
)
