from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from .artifacts import is_valid_artifact_id


_LOCALHOST_HOSTS = {
    "127.0.0.1",
    "localhost",
    "0.0.0.0",
    "::1",
}


def runner_project_dir(artifact_dir: Path, tab_id: str) -> Path:
    return Path(artifact_dir) / "runners" / "projects" / str(tab_id)


def runner_manifest_path(artifact_dir: Path, tab_id: str) -> Path:
    return runner_project_dir(artifact_dir, tab_id) / "runner.json"


def _resolve_within(base_dir: Path, path: Path) -> Path | None:
    try:
        base = Path(base_dir).resolve()
        resolved = Path(path).resolve(strict=False)
    except Exception:
        return None

    try:
        resolved.relative_to(base)
    except ValueError:
        return None

    return resolved


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def read_runner_manifest(artifact_dir: Path, tab_id: str) -> dict[str, Any] | None:
    if not is_valid_artifact_id(str(tab_id or "")):
        return None

    project_dir = runner_project_dir(artifact_dir, tab_id)
    path = _resolve_within(project_dir, runner_manifest_path(artifact_dir, tab_id))
    if path is None or not path.exists() or not path.is_file():
        return None

    payload = _read_json(path)
    return payload if isinstance(payload, dict) else None


def _validate_local_upstream(*, scheme: str, host: str, port: int) -> tuple[str, str, int] | None:
    scheme = (scheme or "http").strip().lower() or "http"
    host = (host or "").strip().lower()

    if scheme not in {"http", "https"}:
        return None

    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]

    if host not in _LOCALHOST_HOSTS:
        return None

    try:
        port_i = int(port)
    except Exception:
        return None

    if port_i < 1 or port_i > 65535:
        return None

    return scheme, host, port_i


def upstream_from_manifest(manifest: dict[str, Any]) -> tuple[str, str, int] | None:
    if not isinstance(manifest, dict):
        return None

    scheme = str(manifest.get("scheme") or "http")
    host = str(manifest.get("host") or "127.0.0.1")
    port = manifest.get("port")
    if port is None:
        return None

    return _validate_local_upstream(scheme=scheme, host=host, port=int(port))


def _read_artifact_by_id(artifact_dir: Path, artifact_id: str) -> dict[str, Any] | None:
    if not is_valid_artifact_id(str(artifact_id or "")):
        return None

    root = Path(artifact_dir)
    candidates = [
        (root / "session", root / "session" / f"{artifact_id}.json"),
        (root / "persistent", root / "persistent" / f"{artifact_id}.json"),
        (root, root / f"{artifact_id}.json"),  # legacy
    ]

    for base_dir, candidate in candidates:
        path = _resolve_within(base_dir, candidate)
        if path is None or not path.exists() or not path.is_file():
            continue
        payload = _read_json(path)
        if isinstance(payload, dict):
            payload.setdefault("id", artifact_id)
            return payload

    return None


def _upstream_from_local_url(url: str) -> tuple[str, str, int] | None:
    url = (url or "").strip()
    if not url:
        return None

    try:
        parsed = urlparse(url)
    except Exception:
        return None

    scheme = (parsed.scheme or "http").strip().lower()
    host = (parsed.hostname or "").strip().lower()
    port = parsed.port

    if not host or port is None:
        return None

    return _validate_local_upstream(scheme=scheme, host=host, port=int(port))


def discover_runner_upstream(artifact_dir: Path, tab_id: str) -> tuple[str, str, int] | None:
    """Return (scheme, host, port) for the runner corresponding to tab_id.

    Preference order:
    1) runner.json manifest written by the runner
    2) parse localhost URL from the iframe artifact's data.src

    Only localhost upstreams are allowed to prevent SSRF.
    """

    if not is_valid_artifact_id(str(tab_id or "")):
        return None

    manifest = read_runner_manifest(artifact_dir, tab_id)
    upstream = upstream_from_manifest(manifest) if manifest else None
    if upstream:
        return upstream

    artifact = _read_artifact_by_id(artifact_dir, str(tab_id))
    if not artifact:
        return None

    try:
        data = artifact.get("data") if isinstance(artifact.get("data"), dict) else {}
        src = data.get("src") if isinstance(data, dict) else None
    except Exception:
        src = None

    if isinstance(src, str):
        upstream = _upstream_from_local_url(src)
        if upstream:
            return upstream

    return None
