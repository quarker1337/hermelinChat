#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ASSET_DIR = SCRIPT_DIR / "hermes_banner_video_patch"
SAMPLE_FAKE_JSON = ASSET_DIR / "banner_fake.json"

PATCH_START = "    # hermilinChat banner video patch (installed by hermilinChat patch)"
PATCH_END = "    # end hermilinChat banner video patch"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Patch the active Hermes installation's startup banner for hermilinChat video takes. "
            "Adds env-var toggles to hide model/cwd/session under the caduceus and optionally "
            "display a fake tools/skills list."
        )
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


def _discover_live_paths(hermes_python: Path) -> dict[str, Path]:
    """Locate the Hermes source files we need to patch."""

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


def _patch_banner(path: Path) -> tuple[bool, str]:
    text, newline = _read_text_with_newline(path)

    if PATCH_START in text:
        return False, f"{path.name} already patched"

    helper_block = (
        "{PATCH_START}\n"
        "    def _hermilin_banner_flag(key: str) -> bool:\n"
        "        v = os.getenv(key, \"\").strip().lower()\n"
        "        return v in (\"1\", \"true\", \"yes\", \"on\")\n"
        "\n"
        "    _hermilin_fake_cfg = None\n"
        "    _hermilin_fake_file = os.getenv(\"HERMES_BANNER_FAKE_FILE\", \"\").strip()\n"
        "    if _hermilin_fake_file:\n"
        "        try:\n"
        "            _p = Path(_hermilin_fake_file).expanduser()\n"
        "            if not _p.is_absolute():\n"
        "                _home = Path(os.getenv(\"HERMES_HOME\", Path.home() / \".hermes\"))\n"
        "                _p = _home / _p\n"
        "            if _p.exists():\n"
        "                _hermilin_fake_cfg = json.loads(_p.read_text(encoding=\"utf-8\"))\n"
        "                if not isinstance(_hermilin_fake_cfg, dict):\n"
        "                    _hermilin_fake_cfg = None\n"
        "        except Exception:\n"
        "            _hermilin_fake_cfg = None\n"
        "{PATCH_END}\n\n"
    ).replace("{PATCH_START}", PATCH_START).replace("{PATCH_END}", PATCH_END).replace("\n", newline)

    hide_block = (
        "{PATCH_START}\n"
        "    if _hermilin_banner_flag(\"HERMES_BANNER_HIDE_MODEL\"):\n"
        "        _line = f\"[{accent}]{model_short}[/]{ctx_str} [dim {dim}]·[/] [dim {dim}]Nous Research[/]\"\n"
        "        try:\n"
        "            left_lines.remove(_line)\n"
        "        except ValueError:\n"
        "            pass\n"
        "    if _hermilin_banner_flag(\"HERMES_BANNER_HIDE_CWD\"):\n"
        "        _line = f\"[dim {dim}]{cwd}[/]\"\n"
        "        try:\n"
        "            left_lines.remove(_line)\n"
        "        except ValueError:\n"
        "            pass\n"
        "    if session_id and _hermilin_banner_flag(\"HERMES_BANNER_HIDE_SESSION\"):\n"
        "        _line = f\"[dim {session_color}]Session: {session_id}[/]\"\n"
        "        try:\n"
        "            left_lines.remove(_line)\n"
        "        except ValueError:\n"
        "            pass\n"
        "{PATCH_END}\n\n"
    ).replace("{PATCH_START}", PATCH_START).replace("{PATCH_END}", PATCH_END).replace("\n", newline)

    # NOTE: this patch is inserted *before* the real tools/skills list, and
    # returns early if HERMES_BANNER_FAKE_FILE loads successfully.
    fake_block = (
        "{PATCH_START}\n"
        "    if _hermilin_fake_cfg:\n"
        "        right_lines = [f\"[bold {accent}]Available Tools[/]\"]\n\n"
        "        toolsets_dict = _hermilin_fake_cfg.get(\"toolsets\", {})\n"
        "        if not isinstance(toolsets_dict, dict):\n"
        "            toolsets_dict = {}\n\n"
        "        sorted_toolsets = sorted(toolsets_dict.keys())\n"
        "        display_toolsets = sorted_toolsets[:8]\n"
        "        remaining_toolsets = len(sorted_toolsets) - 8\n\n"
        "        for toolset in display_toolsets:\n"
        "            tool_names = toolsets_dict.get(toolset) or []\n"
        "            if not isinstance(tool_names, list):\n"
        "                continue\n"
        "            tool_names = [str(n) for n in tool_names]\n\n"
        "            colored_names = [f\"[{text}]{n}[/]\" for n in tool_names]\n"
        "            tools_str = ', '.join(colored_names)\n\n"
        "            if len(', '.join(tool_names)) > 45:\n"
        "                short_names = []\n"
        "                length = 0\n"
        "                for name in tool_names:\n"
        "                    if length + len(name) + 2 > 42:\n"
        "                        short_names.append(\"...\")\n"
        "                        break\n"
        "                    short_names.append(name)\n"
        "                    length += len(name) + 2\n"
        "                colored_names = []\n"
        "                for name in short_names:\n"
        "                    if name == \"...\":\n"
        "                        colored_names.append(\"[dim]...[/]\")\n"
        "                    else:\n"
        "                        colored_names.append(f\"[{text}]{name}[/]\")\n"
        "                tools_str = ', '.join(colored_names)\n\n"
        "            right_lines.append(f\"[dim {dim}]{toolset}:[/] {tools_str}\")\n\n"
        "        if remaining_toolsets > 0:\n"
        "            right_lines.append(f\"[dim {dim}](and {remaining_toolsets} more toolsets...)[/]\")\n\n"
        "        right_lines.append('')\n"
        "        right_lines.append(f\"[bold {accent}]Available Skills[/]\")\n\n"
        "        skills_by_category = _hermilin_fake_cfg.get(\"skills\", {})\n"
        "        if not isinstance(skills_by_category, dict):\n"
        "            skills_by_category = {}\n\n"
        "        total_skills = 0\n"
        "        if skills_by_category:\n"
        "            for category in sorted(skills_by_category.keys()):\n"
        "                skill_names = skills_by_category.get(category) or []\n"
        "                if not isinstance(skill_names, list):\n"
        "                    continue\n"
        "                skill_names = [str(n) for n in skill_names]\n"
        "                total_skills += len(skill_names)\n\n"
        "                if len(skill_names) > 8:\n"
        "                    display_names = skill_names[:8]\n"
        "                    skills_str = ', '.join(display_names) + f\" +{len(skill_names) - 8} more\"\n"
        "                else:\n"
        "                    skills_str = ', '.join(skill_names)\n\n"
        "                if len(skills_str) > 50:\n"
        "                    skills_str = skills_str[:47] + '...'\n"
        "                right_lines.append(f\"[dim {dim}]{category}:[/] [{text}]{skills_str}[/]\")\n"
        "        else:\n"
        "            right_lines.append(f\"[dim {dim}]No skills installed[/]\")\n\n"
        "        right_lines.append('')\n"
        "        summary = str(_hermilin_fake_cfg.get(\"summary\", \"\")).strip()\n"
        "        if summary:\n"
        "            right_lines.append(f\"[dim {dim}]{summary}[/]\")\n"
        "        else:\n"
        "            total_tools = 0\n"
        "            for _k, _v in toolsets_dict.items():\n"
        "                if isinstance(_v, list):\n"
        "                    total_tools += len(_v)\n"
        "            right_lines.append(f\"[dim {dim}]{total_tools} tools · {total_skills} skills · /help for commands[/]\")\n\n"
        "        right_content = '\\n'.join(right_lines)\n"
        "        layout_table.add_row(left_content, right_content)\n\n"
        "        agent_name = _skin_branding(\"agent_name\", \"Hermes Agent\")\n"
        "        title_color = _skin_color(\"banner_title\", \"#FFD700\")\n"
        "        border_color = _skin_color(\"banner_border\", \"#CD7F32\")\n"
        "        outer_panel = Panel(\n"
        "            layout_table,\n"
        "            title=f\"[bold {title_color}]{agent_name} v{VERSION} ({RELEASE_DATE})[/]\",\n"
        "            border_style=border_color,\n"
        "            padding=(0, 2),\n"
        "        )\n\n"
        "        console.print()\n"
        "        console.print(HERMES_AGENT_LOGO)\n"
        "        console.print()\n"
        "        console.print(outer_panel)\n"
        "        return\n"
        "{PATCH_END}\n\n"
    ).replace("{PATCH_START}", PATCH_START).replace("{PATCH_END}", PATCH_END).replace("\n", newline)

    anchor1 = '    session_color = _skin_color("session_border", "#8B8682")' + newline
    if anchor1 not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}: session_color")
    text = text.replace(anchor1, anchor1 + helper_block, 1)

    anchor2 = '    left_content = "\\n".join(left_lines)' + newline
    if anchor2 not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}: left_content")
    text = text.replace(anchor2, hide_block + anchor2, 1)

    anchor3 = '    right_lines = [f"[bold {accent}]Available Tools[/]"]' + newline
    if anchor3 not in text:
        raise RuntimeError(f"Could not find insertion anchor in {path}: right_lines")
    text = text.replace(anchor3, fake_block + anchor3, 1)

    _write_text_with_newline(path, text, newline)
    return True, f"Patched {path.name}"


def main() -> int:
    args = parse_args()

    try:
        hermes_exe = _resolve_hermes_exe(args.hermes_exe)
        hermes_python = _detect_hermes_python(hermes_exe, args.hermes_python)
        live_paths = _discover_live_paths(hermes_python)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("Hermes banner video patch target")
    print(f"  hermes exe:    {hermes_exe}")
    print(f"  hermes python: {hermes_python}")
    print(f"  banner:        {live_paths['banner']}")
    print(f"  sample fake:   {SAMPLE_FAKE_JSON}")

    if not SAMPLE_FAKE_JSON.exists():
        print(f"WARNING: sample fake JSON not found: {SAMPLE_FAKE_JSON}", file=sys.stderr)

    if args.dry_run:
        print("\nDry run only. No files changed.")
        return 0

    try:
        changed, message = _patch_banner(live_paths["banner"])
    except Exception as exc:
        print(f"ERROR: failed to patch Hermes installation: {exc}", file=sys.stderr)
        return 1

    print()
    print(("UPDATED" if changed else "OK") + f": {message}")

    print("\nNext steps (video machine)")
    print("  1) Copy the sample JSON and edit to taste:")
    print(f"       cp '{SAMPLE_FAKE_JSON}' ~/.hermes/banner_fake.json")
    print("  2) Set env vars (export or in ~/.hermes/.env):")
    print("       HERMES_BANNER_HIDE_MODEL=1")
    print("       HERMES_BANNER_HIDE_CWD=1")
    print("       HERMES_BANNER_HIDE_SESSION=1")
    print("       HERMES_BANNER_FAKE_FILE=~/.hermes/banner_fake.json")
    print("  3) Restart Hermes/hermilinChat and record.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
