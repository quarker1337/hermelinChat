#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from pathlib import Path

JOB_NAME = "hermelin-whispers"

PROMPT = r'''You are a background cron job that generates tiny UI "whispers" for hermelinChat.

Goal
- Maintain a pool of short one-liners used by the bottom-right alignment easter egg.

Paths
- Hermes home: $HERMES_HOME (default: ~/.hermes)
- hermelin meta DB: $HERMES_HOME/hermelin_meta.db

Meta DB schema (create if missing)
- Table: ui_whispers
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - text TEXT NOT NULL UNIQUE
  - source TEXT NOT NULL DEFAULT 'auto'
  - created_at REAL NOT NULL
  - updated_at REAL NOT NULL
  - used_count INTEGER NOT NULL DEFAULT 0
  - last_used_at REAL

Whisper rules
- Single line
- 3–26 characters (counting {user} as 6 chars)
- No quotes
- No emojis
- No secrets (API keys, tokens, passwords)
- No trailing punctuation (ellipsis "…" is OK)

Personalization
- Include the placeholder {user} in some whispers.
- Do NOT expand it. hermelinChat will replace {user} with the Linux username.

What to do each run
1) Ensure the meta DB + ui_whispers table exist.
2) Load existing ui_whispers.text into a set.
3) Generate 30 new candidate whispers (at least 10 include {user}).
4) Validate + dedupe + insert up to 30 new unique whispers with source='auto'.
5) Prune: keep at most 300 rows (delete oldest by updated_at).
6) Print a short report: inserted count + a few examples.

Implementation notes
- Use the terminal tool and run python3 with stdlib sqlite3.
- Do not modify state.db.

Hint: Python skeleton for inserting whispers

python3 - <<'PY'
import os, sqlite3, time, pathlib

WHISPERS = [
  # 'aligned to you…',
  # 'wake up, {user}',
]

home = pathlib.Path(os.getenv('HERMES_HOME', str(pathlib.Path.home()/'.hermes'))).expanduser()
db = home / 'hermelin_meta.db'

def ensure(conn):
    conn.execute("""
    CREATE TABLE IF NOT EXISTS ui_whispers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT 'auto',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        last_used_at REAL
    )
    """)

conn = sqlite3.connect(str(db))
ensure(conn)
now = time.time()
ins = 0
for w in WHISPERS:
    w = str(w or '').strip().replace('\n',' ').replace('\r',' ')
    if not w:
        continue
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO ui_whispers (text, source, created_at, updated_at) VALUES (?, 'auto', ?, ?)",
            (w, now, now),
        )
        if cur.rowcount and cur.rowcount > 0:
            ins += 1
    except Exception:
        pass

# prune to 300
try:
    n = conn.execute('SELECT COUNT(*) FROM ui_whispers').fetchone()[0]
    if n > 300:
        extra = n - 300
        ids = [r[0] for r in conn.execute(
            'SELECT id FROM ui_whispers ORDER BY updated_at ASC LIMIT ?',
            (extra,),
        ).fetchall()]
        if ids:
            q = ','.join(['?']*len(ids))
            conn.execute(f'DELETE FROM ui_whispers WHERE id IN ({q})', ids)
except Exception:
    pass

conn.commit()
print(f'OK: inserted {ins} whisper(s) into {db}')
PY
'''


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()


def _load_jobs(path: Path) -> dict:
    if not path.exists():
        return {"jobs": [], "updated_at": datetime.now().isoformat()}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"jobs": [], "updated_at": datetime.now().isoformat()}


def _save_jobs(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = datetime.now().isoformat()
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _ensure_job(data: dict, *, minutes: int) -> str:
    jobs = list(data.get("jobs") or [])

    schedule = {
        "kind": "interval",
        "minutes": int(minutes),
        "display": "every 1d",
    }

    now = datetime.now()
    # Make the first run due immediately (next cron tick will execute it).
    next_run_at = now.isoformat()

    for job in jobs:
        if job.get("name") == JOB_NAME:
            job["prompt"] = PROMPT
            job["schedule"] = schedule
            job["schedule_display"] = schedule["display"]
            job["enabled"] = True
            job.setdefault("repeat", {"times": None, "completed": 0})
            job.setdefault("created_at", now.isoformat())
            job["next_run_at"] = next_run_at
            job.setdefault("last_run_at", None)
            job.setdefault("last_status", None)
            job.setdefault("last_error", None)
            job["deliver"] = "local"
            job["origin"] = None
            data["jobs"] = jobs
            return str(job.get("id") or "")

    job_id = uuid.uuid4().hex[:12]
    jobs.append(
        {
            "id": job_id,
            "name": JOB_NAME,
            "prompt": PROMPT,
            "schedule": schedule,
            "schedule_display": schedule["display"],
            "repeat": {"times": None, "completed": 0},
            "enabled": True,
            "created_at": now.isoformat(),
            "next_run_at": next_run_at,
            "last_run_at": None,
            "last_status": None,
            "last_error": None,
            "deliver": "local",
            "origin": None,
        }
    )

    data["jobs"] = jobs
    return job_id


def main() -> int:
    hermes_home = _hermes_home()
    jobs_path = hermes_home / "cron" / "jobs.json"

    data = _load_jobs(jobs_path)
    job_id = _ensure_job(data, minutes=1440)
    _save_jobs(jobs_path, data)

    print(f"Installed/updated Hermes cron job '{JOB_NAME}' (id={job_id})")
    print(f"jobs.json: {jobs_path}")
    print()
    print("Reminder: Hermes cron jobs only fire automatically if either:")
    print("  - the Hermes gateway is running (hermes gateway install/start), OR")
    print("  - you run: hermes cron tick (e.g. from OS cron/systemd timer)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
