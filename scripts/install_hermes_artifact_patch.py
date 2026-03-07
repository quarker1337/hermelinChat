#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
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


def _candidate_repo_paths(hermes_exe: Path) -> dict[str, Path] | None:
    candidates = []
    try:
        candidates.append(hermes_exe.resolve().parents[2])
    except Exception:
        pass
    try:
        candidates.append(hermes_exe.parent.parent.parent.resolve())
    except Exception:
        pass

    seen = set()
    for root in candidates:
        root = root.resolve()
        if root in seen:
            continue
        seen.add(root)
        model_tools = root / 'model_tools.py'
        toolsets = root / 'toolsets.py'
        tools_dir = root / 'tools'
        if model_tools.is_file() and toolsets.is_file() and (tools_dir / '__init__.py').is_file():
            return {
                'model_tools': model_tools,
                'toolsets': toolsets,
                'tools_dir': tools_dir,
            }
    return None


def _discover_live_paths(hermes_exe: Path, hermes_python: Path) -> dict[str, Path]:
    repo_paths = _candidate_repo_paths(hermes_exe)
    if repo_paths is not None:
        return repo_paths

    code = r'''
import json
import site
from pathlib import Path

bases = []
try:
    bases.extend(Path(p).resolve() for p in site.getsitepackages())
except Exception:
    pass
try:
    user_site = site.getusersitepackages()
    if user_site:
        bases.append(Path(user_site).resolve())
except Exception:
    pass

for base in bases:
    model_tools = base / 'model_tools.py'
    toolsets = base / 'toolsets.py'
    tools_dir = base / 'tools'
    if model_tools.is_file() and toolsets.is_file() and (tools_dir / '__init__.py').is_file():
        print(json.dumps({
            'model_tools': str(model_tools),
            'toolsets': str(toolsets),
            'tools_dir': str(tools_dir),
        }))
        raise SystemExit(0)

raise SystemExit(1)
'''
    result = subprocess.run(
        [str(hermes_python), '-c', code],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        stderr = (result.stderr or '').strip()
        raise RuntimeError(
            'Could not locate live Hermes source files from the active installation. '
            'If Hermes is installed in a custom location, pass --hermes-python explicitly. '
            f'Stderr: {stderr or "<none>"}'
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
