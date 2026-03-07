from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


ARTIFACT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def ensure_artifact_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_valid_artifact_id(value: str) -> bool:
    return bool(value) and bool(ARTIFACT_ID_RE.fullmatch(value))


def artifact_path(root: Path, artifact_id: str) -> Path:
    return ensure_artifact_dir(root) / f"{artifact_id}.json"


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


def list_artifacts(root: Path) -> list[dict[str, Any]]:
    ensure_artifact_dir(root)
    artifacts: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.json"), key=lambda p: p.name):
        if path.name.startswith("_"):
            continue
        payload = _read_json(path)
        if payload is None:
            continue
        artifacts.append(payload)
    artifacts.sort(key=lambda item: float(item.get("timestamp") or 0.0), reverse=True)
    return artifacts


def latest_artifact(root: Path) -> dict[str, Any] | None:
    latest_path = ensure_artifact_dir(root) / "_latest.json"
    payload = _read_json(latest_path)
    if payload is not None:
        return payload

    artifacts = list_artifacts(root)
    return artifacts[0] if artifacts else None


def recompute_latest(root: Path) -> None:
    latest_path = ensure_artifact_dir(root) / "_latest.json"
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
    return max(artifacts, key=lambda item: float(item.get("timestamp") or 0.0))


def delete_artifact(root: Path, artifact_id: str) -> bool:
    if not is_valid_artifact_id(artifact_id):
        raise ValueError("invalid artifact id")

    target = artifact_path(root, artifact_id)
    existed = target.exists()
    if existed:
        target.unlink()
    recompute_latest(root)
    return existed
