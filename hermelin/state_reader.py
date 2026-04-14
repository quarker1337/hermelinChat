from __future__ import annotations

import datetime as dt
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("hermelin.state_reader")

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")


def _ts_to_iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).isoformat()


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def resolve_resume_session_id(db_path: Path, value: Optional[str]) -> Optional[str]:
    session_id = str(value or "").strip()
    if not session_id or not _SESSION_ID_RE.fullmatch(session_id):
        return None
    if not db_path.exists():
        return None

    try:
        with connect_db(db_path) as conn:
            row = conn.execute("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,)).fetchone()
    except sqlite3.Error:
        logger.debug("failed to validate resume session id", exc_info=True)
        return None

    return session_id if row else None


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
            "SELECT s.id, s.source, s.user_id, s.model, s.parent_session_id, s.title AS session_title, "
            "s.started_at, s.ended_at, s.end_reason, s.message_count, s.tool_call_count, "
            "s.input_tokens, s.output_tokens, "
            "(SELECT m.content FROM messages m "
            "   WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL AND m.content != '' "
            "   ORDER BY m.timestamp ASC LIMIT 1) AS first_user_message, "
            "(SELECT m.content FROM messages m "
            "   WHERE m.session_id = s.id AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND m.content != '' "
            "   ORDER BY m.timestamp DESC LIMIT 1) AS last_message "
            "FROM sessions s "
            "WHERE NOT EXISTS ("
            "   SELECT 1 FROM sessions child WHERE child.parent_session_id = s.id"
            ")"
        )
        if source:
            sql += " AND s.source = ?"
            params.append(source)

        sql += " ORDER BY s.started_at DESC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])

        rows = conn.execute(sql, params).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        first_user = r["first_user_message"]
        last_msg = r["last_message"]

        title = _truncate_one_line(r["session_title"], 60) or _truncate_one_line(first_user, 60) or r["id"]
        preview = _truncate_one_line(last_msg, 80)

        out.append(
            {
                "id": r["id"],
                "source": r["source"],
                "user_id": r["user_id"],
                "model": r["model"],
                "parent_session_id": r["parent_session_id"],
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
        logger.debug("FTS query failed, falling back to phrase search: %s", query, exc_info=True)
        safe = query.replace('"', '""')
        try:
            rows = _run(f'"{safe}"')
        except sqlite3.OperationalError:
            logger.debug("FTS phrase fallback also failed: %s", query, exc_info=True)
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


def _truncate_text(s: Optional[str], n: int) -> Optional[str]:
    if s is None:
        return None
    if len(s) <= n:
        return s
    return s[:n] + "\n…(truncated)…"


def get_message_context(
    db_path: Path,
    *,
    message_id: int,
    before: int = 3,
    after: int = 3,
    max_chars: int = 12000,
) -> Optional[dict[str, Any]]:
    """Return a small read-only context window around a message.

    Uses message.id ordering within a session (autoincrement) which matches
    chronological insertion for a session.

    Only includes user/assistant roles (skips tools).
    """
    if not db_path.exists():
        return None

    try:
        mid = int(message_id)
    except (TypeError, ValueError):
        return None

    before_n = max(0, min(int(before or 0), 20))
    after_n = max(0, min(int(after or 0), 20))

    with connect_db(db_path) as conn:
        row = conn.execute(
            "SELECT id, session_id, role, content, timestamp FROM messages WHERE id = ?",
            (mid,),
        ).fetchone()
        if row is None:
            return None

        session_id = row["session_id"]

        srow = conn.execute(
            "SELECT s.id, s.model, s.started_at, "
            "(SELECT m2.content FROM messages m2 "
            "   WHERE m2.session_id = s.id AND m2.role = 'user' AND m2.content IS NOT NULL AND m2.content != '' "
            "   ORDER BY m2.timestamp ASC LIMIT 1) AS first_user_message "
            "FROM sessions s WHERE s.id = ?",
            (session_id,),
        ).fetchone()

        session_title = _truncate_one_line(srow["first_user_message"] if srow else None, 60) or session_id
        session_model = srow["model"] if srow else None
        session_started_at = srow["started_at"] if srow else None

        filter_sql = (
            "session_id = ? AND role IN ('user','assistant') "
            "AND content IS NOT NULL AND content != ''"
        )

        target = conn.execute(
            f"SELECT id, role, content, timestamp FROM messages WHERE {filter_sql} AND id = ?",
            (session_id, mid),
        ).fetchone()

        before_rows = conn.execute(
            f"SELECT id, role, content, timestamp FROM messages WHERE {filter_sql} AND id < ? "
            "ORDER BY id DESC LIMIT ?",
            (session_id, mid, before_n),
        ).fetchall()

        after_rows = conn.execute(
            f"SELECT id, role, content, timestamp FROM messages WHERE {filter_sql} AND id > ? "
            "ORDER BY id ASC LIMIT ?",
            (session_id, mid, after_n),
        ).fetchall()

        messages = list(reversed(before_rows))
        if target is not None:
            messages.append(target)
        messages.extend(after_rows)

    out_msgs: list[dict[str, Any]] = []
    for m in messages:
        content = m["content"]
        truncated = content is not None and len(content) > max_chars
        out_msgs.append(
            {
                "id": m["id"],
                "role": m["role"],
                "timestamp": m["timestamp"],
                "timestamp_iso": _ts_to_iso(m["timestamp"]),
                "content": _truncate_text(content, max_chars),
                "content_truncated": truncated,
                "is_target": m["id"] == mid,
            }
        )

    return {
        "session_id": session_id,
        "session_title": session_title,
        "session_model": session_model,
        "session_started_at": session_started_at,
        "session_started_at_iso": _ts_to_iso(session_started_at),
        "target_message_id": mid,
        "messages": out_msgs,
    }
