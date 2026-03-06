from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Iterable


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_titles_source ON session_titles(source);
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path = Path(db_path).expanduser()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    return conn


def ensure_meta_db(db_path: Path) -> None:
    """Create the hermilin meta DB if missing (idempotent)."""
    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA_SQL)
        conn.commit()


def get_titles_map(db_path: Path, session_ids: Iterable[str]) -> dict[str, str]:
    ids = [str(s) for s in (session_ids or []) if str(s)]
    if not ids:
        return {}

    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA_SQL)
        conn.commit()

        q = ",".join(["?"] * len(ids))
        rows = conn.execute(
            f"SELECT session_id, title FROM session_titles WHERE session_id IN ({q})",
            ids,
        ).fetchall()

    out: dict[str, str] = {}
    for r in rows:
        out[str(r["session_id"])] = str(r["title"])
    return out


def upsert_title(db_path: Path, *, session_id: str, title: str, source: str = "auto") -> None:
    session_id = str(session_id or "").strip()
    title = str(title or "").strip()
    source = str(source or "auto").strip() or "auto"

    if not session_id or not title:
        return

    now = time.time()
    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA_SQL)
        conn.execute(
            """
            INSERT INTO session_titles (session_id, title, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                title = excluded.title,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            (session_id, title, source, now, now),
        )
        conn.commit()
