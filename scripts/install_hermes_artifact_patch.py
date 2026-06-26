#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ASSET_DIR = SCRIPT_DIR / "hermes_artifact_patch"
ARTIFACT_TOOL_SRC = ASSET_DIR / "artifact_tool.py"

# hermelinChat toolset injection
#
# We install a generic "artifacts" toolset for the right-side panel plus an
# optional "strudel" toolset for Strudel-specific controls.
ARTIFACT_TOOLSETS_BLOCK = '''
    # hermelinChat artifact panel toolsets (installed by hermelinChat patch)
    "artifacts": {
        "description": "Create and manage artifacts in hermelinChat's right-side panel. Prefer artifacts over terminal output for large/rich content (tables, reports, logs, dashboards, code).",
        "tools": [
            "list_artifacts",
            "focus_artifact",
            "create_artifact",
            "remove_artifact",
            "clear_artifacts",
            "start_runner",
            "tail_runner_log",
            "stop_runner",
            "artifact_bridge_command",
            "artifact_bridge_read_state"
        ],
        "includes": []
    },
    "strudel": {
        "description": "Control a Strudel artifact in hermelinChat (code, cursor, play/stop)",
        "tools": [
            "strudel_get_code",
            "strudel_set_code",
            "strudel_load_file",
            "strudel_append_code",
            "strudel_replace_range",
            "strudel_get_cursor",
            "strudel_set_cursor",
            "strudel_play",
            "strudel_stop"
        ],
        "includes": []
    },
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Patch the active Hermes installation with hermelinChat artifact tools.",
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


def _abs_no_resolve(path: Path, *, base: Path | None = None) -> Path:
    p = path.expanduser()
    if p.is_absolute():
        return p
    return ((base or Path.cwd()) / p).absolute()


def _python_from_shebang(shebang: list[str], script_path: Path) -> Path | None:
    if not shebang:
        return None

    command = shebang[0]
    args = shebang[1:]
    if Path(command).name == "env":
        if not args:
            return None
        # Skip common env options (e.g. /usr/bin/env -S python3 -I).
        while args and args[0].startswith("-"):
            if args[0] == "-S":
                args = shlex.split(" ".join(args[1:]))
                break
            args = args[1:]
        if not args:
            return None
        resolved = shutil.which(args[0])
        if not resolved:
            raise RuntimeError(f"Could not resolve interpreter from shebang: {args[0]}")
        command = resolved

    name = Path(command).name
    if name == "python" or name.startswith("python3"):
        python_path = _abs_no_resolve(Path(command), base=script_path.parent)
        if not python_path.is_file():
            raise FileNotFoundError(f"Hermes Python not found: {python_path}")
        return python_path

    return None


def _shebang_command_name(shebang: list[str]) -> str:
    if not shebang:
        return ""
    if Path(shebang[0]).name != "env":
        return Path(shebang[0]).name

    args = shebang[1:]
    while args and args[0].startswith("-"):
        if args[0] == "-S":
            args = shlex.split(" ".join(args[1:]))
            break
        args = args[1:]
    if not args:
        return Path(shebang[0]).name
    return Path(args[0]).name


def _exec_target_from_shell_launcher(script_path: Path, text: str) -> Path | None:
    for raw_line in text.splitlines()[1:]:
        line = raw_line.strip()
        if not line or line.startswith("#") or not line.startswith("exec "):
            continue
        try:
            parts = shlex.split(line)
        except ValueError:
            continue
        if len(parts) < 2:
            continue
        target = parts[1]
        if "$" in target:
            continue
        candidate = _abs_no_resolve(Path(target), base=script_path.parent)
        if candidate.is_file():
            return candidate
    return None


def _detect_hermes_python(hermes_exe: Path, explicit: str) -> Path:
    """Resolve the Python interpreter used by the Hermes installation.

    IMPORTANT: do NOT call .resolve() on the interpreter path.

    In many venvs `venv/bin/python3` is a symlink to a base interpreter.
    Python detects the venv via pyvenv.cfg relative to argv[0]; resolving
    the symlink can bypass the venv and make installed Hermes modules
    disappear (e.g. model_tools not importable).
    """

    if explicit:
        python_path = _abs_no_resolve(Path(explicit))
        if not python_path.is_file():
            raise FileNotFoundError(f"Hermes Python not found: {python_path}")
        return python_path

    current = hermes_exe
    visited: set[Path] = set()
    for _ in range(5):
        if current in visited:
            raise RuntimeError(f"Hermes launcher chain contains a cycle at {current}")
        visited.add(current)

        try:
            text = current.read_text(encoding="utf-8")
            first_line = text.splitlines()[0].strip()
        except Exception as exc:
            raise RuntimeError(f"Could not read shebang from {current}: {exc}") from exc

        if not first_line.startswith("#!"):
            raise RuntimeError(f"Unexpected Hermes launcher format: {current}")

        try:
            shebang = shlex.split(first_line[2:].strip())
        except ValueError as exc:
            raise RuntimeError(f"Could not parse shebang from {current}: {exc}") from exc
        if not shebang:
            raise RuntimeError(f"Could not parse shebang from {current}")

        python_path = _python_from_shebang(shebang, current)
        if python_path is not None:
            return python_path

        if _shebang_command_name(shebang) in {"sh", "bash", "dash", "zsh"}:
            next_launcher = _exec_target_from_shell_launcher(current, text)
            if next_launcher is not None:
                current = next_launcher
                continue

        raise RuntimeError(
            f"Hermes launcher {current} uses non-Python interpreter {shebang[0]!r}. "
            "Pass --hermes-python explicitly, or use a launcher that execs the Hermes Python entry point."
        )

    raise RuntimeError(f"Hermes launcher chain is too deep starting at {hermes_exe}")


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

    # Hermes >= v0.10 (approx) uses discover_builtin_tools() which auto-discovers
    # tools by scanning tools/*.py for registry.register() calls.  In that case
    # there is no hardcoded import list to patch — installing artifact_tool.py
    # into the tools/ directory is sufficient and no model_tools.py edit is needed.
    if "discover_builtin_tools()" in text:
        return False, "model_tools.py uses auto-discovery (discover_builtin_tools); no patch needed"

    # Upgrade path: previous versions imported tools.render_panel_tool.
    if '"tools.render_panel_tool"' in text:
        patched = text.replace('"tools.render_panel_tool"', '"tools.artifact_tool"')
        _write_text_with_newline(path, patched, newline)
        return True, "Updated model_tools.py: tools.render_panel_tool -> tools.artifact_tool"

    anchor = '        "tools.homeassistant_tool",'
    if anchor not in text:
        raise RuntimeError(
            f"Could not find insertion anchor in {path}. "
            "This Hermes version may use auto-discovery (discover_builtin_tools) "
            "instead of a hardcoded tool list. If so, no model_tools.py patch is "
            "needed — installing artifact_tool.py into the tools/ directory is sufficient."
        )

    patched = text.replace(anchor, anchor + newline + '        "tools.artifact_tool",', 1)
    _write_text_with_newline(path, patched, newline)
    return True, f"Patched {path.name}"


def _patch_toolsets(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    anchor = newline + newline + '    # Scenario-specific toolsets' + newline
    if anchor not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}")

    marker_line = "    # hermelinChat artifact panel toolsets (installed by hermelinChat patch)"
    block = ARTIFACT_TOOLSETS_BLOCK.replace("\n", newline)
    desired = newline + block + anchor

    # If already in the desired state, do nothing.
    if desired in text:
        return False, "toolsets.py already patched with hermelinChat artifacts toolset"

    # Upgrade path: if an older patch block exists, remove it first, then re-insert
    # the canonical artifacts toolset block.
    if marker_line in text:
        start_token = newline + newline + marker_line
        if start_token in text:
            start = text.index(start_token)
        else:
            alt = newline + marker_line
            if alt in text:
                start = text.index(alt)
            else:
                start = text.index(marker_line)

        end = text.index(anchor, start)
        text = text[:start] + text[end:]

    patched = text.replace(anchor, desired, 1)
    if patched == text:
        return False, "toolsets.py already contains an artifacts toolset patch"

    _write_text_with_newline(path, patched, newline)
    return True, f"Patched {path.name}: added artifacts toolset"


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

        if "Artifact side-panel tools for hermelinChat" in legacy_text:
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
    print("  1) restart hermelinChat / Hermes services if they are already running")
    print("  2) if your Hermes config uses restricted toolsets, enable 'artifacts' for the panel")
    print("  3) add 'strudel' only if you want Strudel-specific agent controls")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
