from __future__ import annotations

import json
import os
import re
import signal
import tempfile
from pathlib import Path
from typing import Any, Iterable


ARTIFACT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")

SESSION_SUBDIR = "session"
PERSISTENT_SUBDIR = "persistent"
RUNNERS_SUBDIR = "runners"
PIDS_SUBDIR = "pids"


def ensure_artifact_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def artifact_root_dir(root: Path) -> Path:
    return ensure_artifact_dir(root)


def artifact_session_dir(root: Path) -> Path:
    return ensure_artifact_dir(artifact_root_dir(root) / SESSION_SUBDIR)


def artifact_persistent_dir(root: Path) -> Path:
    return ensure_artifact_dir(artifact_root_dir(root) / PERSISTENT_SUBDIR)


def artifact_runners_dir(root: Path) -> Path:
    return ensure_artifact_dir(artifact_root_dir(root) / RUNNERS_SUBDIR)


def artifact_pids_dir(root: Path) -> Path:
    return ensure_artifact_dir(artifact_root_dir(root) / PIDS_SUBDIR)


def is_valid_artifact_id(value: str) -> bool:
    return bool(value) and bool(ARTIFACT_ID_RE.fullmatch(value))


def _artifact_updated_ts(item: dict[str, Any]) -> float:
    try:
        return float(item.get("updated_at") or item.get("timestamp") or 0.0)
    except Exception:
        return 0.0


def _artifact_sort_ts(item: dict[str, Any]) -> float:
    # Prefer the writer's primary timestamp field for ordering.
    try:
        return float(item.get("timestamp") or item.get("updated_at") or 0.0)
    except Exception:
        return 0.0


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
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


def _iter_artifact_files(root: Path) -> Iterable[tuple[Path, bool]]:
    """Yield (path, persistent_bool) for each artifact JSON file.

    We read from:
    - {root}/session/*.json
    - {root}/persistent/*.json

    And for backward compatibility (old render_panel tool):
    - {root}/*.json

    Files beginning with '_' are reserved metadata helper files and ignored.
    """

    session_dir = artifact_session_dir(root)
    for path in sorted(session_dir.glob("*.json"), key=lambda p: p.name):
        if not path.is_file() or path.name.startswith("_"):
            continue
        yield path, False

    persistent_dir = artifact_persistent_dir(root)
    for path in sorted(persistent_dir.glob("*.json"), key=lambda p: p.name):
        if not path.is_file() or path.name.startswith("_"):
            continue
        yield path, True

    # Legacy root-level artifacts (pre session/persistent split)
    root_dir = artifact_root_dir(root)
    for path in sorted(root_dir.glob("*.json"), key=lambda p: p.name):
        if not path.is_file() or path.name.startswith("_"):
            continue
        yield path, False


def list_artifacts(root: Path) -> list[dict[str, Any]]:
    artifact_root_dir(root)

    artifacts_by_id: dict[str, dict[str, Any]] = {}

    for path, persistent in _iter_artifact_files(root):
        payload = _read_json(path)
        if payload is None:
            continue

        artifact_id = str(payload.get("id") or path.stem)
        if not is_valid_artifact_id(artifact_id):
            continue

        payload["id"] = artifact_id
        payload["persistent"] = bool(persistent)

        prev = artifacts_by_id.get(artifact_id)
        if prev is None:
            artifacts_by_id[artifact_id] = payload
            continue

        # De-dupe: keep the newest by updated_at/timestamp; if tied, prefer persistent.
        prev_key = (_artifact_updated_ts(prev), 1 if bool(prev.get("persistent")) else 0)
        curr_key = (_artifact_updated_ts(payload), 1 if payload["persistent"] else 0)
        if curr_key > prev_key:
            artifacts_by_id[artifact_id] = payload

    artifacts = list(artifacts_by_id.values())
    artifacts.sort(key=_artifact_sort_ts, reverse=True)
    return artifacts


def latest_artifact(root: Path) -> dict[str, Any] | None:
    latest_path = artifact_root_dir(root) / "_latest.json"
    payload = _read_json(latest_path)
    if payload is not None:
        artifact_id = str(payload.get("id") or "").strip()
        if artifact_id and is_valid_artifact_id(artifact_id):
            # Best-effort: infer persistent if missing.
            if "persistent" not in payload:
                payload["persistent"] = (artifact_persistent_dir(root) / f"{artifact_id}.json").exists()
        return payload

    artifacts = list_artifacts(root)
    return artifacts[0] if artifacts else None


def recompute_latest(root: Path) -> None:
    latest_path = artifact_root_dir(root) / "_latest.json"
    latest = latest_artifact_from_list(list_artifacts(root))
    if latest is None:
        try:
            latest_path.unlink(missing_ok=True)
        except Exception:
            pass
        return
    _write_json_atomic(latest_path, latest)


def latest_artifact_from_list(artifacts: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not artifacts:
        return None
    return max(artifacts, key=_artifact_updated_ts)


def delete_artifact(root: Path, artifact_id: str) -> bool:
    if not is_valid_artifact_id(artifact_id):
        raise ValueError("invalid artifact id")

    removed_any = False
    candidates = [
        artifact_session_dir(root) / f"{artifact_id}.json",
        artifact_persistent_dir(root) / f"{artifact_id}.json",
        artifact_root_dir(root) / f"{artifact_id}.json",  # legacy
    ]

    for target in candidates:
        if not target.exists():
            continue
        target.unlink()
        removed_any = True

    recompute_latest(root)
    return removed_any


def cleanup_session_artifacts(root: Path) -> dict[str, Any]:
    """Best-effort cleanup for session-scoped artifacts.

    When hermilinChat starts a *new* Hermes session, we want to remove old
    session-only artifacts so they don't persist forever.

    Behavior:
    - Delete artifact JSON files under: {root}/session/
    - Kill + remove runner PID files ONLY for session artifacts (not persistent)
      by cross-referencing artifact IDs in session/ vs persistent/.
    - Remove matching runner scripts under: {root}/runners/
    - Remove {root}/_latest.json so the UI doesn't quick-poll stale artifacts.
    """

    root_dir = artifact_root_dir(root)
    session_dir = artifact_session_dir(root)
    persistent_dir = artifact_persistent_dir(root)
    runners_dir = artifact_runners_dir(root)
    pids_dir = artifact_pids_dir(root)

    persistent_ids: set[str] = set()
    for path in persistent_dir.glob("*.json"):
        if not path.is_file() or path.name.startswith("_"):
            continue
        persistent_ids.add(path.stem)

    session_paths: list[Path] = []
    session_ids: set[str] = set()
    for path in session_dir.glob("*.json"):
        if not path.is_file() or path.name.startswith("_"):
            continue
        session_paths.append(path)
        session_ids.add(path.stem)

    pid_files_removed = 0
    runner_scripts_removed = 0
    kill_attempts = 0

    # Only stop runners that correspond to session artifacts and do NOT also
    # exist as persistent artifacts.
    for artifact_id in sorted(session_ids):
        if artifact_id in persistent_ids:
            continue

        pid_path = pids_dir / f"{artifact_id}.pid"
        if pid_path.exists() and pid_path.is_file():
            pid: int | None = None
            try:
                pid = int(pid_path.read_text(encoding="utf-8").strip())
            except Exception:
                pid = None

            if pid is not None and pid > 0:
                kill_attempts += 1
                try:
                    # Prefer killing the whole process group if the runner was started detached
                    # (artifact_tool.start_runner uses start_new_session=True so pgid==pid).
                    if hasattr(os, "getpgid") and hasattr(os, "killpg"):
                        try:
                            if os.getpgid(pid) == pid:
                                os.killpg(pid, signal.SIGTERM)
                            else:
                                os.kill(pid, signal.SIGTERM)
                        except Exception:
                            os.kill(pid, signal.SIGTERM)
                    else:
                        os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    pass
                except Exception:
                    pass

            try:
                pid_path.unlink()
                pid_files_removed += 1
            except Exception:
                pass

        runner_path = runners_dir / f"{artifact_id}_runner.py"
        if runner_path.exists() and runner_path.is_file():
            try:
                runner_path.unlink()
                runner_scripts_removed += 1
            except Exception:
                pass

    removed_artifacts = 0
    removed_ids: list[str] = []
    for path in sorted(session_paths, key=lambda p: p.name):
        try:
            path.unlink()
            removed_artifacts += 1
            removed_ids.append(path.stem)
        except Exception:
            pass

    latest_removed = False
    latest_path = root_dir / "_latest.json"
    try:
        if latest_path.exists():
            latest_path.unlink()
            latest_removed = True
    except Exception:
        pass

    return {
        "ok": True,
        "removed_artifacts": removed_artifacts,
        "removed_artifact_ids": removed_ids,
        "pid_files_removed": pid_files_removed,
        "runner_scripts_removed": runner_scripts_removed,
        "kill_attempts": kill_attempts,
        "latest_removed": latest_removed,
    }

