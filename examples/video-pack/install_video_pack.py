#!/usr/bin/env python3
from __future__ import annotations

"""install_video_pack.py — Install hermelinChat's video demo pack into a Hermes HOME.

This installer is intentionally *Hermes-home only*:
- DOES copy demo runner projects into $HERMES_HOME/artifacts/runners/projects/
- DOES set agent.system_prompt in $HERMES_HOME/config.yaml (Hans video director)
- DOES NOT patch Hermes code or install artifact tools (do that separately)

Typical usage on the video machine:
  cd /path/to/hermelinChat
  ./.venv/bin/python examples/video-pack/install_video_pack.py --env-file .hermelin.env --force

Then restart hermelinChat.

Uninstall (restore previous config):
  ./.venv/bin/python examples/video-pack/uninstall_video_pack.py --env-file .hermelin.env
"""

import argparse
import os
import re
import shutil
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
VIDEO_PACK_DIR = SCRIPT_DIR
VIDEO_PROJECTS_DIR = VIDEO_PACK_DIR / "projects"

BACKUP_NAME = "config.yaml.video-pack.bak"


HANS_DIRECTOR_PROMPT = """You are HANS.

Tone:
- cyberpunk, terse, confident
- no exposition, no long explanations
- don’t ask questions unless the operator asks first

You are driving a video demo inside hermelinChat.

When the operator sends one of these codewords (case-insensitive):
  GPU / BUILDER / STRUDEL / MONEY

You MUST do, in this order:
1) Run a short ‘diagnostic sweep’ using the terminal tool (a few fast echo/sleep lines).
2) Start (or restart) the corresponding runner with start_runner(tab_id=..., command=..., restart=True).
3) Create an iframe artifact for that tab_id pointing at the runner’s localhost URL.
4) Focus the artifact tab.
5) Reply with ONE line describing what’s on screen.

Runner mapping (tab_id -> command -> iframe src):
- gpu     -> python3 runner.py  -> http://127.0.0.1:43111/
- builder -> python3 runner.py  -> http://127.0.0.1:43112/
- strudel -> python3 runner.py  -> http://127.0.0.1:43113/
- money   -> python3 runner.py  -> http://127.0.0.1:43114/

Keep tool calls snappy. Keep chat replies short."""


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"env file not found: {path}")

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip()
        if not k:
            continue
        if (v.startswith("\"") and v.endswith("\"")) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        out[k] = v

    return out


def _default_hermes_home() -> Path:
    home = os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))
    return Path(home).expanduser()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Install hermelinChat video pack into a Hermes HOME")
    p.add_argument(
        "--env-file",
        default=str(REPO_ROOT / ".hermelin.env"),
        help="Path to .hermelin.env (default: ./ .hermelin.env)",
    )
    p.add_argument(
        "--hermes-home",
        default="",
        help="Override Hermes home directory (otherwise uses HERMES_HOME from env-file, then $HERMES_HOME, then ~/.hermes)",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing installed templates",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without modifying files",
    )
    return p.parse_args()


def _read_text_with_newline(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text, newline


def _write_text_with_newline(path: Path, text: str, newline: str) -> None:
    with path.open("w", encoding="utf-8", newline=newline) as handle:
        handle.write(text)


def _apply_agent_system_prompt(yaml_text: str, prompt: str) -> tuple[str, bool]:
    """Best-effort YAML text patch (no PyYAML dependency).

    Ensures a top-level `agent:` mapping contains `system_prompt: |`.
    Replaces any existing `agent.system_prompt` block.
    """

    lines = yaml_text.splitlines()

    def is_top_level_key(line: str) -> bool:
        if not line or line.startswith(" ") or line.startswith("\t"):
            return False
        if line.lstrip().startswith("#"):
            return False
        return bool(re.match(r"^[A-Za-z0-9_][A-Za-z0-9_-]*\s*:", line))

    agent_idx = None
    for i, line in enumerate(lines):
        if re.match(r"^agent\s*:\s*(#.*)?$", line):
            agent_idx = i
            break

    prompt_lines = prompt.splitlines()

    def build_block(child_indent: str) -> list[str]:
        value_indent = child_indent + "  "
        block: list[str] = []
        block.append(f"{child_indent}# hermelinChat video-pack (installed by examples/video-pack/install_video_pack.py)")
        block.append(f"{child_indent}system_prompt: |")
        if not prompt_lines:
            block.append(f"{value_indent}")
        else:
            for pl in prompt_lines:
                block.append(f"{value_indent}{pl}")
        return block

    # If there's no agent block, append one.
    if agent_idx is None:
        child_indent = "  "
        block = ["agent:"] + build_block(child_indent)
        if lines and lines[-1].strip() != "":
            lines.append("")
        lines.extend(block)
        return "\n".join(lines) + "\n", True

    # Determine end of the agent block (next top-level key).
    end_idx = len(lines)
    for j in range(agent_idx + 1, len(lines)):
        if is_top_level_key(lines[j]):
            end_idx = j
            break

    # Infer child indent from first non-empty, non-comment line inside agent block.
    child_indent = "  "
    for j in range(agent_idx + 1, end_idx):
        raw = lines[j]
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = re.match(r"^(\s+)", raw)
        if m:
            child_indent = m.group(1)
        break

    # Find existing system_prompt in agent block.
    sp_idx = None
    for j in range(agent_idx + 1, end_idx):
        if re.match(rf"^{re.escape(child_indent)}system_prompt\s*:", lines[j]):
            sp_idx = j
            break

    insert_at = agent_idx + 1
    changed = False

    if sp_idx is not None:
        # Remove existing system_prompt (handle block scalars).
        remove_end = sp_idx + 1
        if re.match(rf"^{re.escape(child_indent)}system_prompt\s*:\s*[|>].*$", lines[sp_idx]):
            while remove_end < end_idx:
                nxt = lines[remove_end]
                if not nxt.strip():
                    remove_end += 1
                    continue
                indent_len = len(nxt) - len(nxt.lstrip(" "))
                if indent_len > len(child_indent):
                    remove_end += 1
                    continue
                break
        del lines[sp_idx:remove_end]
        end_idx -= (remove_end - sp_idx)
        insert_at = sp_idx
        changed = True

    # If already installed and identical, do nothing.
    # (We do a best-effort textual check for our marker comment.)
    marker = f"{child_indent}# hermelinChat video-pack (installed by examples/video-pack/install_video_pack.py)"
    if not changed:
        window = "\n".join(lines[agent_idx + 1 : min(end_idx, agent_idx + 25)])
        if marker in window and "system_prompt:" in window:
            # It's already installed; still ensure prompt text matches exactly.
            # We just replace it unconditionally below, but doing so requires removal logic.
            pass

    # Insert our new block.
    block = build_block(child_indent)
    lines[insert_at:insert_at] = block + [""]
    return "\n".join(lines) + "\n", True


def main() -> int:
    args = parse_args()

    env_path = Path(str(args.env_file)).expanduser()
    env = {}
    try:
        env = _parse_env_file(env_path)
    except FileNotFoundError:
        # Allow running without an env file if --hermes-home is provided.
        env = {}

    hermes_home_raw = str(args.hermes_home or env.get("HERMES_HOME") or os.getenv("HERMES_HOME") or _default_hermes_home())
    hermes_home = Path(hermes_home_raw).expanduser()

    if not VIDEO_PROJECTS_DIR.is_dir():
        print(f"ERROR: bundled video projects not found: {VIDEO_PROJECTS_DIR}", file=sys.stderr)
        return 2

    expected = {"gpu", "builder", "strudel", "money"}
    available = {p.name for p in VIDEO_PROJECTS_DIR.iterdir() if p.is_dir()}
    missing = sorted(expected - available)
    if missing:
        print(f"ERROR: missing bundled project(s): {', '.join(missing)}", file=sys.stderr)
        print(f"Found: {', '.join(sorted(available))}", file=sys.stderr)
        return 2

    dst_projects_root = hermes_home / "artifacts" / "runners" / "projects"
    config_path = hermes_home / "config.yaml"
    backup_path = hermes_home / BACKUP_NAME

    print("hermelinChat video pack install target")
    print(f"  env_file:     {env_path}")
    print(f"  hermes_home:  {hermes_home}")
    print(f"  dst_projects: {dst_projects_root}")
    print(f"  config:       {config_path}")
    print(f"  backup:       {backup_path}")
    print()

    # 1) Copy demo projects.
    for name in sorted(expected):
        src = VIDEO_PROJECTS_DIR / name
        dst = dst_projects_root / name

        if dst.exists() and not args.force:
            print(f"= templates: {name}: exists (use --force to overwrite): {dst}")
            continue

        if args.dry_run:
            print(f"+ templates: {name}: would install -> {dst}")
            continue

        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
            print(f"+ templates: {name}: installed -> {dst}")
        except Exception as exc:
            print(f"ERROR: failed to install templates for {name}: {exc}", file=sys.stderr)
            return 2

    # 2) Backup + patch config.yaml.
    if args.dry_run:
        print(f"+ config: would set agent.system_prompt in {config_path}")
        return 0

    try:
        hermes_home.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print(f"ERROR: failed to create hermes_home dir {hermes_home}: {exc}", file=sys.stderr)
        return 2

    if config_path.exists() and not backup_path.exists():
        try:
            shutil.copy2(config_path, backup_path)
            print(f"+ config: backup created -> {backup_path}")
        except Exception as exc:
            print(f"ERROR: failed to create config backup: {exc}", file=sys.stderr)
            return 2
    elif config_path.exists() and backup_path.exists():
        print(f"= config: backup already exists -> {backup_path}")

    try:
        if config_path.exists():
            text, newline = _read_text_with_newline(config_path)
        else:
            text, newline = "", "\n"

        new_text, changed = _apply_agent_system_prompt(text, HANS_DIRECTOR_PROMPT)
        if not changed:
            print("= config: already up to date")
        else:
            _write_text_with_newline(config_path, new_text, newline)
            print(f"+ config: updated -> {config_path}")
    except Exception as exc:
        print(f"ERROR: failed to update config.yaml: {exc}", file=sys.stderr)
        return 2

    print("\nDone. Restart hermelinChat to pick up the new Hermes HOME config.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
