#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from pathlib import Path

JOB_NAME = "hermilin-autotitle"

PROMPT = r'''You are a background cron job that generates short, useful titles for Hermes sessions.

Goal
- Populate a metadata SQLite DB with better session titles for hermilinChat.

Paths
- Hermes home: $HERMES_HOME (default: ~/.hermes)
- Hermes state DB: $HERMES_HOME/state.db
- hermilin meta DB: $HERMES_HOME/hermilin_meta.db

Meta DB schema (create if missing)
- Table: session_titles
  - session_id TEXT PRIMARY KEY
  - title TEXT NOT NULL
  - source TEXT NOT NULL DEFAULT 'auto'
  - created_at REAL NOT NULL
  - updated_at REAL NOT NULL

Title rules
- 3–6 words
- Title Case
- No quotes
- No trailing punctuation
- Do NOT include secrets (API keys, tokens, passwords, cookie values)
- Prefer describing the actual task/goal.

What to do each run
1) Find up to 5 recent sessions that:
   - have at least one non-empty user message
   - are NOT already present in hermilin_meta.db.session_titles
   - are NOT cron sessions (source != 'cron')
2) For each candidate, fetch a small context window to title:
   - first user message
   - first assistant message (if any)
   - second user message (if any)
   Truncate each to ~300 chars and strip newlines.
3) Generate titles following the rules above.
4) Insert titles into hermilin_meta.db with source='auto'.
5) Print a short report: how many titles were added and the (session_id -> title) pairs.

Implementation notes
- Use the terminal tool and run python3 with stdlib sqlite3.
- Do not modify state.db.

Do this now (tool-driven)
1) Use the terminal tool to run this python and print candidates as JSON (edit LIMITS if needed):

python3 - <<'PY'
import json, os, sqlite3, pathlib

def trunc(s, n=300):
    if not s:
        return None
    s = str(s).strip().replace('\n', ' ').replace('\r', ' ')
    return (s[: n - 1] + '…') if len(s) > n else s

home = pathlib.Path(os.getenv('HERMES_HOME', str(pathlib.Path.home()/'.hermes'))).expanduser()
state_db = home / 'state.db'
meta_db = home / 'hermilin_meta.db'

meta_db.parent.mkdir(parents=True, exist_ok=True)
mc = sqlite3.connect(str(meta_db))
mc.execute("""
CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
)
""")
mc.commit()
existing = set(r[0] for r in mc.execute('SELECT session_id FROM session_titles').fetchall())
mc.close()

conn = sqlite3.connect(str(state_db))
conn.row_factory = sqlite3.Row
rows = conn.execute("""
SELECT s.id, s.source, s.started_at,
  (SELECT m.content FROM messages m
     WHERE m.session_id=s.id AND m.role='user' AND m.content IS NOT NULL AND m.content!=''
     ORDER BY m.timestamp ASC LIMIT 1) AS m1,
  (SELECT m.content FROM messages m
     WHERE m.session_id=s.id AND m.role='assistant' AND m.content IS NOT NULL AND m.content!=''
     ORDER BY m.timestamp ASC LIMIT 1) AS a1,
  (SELECT m.content FROM messages m
     WHERE m.session_id=s.id AND m.role='user' AND m.content IS NOT NULL AND m.content!=''
     ORDER BY m.timestamp ASC LIMIT 1 OFFSET 1) AS m2
FROM sessions s
ORDER BY s.started_at DESC
LIMIT 80
""").fetchall()

candidates = []
for r in rows:
    sid = r['id']
    if r['source'] == 'cron':
        continue
    if sid in existing:
        continue
    if not r['m1']:
        continue
    candidates.append({
        'session_id': sid,
        'source': r['source'],
        'started_at': r['started_at'],
        'm1': trunc(r['m1']),
        'a1': trunc(r['a1']),
        'm2': trunc(r['m2']),
    })
    if len(candidates) >= 5:
        break

print(json.dumps({
    'state_db': str(state_db),
    'meta_db': str(meta_db),
    'candidates': candidates,
}, ensure_ascii=False, indent=2))
PY

2) From the JSON candidates, generate titles. Then use the terminal tool to write them by running this second python call (fill in the titles list):

python3 - <<'PY'
import os, sqlite3, time, pathlib

titles = [
    # ('SESSION_ID', 'Your Title Here'),
]

home = pathlib.Path(os.getenv('HERMES_HOME', str(pathlib.Path.home()/'.hermes'))).expanduser()
meta_db = home / 'hermilin_meta.db'

conn = sqlite3.connect(str(meta_db))
conn.execute("""
CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
)
""")
now = time.time()
for sid, title in titles:
    sid = str(sid).strip()
    title = str(title).strip()
    if not sid or not title:
        continue
    conn.execute(
        """
        INSERT INTO session_titles (session_id, title, source, created_at, updated_at)
        VALUES (?, ?, 'auto', ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
            title = excluded.title,
            source = excluded.source,
            updated_at = excluded.updated_at
        """,
        (sid, title, now, now),
    )
conn.commit()
print(f'OK: wrote {len(titles)} title(s) to {meta_db}')
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
        "display": f"every {int(minutes)}m",
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
            job.setdefault("next_run_at", next_run_at)
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
    job_id = _ensure_job(data, minutes=5)
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
