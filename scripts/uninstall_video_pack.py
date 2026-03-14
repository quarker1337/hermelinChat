#!/usr/bin/env python3
from __future__ import annotations

"""uninstall_video_pack.py — Revert hermilinChat video pack changes in a Hermes HOME.

What it does:
- Restores $HERMES_HOME/config.yaml from config.yaml.video-pack.bak (if present)
- Optionally removes installed demo templates under:
    $HERMES_HOME/artifacts/runners/projects/{gpu,builder,strudel,money}/

Usage:
  cd /path/to/hermilinChat
  ./.venv/bin/python scripts/uninstall_video_pack.py --env-file .hermelin.env
"""

import argparse
import os
import shutil
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent

BACKUP_NAME = "config.yaml.video-pack.bak"
PROJECTS = ["gpu", "builder", "strudel", "money"]


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
    p = argparse.ArgumentParser(description="Uninstall hermilinChat video pack from a Hermes HOME")
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
        "--remove-templates",
        action="store_true",
        help="Remove installed demo templates under artifacts/runners/projects/",
    )
    p.add_argument(
        "--keep-backup",
        action="store_true",
        help="Do not delete the backup file after restoring",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without modifying files",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    env_path = Path(str(args.env_file)).expanduser()
    env = {}
    try:
        env = _parse_env_file(env_path)
    except FileNotFoundError:
        env = {}

    hermes_home_raw = str(args.hermes_home or env.get("HERMES_HOME") or os.getenv("HERMES_HOME") or _default_hermes_home())
    hermes_home = Path(hermes_home_raw).expanduser()

    config_path = hermes_home / "config.yaml"
    backup_path = hermes_home / BACKUP_NAME

    dst_projects_root = hermes_home / "artifacts" / "runners" / "projects"

    print("hermilinChat video pack uninstall target")
    print(f"  env_file:     {env_path}")
    print(f"  hermes_home:  {hermes_home}")
    print(f"  config:       {config_path}")
    print(f"  backup:       {backup_path}")
    print(f"  templates:    {dst_projects_root}")
    print()

    if not backup_path.exists() or not backup_path.is_file():
        print(f"ERROR: backup not found: {backup_path}", file=sys.stderr)
        print("Nothing to restore. If you deleted the backup, reinstall the video pack to recreate it.", file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"+ would restore {config_path} from {backup_path}")
        if args.remove_templates:
            for name in PROJECTS:
                print(f"+ would remove templates: {dst_projects_root / name}")
        return 0

    try:
        hermes_home.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_path, config_path)
        print(f"+ config: restored -> {config_path}")
    except Exception as exc:
        print(f"ERROR: failed to restore config: {exc}", file=sys.stderr)
        return 2

    if not args.keep_backup:
        try:
            backup_path.unlink(missing_ok=True)
            print(f"+ config: removed backup -> {backup_path}")
        except Exception as exc:
            print(f"WARNING: failed to remove backup: {exc}", file=sys.stderr)

    if args.remove_templates:
        for name in PROJECTS:
            p = dst_projects_root / name
            if not p.exists():
                print(f"= templates: {name}: not present")
                continue
            try:
                shutil.rmtree(p)
                print(f"+ templates: {name}: removed")
            except Exception as exc:
                print(f"WARNING: failed to remove templates for {name}: {exc}", file=sys.stderr)

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
