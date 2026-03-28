from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception:  # pragma: no cover - safe fallback if PyYAML is unavailable
    yaml = None

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

_DEFAULT_ARTIFACT_ENABLED_DEFAULTS: dict[str, bool] = {
    "strudel": False,
}

_DEFAULT_ARTIFACT_DESCRIPTIONS: dict[str, str] = {
    "strudel": "Built-in Strudel live-coding editor for music sketches and pattern experiments.",
}


def _default_artifact_config_path(*, artifact_root: Path | None = None, hermes_home: Path | None = None) -> Path | None:
    if hermes_home is not None:
        return Path(hermes_home).expanduser() / "config.yaml"
    if artifact_root is None:
        return None
    return Path(artifact_root).expanduser().parent / "config.yaml"


def _load_default_artifact_flags(*, artifact_root: Path | None = None, hermes_home: Path | None = None) -> dict[str, bool]:
    config_path = _default_artifact_config_path(artifact_root=artifact_root, hermes_home=hermes_home)
    if yaml is None or config_path is None or not config_path.is_file():
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


def list_default_artifact_settings(*, artifact_root: Path | None = None, hermes_home: Path | None = None) -> list[dict[str, Any]]:
    flags = _load_default_artifact_flags(artifact_root=artifact_root, hermes_home=hermes_home)

    items: list[dict[str, Any]] = []
    for item in _DEFAULT_ARTIFACTS:
        artifact_id = str(item.get("id") or "").strip()
        if not artifact_id:
            continue
        enabled_by_default = bool(_DEFAULT_ARTIFACT_ENABLED_DEFAULTS.get(artifact_id, True))
        items.append(
            {
                "id": artifact_id,
                "title": str(item.get("title") or artifact_id),
                "description": _DEFAULT_ARTIFACT_DESCRIPTIONS.get(artifact_id, ""),
                "enabled": bool(flags.get(artifact_id, enabled_by_default)),
                "enabled_by_default": enabled_by_default,
            }
        )
    return items


def load_default_artifacts(*, artifact_root: Path | None = None, hermes_home: Path | None = None) -> list[dict[str, Any]]:
    settings = list_default_artifact_settings(artifact_root=artifact_root, hermes_home=hermes_home)
    enabled_ids = {str(item.get("id") or "").strip() for item in settings if item.get("enabled")}

    enabled_items: list[dict[str, Any]] = []
    for item in _DEFAULT_ARTIFACTS:
        artifact_id = str(item.get("id") or "").strip()
        if not artifact_id or artifact_id not in enabled_ids:
            continue
        enabled_items.append(copy.deepcopy(item))
    return enabled_items


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
