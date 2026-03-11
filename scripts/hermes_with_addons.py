#!/usr/bin/env python3
"""hermes_with_addons.py — Hermes launcher wrapper for hermilinChat.

Purpose
-------
hermilinChat needs a few Hermes tools ("artifacts" toolset) to drive the right-side
Artifact Panel.

We do NOT patch files inside ~/.hermes/hermes-agent anymore (keeps Hermes upgradable).
Instead, hermilinChat wraps the Hermes launcher and registers the tools at runtime.

This script is executed using the *same Python interpreter* that the `hermes` CLI
uses (the hermes-agent venv), and then calls into `hermes_cli.main.main()`.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


_ARTIFACT_TOOL_NAMES = [
    "list_artifacts",
    "focus_artifact",
    "create_artifact",
    "remove_artifact",
    "clear_artifacts",
    "start_runner",
    "tail_runner_log",
    "stop_runner",
]


def _load_module_from_path(module_name: str, path: Path):
    spec = importlib.util.spec_from_file_location(module_name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module spec for {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _ensure_artifacts_toolset():
    # Create a runtime toolset so --toolsets "..., artifacts" works without patching toolsets.py
    from toolsets import TOOLSETS, create_custom_toolset

    if "artifacts" not in TOOLSETS:
        create_custom_toolset(
            name="artifacts",
            description="Create and manage artifacts in hermilinChat's right-side artifact panel",
            tools=list(_ARTIFACT_TOOL_NAMES),
            includes=[],
        )
        return

    ts = TOOLSETS.get("artifacts")
    if not isinstance(ts, dict):
        ts = {"description": "hermilinChat artifacts", "tools": [], "includes": []}
    tools = ts.get("tools") if isinstance(ts.get("tools"), list) else []
    for t in _ARTIFACT_TOOL_NAMES:
        if t not in tools:
            tools.append(t)
    ts["tools"] = tools
    ts.setdefault("includes", [])
    ts.setdefault("description", "Create and manage artifacts in hermilinChat's right-side artifact panel")
    TOOLSETS["artifacts"] = ts


def _install_artifact_tools():
    """Register artifact panel tools into Hermes' tool registry.

    If the user still has a legacy patched Hermes install (tools.artifact_tool),
    we import it (idempotent). Otherwise we load our vendored tool module.
    """

    # First: ensure toolset exists regardless of where tools come from.
    _ensure_artifacts_toolset()

    # Legacy patched install: import it if available.
    try:
        import tools.artifact_tool  # noqa: F401
        return
    except Exception:
        pass

    # Vendored tool module (kept in this repo)
    here = Path(__file__).resolve().parent
    tool_path = here / "hermes_artifact_patch" / "artifact_tool.py"
    if not tool_path.is_file():
        return

    _load_module_from_path("hermilin_vendored_artifact_tool", tool_path)


def main() -> int:
    try:
        _install_artifact_tools()
    except Exception:
        # Never block the CLI; just run without addons.
        pass

    from hermes_cli.main import main as hermes_main

    return int(hermes_main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
