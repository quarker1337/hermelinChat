from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path
from typing import Any, Optional


def _ts_to_iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).isoformat()


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def list_sessions(
    db_path: Path,
    *,
    limit: int = 50,
    offset: int = 0,
    source: Optional[str] = None,
) -> list[dict[str, Any]]:
    if not db_path.exists():
        return []

    with connect_db(db_path) as conn:
        params: list[Any] = []
        sql = (
            "SELECT id, source, user_id, model, started_at, ended_at, end_reason, "
            "message_count, tool_call_count, input_tokens, output_tokens "
            "FROM sessions"
        )
        if source:
            sql += " WHERE source = ?"
            params.append(source)

        sql += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])

        rows = conn.execute(sql, params).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "source": r["source"],
                "user_id": r["user_id"],
                "model": r["model"],
                "started_at": r["started_at"],
                "started_at_iso": _ts_to_iso(r["started_at"]),
                "ended_at": r["ended_at"],
                "ended_at_iso": _ts_to_iso(r["ended_at"]),
                "end_reason": r["end_reason"],
                "message_count": r["message_count"],
                "tool_call_count": r["tool_call_count"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
            }
        )
    return out


def search_messages(
    db_path: Path,
    *,
    query: str,
    limit: int = 20,
    offset: int = 0,
    session_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """FTS5 search across messages.content. Returns message rowids + snippets."""
    if not db_path.exists():
        return []

    with connect_db(db_path) as conn:
        params: list[Any] = []
        sql = (
            "SELECT m.id, m.session_id, m.role, m.timestamp, "
            "snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet "
            "FROM messages_fts "
            "JOIN messages m ON m.id = messages_fts.rowid "
            "WHERE messages_fts MATCH ?"
        )
        params.append(query)

        if session_id:
            sql += " AND m.session_id = ?"
            params.append(session_id)

        sql += " ORDER BY m.timestamp DESC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])

        rows = conn.execute(sql, params).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "session_id": r["session_id"],
                "role": r["role"],
                "timestamp": r["timestamp"],
                "timestamp_iso": _ts_to_iso(r["timestamp"]),
                "snippet": r["snippet"],
            }
        )
    return out
