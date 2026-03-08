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
        description="Undo the hermilinChat artifact tools patch from the active Hermes installation.",
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
    disappear.
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

    first_line = hermes_exe.read_text(encoding="utf-8").splitlines()[0].strip()
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


def _discover_live_paths(hermes_python: Path) -> dict[str, Path]:
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

    data = json.loads(result.stdout.strip())
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


def _uninstall_artifact_tool(tools_dir: Path) -> tuple[bool, str]:
    changed = False
    messages: list[str] = []

    # Remove the current tool file (artifact_tool.py) only if it matches our
    # patch asset exactly.
    target = tools_dir / "artifact_tool.py"
    if not target.exists():
        messages.append(f"{target.name} not present")
    else:
        src_text = ARTIFACT_TOOL_SRC.read_text(encoding="utf-8")
        live_text = target.read_text(encoding="utf-8")
        if live_text != src_text:
            messages.append(f"{target.name} differs from patch asset; leaving in place")
        else:
            target.unlink()
            changed = True
            messages.append(f"Removed {target.name}")

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
            messages.append("Removed legacy render_panel_tool.py")
        else:
            messages.append("Legacy render_panel_tool.py differs; leaving in place")

    return changed, "; ".join(messages)


def _unpatch_model_tools(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    needles = ("tools.artifact_tool", "tools.render_panel_tool")
    if not any(needle in text for needle in needles):
        return False, "model_tools.py has no artifact tool import entry"

    lines = text.splitlines(True)
    kept: list[str] = []
    removed = 0
    for line in lines:
        if any(needle in line for needle in needles):
            removed += 1
            continue
        kept.append(line)

    if not removed:
        return False, "model_tools.py has no artifact tool import entry"

    patched = "".join(kept)
    _write_text_with_newline(path, patched, newline)
    return True, f"Removed {removed} line(s) referencing artifact tool import(s)"


def _unpatch_toolsets(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    anchor = newline + newline + "    # Scenario-specific toolsets" + newline
    block = UI_PANEL_BLOCK.replace("\n", newline)

    needle = newline + block + anchor
    if needle in text:
        patched = text.replace(needle, anchor, 1)
        _write_text_with_newline(path, patched, newline)
        return True, "Removed ui_panel toolset block (exact match)"

    # fallback: only remove if it matches our very specific description
    if "\"ui_panel\":" not in text and "\"ui_panel\"" not in text:
        return False, "toolsets.py has no ui_panel toolset"

    desc = "hermilinChat's right-side artifact panel"
    if desc not in text:
        return False, "ui_panel exists but does not match hermilinChat patch; leaving in place"

    pattern = re.compile(
        r"\n\s*\"ui_panel\"\s*:\s*\{.*?\n\s*\},\s*\n",
        re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return False, "Could not locate ui_panel block to remove"

    patched = text[: m.start()] + newline + text[m.end() :]
    _write_text_with_newline(path, patched, newline)
    return True, "Removed ui_panel toolset block (pattern match)"


def main() -> int:
    args = parse_args()

    if not ARTIFACT_TOOL_SRC.exists():
        print(f"ERROR: patch asset missing: {ARTIFACT_TOOL_SRC}", file=sys.stderr)
        return 1

    try:
        hermes_exe = _resolve_hermes_exe(args.hermes_exe)
        hermes_python = _detect_hermes_python(hermes_exe, args.hermes_python)
        live_paths = _discover_live_paths(hermes_python)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Hermes artifact UNpatch target")
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
        changed, message = _uninstall_artifact_tool(live_paths["tools_dir"])
        changes.append((changed, message))
        changed, message = _unpatch_model_tools(live_paths["model_tools"])
        changes.append((changed, message))
        changed, message = _unpatch_toolsets(live_paths["toolsets"])
        changes.append((changed, message))
    except Exception as exc:
        print(f"ERROR: failed to unpatch Hermes installation: {exc}", file=sys.stderr)
        return 1

    print()
    for changed, message in changes:
        prefix = "UPDATED" if changed else "OK"
        print(f"{prefix}: {message}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
