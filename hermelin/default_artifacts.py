from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

_PACKAGE_ASSET_DIR = Path(__file__).resolve().parent / "default_artifact_assets"

_DEFAULT_ARTIFACTS: tuple[dict[str, Any], ...] = (
    {
        "id": "strudel",
        "type": "iframe",
        "title": "Strudel",
        "timestamp": 0.0,
        "updated_at": 0.0,
        "persistent": False,
        "live": False,
        "default": True,
        "deletable": False,
        "data": {"src": "/api/default-artifacts/strudel/index.html"},
    },
)


def load_default_artifacts() -> list[dict[str, Any]]:
    return [copy.deepcopy(item) for item in _DEFAULT_ARTIFACTS]


def resolve_default_artifact_path(static_dir: Path, asset_path: str) -> Path | None:
    raw = str(asset_path or "").strip().lstrip("/")
    if not raw:
        return None

    candidate_roots = [_PACKAGE_ASSET_DIR]
    if static_dir:
        candidate_roots.append(static_dir / "artifacts")

    for root in candidate_roots:
        base_dir = root.resolve()
        candidate = (base_dir / raw).resolve()
        try:
            candidate.relative_to(base_dir)
        except Exception:
            continue
        if candidate.is_file():
            return candidate

    return None
