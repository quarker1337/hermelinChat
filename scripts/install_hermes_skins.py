#!/usr/bin/env python3
"""install_hermes_skins.py — Install hermelinChat skins into Hermes Agent (upstream skin system).

Hermes Agent supports data-driven CLI skins natively.
Custom skins are loaded from:
  ~/.hermes/skins/<name>.yaml

This script copies hermelinChat's bundled skins (repo: ./skins/*.yaml) into the
active Hermes home directory.

Usage:
  python3 scripts/install_hermes_skins.py --auto
  python3 scripts/install_hermes_skins.py --auto --force
  python3 scripts/install_hermes_skins.py hermelin matrix

Notes:
- This does NOT patch Hermes' code.
- Activate a skin with:
    /skin <name>
  Or set it for startup in ~/.hermes/config.yaml:
    display:
      skin: <name>
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
SRC_DIR = REPO_ROOT / "skins"


def _default_hermes_home() -> Path:
    home = os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))
    return Path(home).expanduser()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Install hermelinChat CLI skins into Hermes Agent")
    p.add_argument(
        "--hermes-home",
        default=str(_default_hermes_home()),
        help="Hermes home directory (default: $HERMES_HOME or ~/.hermes)",
    )
    p.add_argument(
        "--auto",
        action="store_true",
        help="Install all bundled skins (default if no skin names are provided)",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite destination files even if they differ",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without copying files",
    )
    p.add_argument(
        "skins",
        nargs="*",
        help="Optional list of skin names to install (e.g. hermelin matrix)",
    )
    return p.parse_args()


def _list_bundled_skins() -> list[str]:
    if not SRC_DIR.is_dir():
        return []
    out: list[str] = []
    for p in sorted(SRC_DIR.glob("*.yaml")):
        out.append(p.stem)
    return out


def main() -> int:
    args = parse_args()

    if not SRC_DIR.is_dir():
        print(f"ERROR: bundled skins directory not found: {SRC_DIR}", file=sys.stderr)
        return 2

    hermes_home = Path(str(args.hermes_home)).expanduser()
    dst_dir = hermes_home / "skins"

    bundled = _list_bundled_skins()
    if not bundled:
        print(f"ERROR: no skins found in {SRC_DIR}", file=sys.stderr)
        return 2

    selected = [s.strip() for s in (args.skins or []) if str(s).strip()]
    if not selected:
        selected = bundled
    elif args.auto:
        # If user explicitly passed names, keep them; --auto is redundant.
        pass

    missing = [s for s in selected if s not in bundled]
    if missing:
        print(f"ERROR: unknown skin(s): {', '.join(missing)}", file=sys.stderr)
        print(f"Bundled skins: {', '.join(bundled)}", file=sys.stderr)
        return 2

    print("Hermes skin install target")
    print(f"  hermes_home: {hermes_home}")
    print(f"  src_dir:     {SRC_DIR}")
    print(f"  dst_dir:     {dst_dir}")
    print(f"  skins:       {', '.join(selected)}")
    print()

    changes = 0
    for name in selected:
        src = SRC_DIR / f"{name}.yaml"
        dst = dst_dir / f"{name}.yaml"

        try:
            src_text = src.read_text(encoding="utf-8")
        except Exception as e:
            print(f"ERROR: failed to read {src}: {e}", file=sys.stderr)
            return 2

        if dst.exists():
            try:
                dst_text = dst.read_text(encoding="utf-8")
            except Exception:
                dst_text = None

            if dst_text == src_text:
                print(f"= {name}: already up to date")
                continue

            if not args.force:
                print(f"! {name}: differs (use --force to overwrite): {dst}")
                continue

        changes += 1
        if args.dry_run:
            print(f"+ {name}: would write {dst}")
            continue

        try:
            dst_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"+ {name}: installed -> {dst}")
        except Exception as e:
            print(f"ERROR: failed to install {name}: {e}", file=sys.stderr)
            return 2

    if args.dry_run:
        print("\nDry run only. No files changed.")
    else:
        if changes == 0:
            print("\nAll skins already installed.")
        else:
            print(f"\nDone. Installed/updated {changes} skin(s).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
