#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ASSET_DIR = SCRIPT_DIR / "hermes_artifact_patch"
RENDER_PANEL_TOOL_SRC = ASSET_DIR / "render_panel_tool.py"

UI_PANEL_BLOCK = '''
    "ui_panel": {
        "description": "Render structured artifacts in hermilinChat's right-side artifact panel",
        "tools": ["render_panel", "close_panel"],
        "includes": []
    },
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Patch the active Hermes installation with hermilinChat artifact tools.",
    )
    parser.add_argument(
        "--hermes-exe",
        default="hermes",
        help="Hermes executable to inspect (default: hermes from PATH)",
    )
    parser.add_argument(
        "--hermes-python",
        default="",
        help="Override the Python interpreter used by the Hermes installation.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without modifying files.",
    )
    return parser.parse_args()


def _resolve_hermes_exe(path_or_name: str) -> Path:
    candidate = Path(path_or_name).expanduser()
    if candidate.is_file():
        return candidate.resolve()

    found = shutil.which(path_or_name)
    if not found:
        raise FileNotFoundError(f"Could not find Hermes executable: {path_or_name}")
    return Path(found).resolve()


def _detect_hermes_python(hermes_exe: Path, explicit: str) -> Path:
    if explicit:
        python_path = Path(explicit).expanduser().resolve()
        if not python_path.is_file():
            raise FileNotFoundError(f"Hermes Python not found: {python_path}")
        return python_path

    try:
        first_line = hermes_exe.read_text(encoding="utf-8").splitlines()[0].strip()
    except Exception as exc:
        raise RuntimeError(f"Could not read shebang from {hermes_exe}: {exc}") from exc

    if not first_line.startswith("#!"):
        raise RuntimeError(f"Unexpected Hermes launcher format: {hermes_exe}")

    shebang = first_line[2:].strip().split()
    if not shebang:
        raise RuntimeError(f"Could not parse shebang from {hermes_exe}")

    if Path(shebang[0]).name == "env":
        if len(shebang) < 2:
            raise RuntimeError(f"env shebang missing interpreter in {hermes_exe}")
        resolved = shutil.which(shebang[1])
        if not resolved:
            raise RuntimeError(f"Could not resolve interpreter from shebang: {shebang[1]}")
        return Path(resolved).resolve()

    return Path(shebang[0]).expanduser().resolve()


def _discover_live_paths(hermes_exe: Path, hermes_python: Path) -> dict[str, Path]:
    """Locate the live Hermes source files we need to patch.

    This intentionally avoids importing Hermes modules (which can have side
    effects and optional dependency imports). Instead, we ask the Hermes
    interpreter to resolve module specs for:

    - model_tools (for tool discovery imports)
    - toolsets (for toolset definitions)
    - tools package directory (to install render_panel_tool.py)

    This works for both normal installs and editable (PEP 660) installs.
    """

    code = r'''
import json
import importlib.util
from pathlib import Path


def _origin(name: str) -> str:
    spec = importlib.util.find_spec(name)
    if spec is None:
        raise SystemExit(f"missing module: {name}")
    origin = spec.origin
    if not origin:
        raise SystemExit(f"missing origin for module: {name}")
    return str(Path(origin).resolve())


model_tools = _origin("model_tools")
toolsets = _origin("toolsets")

tools_spec = importlib.util.find_spec("tools")
if tools_spec is None:
    raise SystemExit("missing module: tools")

if tools_spec.submodule_search_locations:
    tools_dir = str(Path(list(tools_spec.submodule_search_locations)[0]).resolve())
elif tools_spec.origin:
    tools_dir = str(Path(tools_spec.origin).resolve().parent)
else:
    raise SystemExit("could not resolve tools package directory")

print(json.dumps({
    "model_tools": model_tools,
    "toolsets": toolsets,
    "tools_dir": tools_dir,
}, ensure_ascii=False))
'''

    result = subprocess.run(
        [str(hermes_python), "-c", code],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(
            "Could not locate live Hermes source files from the active installation. "
            "If Hermes is installed in a custom location, pass --hermes-python explicitly. "
            f"Stderr: {stderr or '<none>'}"
        )

    try:
        data = json.loads(result.stdout.strip())
    except Exception as exc:
        raise RuntimeError(f"Could not decode Hermes path discovery output: {result.stdout!r}") from exc

    paths = {key: Path(value) for key, value in data.items()}
    for key, path in paths.items():
        if not path.exists():
            raise FileNotFoundError(f"Resolved Hermes path for {key} does not exist: {path}")
    return paths


def _read_text_with_newline(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text, newline


def _write_text_with_newline(path: Path, text: str, newline: str) -> None:
    with path.open("w", encoding="utf-8", newline=newline) as handle:
        handle.write(text)


def _patch_model_tools(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)
    if '"tools.render_panel_tool"' in text:
        return False, "model_tools.py already references tools.render_panel_tool"

    anchor = '        "tools.homeassistant_tool",'
    if anchor not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}")

    patched = text.replace(anchor, anchor + newline + '        "tools.render_panel_tool",', 1)
    _write_text_with_newline(path, patched, newline)
    return True, f"Patched {path.name}"


def _patch_toolsets(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)
    if '"ui_panel": {' in text:
        return False, "toolsets.py already defines ui_panel"

    anchor = newline + newline + '    # Scenario-specific toolsets' + newline
    if anchor not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}")

    block = UI_PANEL_BLOCK.replace("\n", newline)
    patched = text.replace(anchor, newline + block + anchor, 1)
    _write_text_with_newline(path, patched, newline)
    return True, f"Patched {path.name}"


def _install_render_panel_tool(tools_dir: Path) -> tuple[bool, str]:
    target = tools_dir / "render_panel_tool.py"
    source_text = RENDER_PANEL_TOOL_SRC.read_text(encoding="utf-8")
    if target.exists() and target.read_text(encoding="utf-8") == source_text:
        return False, f"{target.name} already up to date"
    target.write_text(source_text, encoding="utf-8")
    return True, f"Installed {target.name}"


def main() -> int:
    args = parse_args()

    if not RENDER_PANEL_TOOL_SRC.exists():
        print(f"ERROR: patch asset missing: {RENDER_PANEL_TOOL_SRC}", file=sys.stderr)
        return 1

    try:
        hermes_exe = _resolve_hermes_exe(args.hermes_exe)
        hermes_python = _detect_hermes_python(hermes_exe, args.hermes_python)
        live_paths = _discover_live_paths(hermes_exe, hermes_python)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Hermes artifact patch target")
    print(f"  hermes exe:    {hermes_exe}")
    print(f"  hermes python: {hermes_python}")
    print(f"  model_tools:   {live_paths['model_tools']}")
    print(f"  toolsets:      {live_paths['toolsets']}")
    print(f"  tools dir:     {live_paths['tools_dir']}")

    if args.dry_run:
        print("\nDry run only. No files changed.")
        return 0

    changes = []
    try:
        changed, message = _install_render_panel_tool(live_paths["tools_dir"])
        changes.append((changed, message))
        changed, message = _patch_model_tools(live_paths["model_tools"])
        changes.append((changed, message))
        changed, message = _patch_toolsets(live_paths["toolsets"])
        changes.append((changed, message))
    except Exception as exc:
        print(f"ERROR: failed to patch Hermes installation: {exc}", file=sys.stderr)
        return 1

    print()
    for changed, message in changes:
        prefix = "UPDATED" if changed else "OK"
        print(f"{prefix}: {message}")

    print()
    print("Next steps")
    print("  1) restart hermilinChat / Hermes services if they are already running")
    print("  2) if your Hermes config uses restricted toolsets, make sure 'ui_panel' or 'all' is enabled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
