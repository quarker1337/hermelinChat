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


def _truncate_one_line(s: Optional[str], n: int) -> Optional[str]:
    if not s:
        return None
    line = (s.splitlines()[0] if s else "").strip()
    if not line:
        return None
    if len(line) <= n:
        return line
    return line[: n - 1].rstrip() + "…"


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
            "SELECT s.id, s.source, s.user_id, s.model, s.started_at, s.ended_at, s.end_reason, "
            "s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens, "
            "(SELECT m.content FROM messages m "
            "   WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL AND m.content != '' "
            "   ORDER BY m.timestamp ASC LIMIT 1) AS first_user_message, "
            "(SELECT m.content FROM messages m "
            "   WHERE m.session_id = s.id AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND m.content != '' "
            "   ORDER BY m.timestamp DESC LIMIT 1) AS last_message "
            "FROM sessions s"
        )
        if source:
            sql += " WHERE s.source = ?"
            params.append(source)

        sql += " ORDER BY s.started_at DESC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])

        rows = conn.execute(sql, params).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        first_user = r["first_user_message"]
        last_msg = r["last_message"]

        title = _truncate_one_line(first_user, 60) or r["id"]
        preview = _truncate_one_line(last_msg, 80)

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
                "title": title,
                "preview": preview,
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
    """FTS5 search across messages.content.

    Returns message rowids + snippets. If the query is invalid FTS syntax,
    falls back to phrase search.
    """
    if not db_path.exists():
        return []

    query = (query or "").strip()
    if not query:
        return []

    base_sql = (
        "SELECT m.id, m.session_id, m.role, m.timestamp, "
        "snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, "
        "s.started_at AS session_started_at, s.model AS session_model, "
        "(SELECT m2.content FROM messages m2 "
        "   WHERE m2.session_id = s.id AND m2.role = 'user' AND m2.content IS NOT NULL AND m2.content != '' "
        "   ORDER BY m2.timestamp ASC LIMIT 1) AS first_user_message "
        "FROM messages_fts "
        "JOIN messages m ON m.id = messages_fts.rowid "
        "JOIN sessions s ON s.id = m.session_id "
        "WHERE messages_fts MATCH ? AND m.role IN ('user','assistant')"
    )

    def _run(q: str):
        with connect_db(db_path) as conn:
            params: list[Any] = [q]
            sql = base_sql
            if session_id:
                sql += " AND m.session_id = ?"
                params.append(session_id)
            sql += " ORDER BY m.timestamp DESC LIMIT ? OFFSET ?"
            params.extend([int(limit), int(offset)])
            return conn.execute(sql, params).fetchall()

    try:
        rows = _run(query)
    except sqlite3.OperationalError:
        # Fallback to phrase query
        safe = query.replace('"', '""')
        try:
            rows = _run(f'"{safe}"')
        except sqlite3.OperationalError:
            return []

    out: list[dict[str, Any]] = []
    for r in rows:
        title = _truncate_one_line(r["first_user_message"], 60) or r["session_id"]
        out.append(
            {
                "id": r["id"],
                "session_id": r["session_id"],
                "session_title": title,
                "session_started_at": r["session_started_at"],
                "session_started_at_iso": _ts_to_iso(r["session_started_at"]),
                "session_model": r["session_model"],
                "role": r["role"],
                "timestamp": r["timestamp"],
                "timestamp_iso": _ts_to_iso(r["timestamp"]),
                "snippet": r["snippet"],
            }
        )
    return out
