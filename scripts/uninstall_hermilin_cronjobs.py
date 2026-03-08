#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

JOB_NAMES = {"hermilin-autotitle", "hermilin-whispers"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Remove hermilinChat-installed Hermes cron jobs from $HERMES_HOME/cron/jobs.json")
    p.add_argument(
        "--hermes-home",
        default=os.getenv("HERMES_HOME", ""),
        help="Hermes home directory (default: $HERMES_HOME or ~/.hermes)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without writing jobs.json",
    )
    return p.parse_args()


def _hermes_home(explicit: str) -> Path:
    raw = (explicit or "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".hermes"


def main() -> int:
    args = parse_args()
    hermes_home = _hermes_home(args.hermes_home)
    jobs_path = hermes_home / "cron" / "jobs.json"

    if not jobs_path.exists():
        print(f"jobs.json not found: {jobs_path}")
        return 0

    try:
        data = json.loads(jobs_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"ERROR: failed to read {jobs_path}: {exc}", file=sys.stderr)
        return 1

    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        print(f"No jobs list in {jobs_path} (nothing to do)")
        return 0

    keep = []
    removed = []
    for job in jobs:
        name = None
        if isinstance(job, dict):
            name = job.get("name")
        if name in JOB_NAMES:
            removed.append(job)
        else:
            keep.append(job)

    if not removed:
        print("No hermilinChat cron jobs found (nothing to remove).")
        return 0

    print("Removing Hermes cron jobs:")
    for job in removed:
        jid = job.get("id") if isinstance(job, dict) else None
        name = job.get("name") if isinstance(job, dict) else None
        schedule = job.get("schedule_display") if isinstance(job, dict) else None
        print(f"  - {name} (id={jid}, schedule={schedule})")

    if args.dry_run:
        print("\nDry run only. jobs.json not modified.")
        return 0

    data["jobs"] = keep
    jobs_path.parent.mkdir(parents=True, exist_ok=True)
    jobs_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\nUpdated: {jobs_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
