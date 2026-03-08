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
ARTIFACT_TOOL_SRC = ASSET_DIR / "artifact_tool.py"

# NOTE: Step 1 keeps the toolset name as "ui_panel" for compatibility with
# existing Hermes configs. Later steps rename this toolset to "artifacts".
UI_PANEL_BLOCK = '''
    "ui_panel": {
        "description": "Render structured artifacts in hermilinChat's right-side artifact panel",
        "tools": ["create_artifact", "remove_artifact", "clear_artifacts", "stop_runner"],
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
    """Resolve the Python interpreter used by the Hermes installation.

    IMPORTANT: do NOT call .resolve() on the interpreter path.

    In many venvs `venv/bin/python3` is a symlink to a base interpreter.
    Python detects the venv via pyvenv.cfg relative to argv[0]; resolving
    the symlink can bypass the venv and make installed Hermes modules
    disappear (e.g. model_tools not importable).
    """

    def _abs_no_resolve(path: Path) -> Path:
        p = path.expanduser()
        if p.is_absolute():
            return p
        return (Path.cwd() / p).absolute()

    if explicit:
        python_path = _abs_no_resolve(Path(explicit))
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
        python_path = _abs_no_resolve(Path(resolved))
        if not python_path.is_file():
            raise FileNotFoundError(f"Hermes Python not found: {python_path}")
        return python_path

    python_path = Path(shebang[0]).expanduser()
    if not python_path.is_absolute():
        python_path = (hermes_exe.parent / python_path).absolute()
    if not python_path.is_file():
        raise FileNotFoundError(f"Hermes Python not found: {python_path}")
    return python_path


def _discover_live_paths(hermes_exe: Path, hermes_python: Path) -> dict[str, Path]:
    """Locate the live Hermes source files we need to patch.

    This intentionally avoids importing Hermes modules (which can have side
    effects and optional dependency imports). Instead, we ask the Hermes
    interpreter to resolve module specs for:

    - model_tools (for tool discovery imports)
    - toolsets (for toolset definitions)
    - tools package directory (to install artifact_tool.py)

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

    if '"tools.artifact_tool"' in text:
        return False, "model_tools.py already references tools.artifact_tool"

    # Upgrade path: previous versions imported tools.render_panel_tool.
    if '"tools.render_panel_tool"' in text:
        patched = text.replace('"tools.render_panel_tool"', '"tools.artifact_tool"')
        _write_text_with_newline(path, patched, newline)
        return True, "Updated model_tools.py: tools.render_panel_tool -> tools.artifact_tool"

    anchor = '        "tools.homeassistant_tool",'
    if anchor not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}")

    patched = text.replace(anchor, anchor + newline + '        "tools.artifact_tool",', 1)
    _write_text_with_newline(path, patched, newline)
    return True, f"Patched {path.name}"


def _patch_toolsets(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    # If ui_panel already exists, try to upgrade it in-place (only if it's
    # clearly our hermilinChat-inserted block).
    if '"ui_panel": {' in text:
        desc = "hermilinChat's right-side artifact panel"
        if desc not in text:
            return False, "toolsets.py already defines ui_panel (not hermilinChat); leaving in place"

        # Already updated?
        if '"create_artifact"' in text and '"stop_runner"' in text:
            return False, "toolsets.py already defines updated ui_panel"

        old_tools_line = '        "tools": ["render_panel", "close_panel"],'
        new_tools_line = '        "tools": ["create_artifact", "remove_artifact", "clear_artifacts", "stop_runner"],'
        if old_tools_line in text:
            patched = text.replace(old_tools_line, new_tools_line, 1)
            _write_text_with_newline(path, patched, newline)
            return True, "Updated ui_panel toolset tool list"

        # Fallback: attempt a more flexible replacement of the tools array.
        pattern = re.compile(
            r'(\"ui_panel\"\s*:\s*\{.*?\n\s*\"tools\"\s*:\s*)\[[^\]]*\]',
            re.DOTALL,
        )
        m = pattern.search(text)
        if not m:
            return False, "Could not locate ui_panel tools list to update"

        replacement = (
            m.group(1)
            + '["create_artifact", "remove_artifact", "clear_artifacts", "stop_runner"]'
        )
        patched = pattern.sub(replacement, text, count=1)
        _write_text_with_newline(path, patched, newline)
        return True, "Updated ui_panel toolset tool list (pattern match)"

    anchor = newline + newline + '    # Scenario-specific toolsets' + newline
    if anchor not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}")

    block = UI_PANEL_BLOCK.replace("\n", newline)
    patched = text.replace(anchor, newline + block + anchor, 1)
    _write_text_with_newline(path, patched, newline)
    return True, f"Patched {path.name}"


def _install_artifact_tool(tools_dir: Path) -> tuple[bool, str]:
    target = tools_dir / "artifact_tool.py"
    source_text = ARTIFACT_TOOL_SRC.read_text(encoding="utf-8")

    changed = False
    messages: list[str] = []

    # Cleanup legacy file name from earlier patch versions.
    legacy = tools_dir / "render_panel_tool.py"
    if legacy.exists():
        try:
            legacy_text = legacy.read_text(encoding="utf-8")
        except Exception:
            legacy_text = ""

        if "Artifact side-panel tools for hermilinChat" in legacy_text:
            legacy.unlink()
            changed = True
            messages.append("removed legacy render_panel_tool.py")
        else:
            messages.append("legacy render_panel_tool.py present (not ours; left in place)")

    if target.exists() and target.read_text(encoding="utf-8") == source_text:
        if changed:
            return True, f"{target.name} already up to date; " + "; ".join(messages)
        return False, f"{target.name} already up to date"

    target.write_text(source_text, encoding="utf-8")
    messages.insert(0, f"installed {target.name}")
    return True, "; ".join(messages)


def main() -> int:
    args = parse_args()

    if not ARTIFACT_TOOL_SRC.exists():
        print(f"ERROR: patch asset missing: {ARTIFACT_TOOL_SRC}", file=sys.stderr)
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
        changed, message = _install_artifact_tool(live_paths["tools_dir"])
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
