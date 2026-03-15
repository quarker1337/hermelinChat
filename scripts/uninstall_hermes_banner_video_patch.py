#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


PATCH_START = "    # hermilinChat banner video patch (installed by hermilinChat patch)"
PATCH_END = "    # end hermilinChat banner video patch"

# When unpatching Hermes' project-root cli.py we need a non-indented marker.
CLI_PATCH_START = "# hermilinChat banner video patch (installed by hermilinChat patch)"
CLI_PATCH_END = "# end hermilinChat banner video patch"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Undo the hermilinChat banner video patch from the active Hermes installation.",
    )
    p.add_argument(
        "--hermes-exe",
        default="hermes",
        help="Hermes executable to inspect (default: hermes from PATH)",
    )
    p.add_argument(
        "--hermes-python",
        default="",
        help="Override the Python interpreter used by the Hermes installation.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without modifying files.",
    )
    return p.parse_args()


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


banner = _origin("hermes_cli.banner")

print(json.dumps({
    "banner": banner,
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
            "Could not locate hermes_cli.banner from the active installation. "
            "If Hermes is installed in a custom location, pass --hermes-python explicitly. "
            f"Stderr: {stderr or '<none>'}"
        )

    data = json.loads(result.stdout.strip())
    paths = {key: Path(value) for key, value in data.items()}
    for key, path in paths.items():
        if not path.exists():
            raise FileNotFoundError(f"Resolved Hermes path for {key} does not exist: {path}")

    # Hermes v0.2.0 renders the banner through project-root cli.py. Derive it
    # from hermes_cli/banner.py without requiring it to exist for every layout.
    try:
        banner_path = paths.get("banner")
        if banner_path:
            paths["cli"] = banner_path.resolve().parent.parent / "cli.py"
    except Exception:
        pass

    return paths


def _read_text_with_newline(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text, newline


def _write_text_with_newline(path: Path, text: str, newline: str) -> None:
    with path.open("w", encoding="utf-8", newline=newline) as handle:
        handle.write(text)


def _remove_patch_blocks(
    text: str,
    newline: str,
    start_marker: str = PATCH_START,
    end_marker: str = PATCH_END,
) -> tuple[str, int]:
    removed = 0

    while True:
        start = text.find(start_marker)
        if start == -1:
            break

        end = text.find(end_marker, start)
        if end == -1:
            raise RuntimeError(f"Found {start_marker!r} but not {end_marker!r}")

        # Remove through the end of the PATCH_END line
        line_end = text.find(newline, end)
        if line_end == -1:
            line_end = len(text)
        else:
            line_end += len(newline)

        text = text[:start] + text[line_end:]
        removed += 1

    return text, removed


def _unpatch_banner(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    if PATCH_START not in text:
        return False, f"{path.name} not patched"

    patched, removed = _remove_patch_blocks(text, newline)
    if removed == 0:
        return False, f"{path.name} not patched"

    _write_text_with_newline(path, patched, newline)
    return True, f"Removed {removed} patch block(s) from {path.name}"


def _unpatch_cli(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    removed_total = 0
    if CLI_PATCH_START in text:
        text, r = _remove_patch_blocks(text, newline, CLI_PATCH_START, CLI_PATCH_END)
        removed_total += r
    if PATCH_START in text:
        text, r = _remove_patch_blocks(text, newline, PATCH_START, PATCH_END)
        removed_total += r

    if removed_total == 0:
        return False, f"{path.name} not patched"

    _write_text_with_newline(path, text, newline)
    return True, f"Removed {removed_total} patch block(s) from {path.name}"


def main() -> int:
    args = parse_args()

    try:
        hermes_exe = _resolve_hermes_exe(args.hermes_exe)
        hermes_python = _detect_hermes_python(hermes_exe, args.hermes_python)
        live_paths = _discover_live_paths(hermes_python)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Hermes banner video unpatch target")
    print(f"  hermes exe:    {hermes_exe}")
    print(f"  hermes python: {hermes_python}")
    print(f"  banner:        {live_paths['banner']}")
    if live_paths.get("cli"):
        print(f"  cli:           {live_paths['cli']}")

    if args.dry_run:
        print("\nDry run only. No files changed.")
        return 0

    try:
        changed_banner, message_banner = _unpatch_banner(live_paths["banner"])
        changed_cli = False
        message_cli = "cli.py not found (skipped)"
        cli_path = live_paths.get("cli")
        if cli_path and cli_path.exists():
            changed_cli, message_cli = _unpatch_cli(cli_path)
    except Exception as exc:
        print(f"ERROR: failed to unpatch Hermes installation: {exc}", file=sys.stderr)
        return 1

    print()
    print(("UPDATED" if changed_banner else "OK") + f": {message_banner}")
    if live_paths.get("cli"):
        print(("UPDATED" if changed_cli else "OK") + f": {message_cli}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
