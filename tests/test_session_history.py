import sqlite3
import tempfile
import unittest
from pathlib import Path

from hermelin.state_reader import list_sessions


SESSIONS_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    title TEXT
);
"""

MESSAGES_SCHEMA = """
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    timestamp REAL NOT NULL
);
"""


def _init_state_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SESSIONS_SCHEMA)
        conn.executescript(MESSAGES_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _insert_session(
    db_path: Path,
    *,
    session_id: str,
    started_at: float,
    title: str | None = None,
    parent_session_id: str | None = None,
    end_reason: str | None = None,
    source: str = "cli",
) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO sessions (
                id, source, user_id, model, model_config, system_prompt, parent_session_id,
                started_at, ended_at, end_reason, message_count, tool_call_count,
                input_tokens, output_tokens, title
            ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, 0, 0, 0, 0, ?)
            """,
            (session_id, source, parent_session_id, started_at, end_reason, title),
        )
        conn.commit()
    finally:
        conn.close()


def _insert_message(db_path: Path, *, session_id: str, role: str, content: str, timestamp: float) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content, timestamp),
        )
        conn.commit()
    finally:
        conn.close()


class SessionHistoryTests(unittest.TestCase):
    def test_list_sessions_hides_compression_ancestors_and_keeps_latest_leaf(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "state.db"
            _init_state_db(db_path)

            _insert_session(
                db_path,
                session_id="root-session",
                started_at=100.0,
                title="Build feature",
                end_reason="compression",
            )
            _insert_session(
                db_path,
                session_id="leaf-session",
                started_at=200.0,
                title="Build feature #2",
                parent_session_id="root-session",
            )
            _insert_session(
                db_path,
                session_id="plain-session",
                started_at=150.0,
                title="Unrelated task",
            )

            sessions = list_sessions(db_path, limit=10)

        self.assertEqual([item["id"] for item in sessions], ["leaf-session", "plain-session"])
        self.assertEqual(sessions[0]["title"], "Build feature #2")
        self.assertEqual(sessions[1]["title"], "Unrelated task")

    def test_list_sessions_prefers_session_title_over_first_user_message(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "state.db"
            _init_state_db(db_path)

            _insert_session(
                db_path,
                session_id="session-with-title",
                started_at=100.0,
                title="Human Friendly Title",
            )
            _insert_message(
                db_path,
                session_id="session-with-title",
                role="user",
                content="You've reached the maximum number of tool-calling iterations allowed.",
                timestamp=101.0,
            )

            sessions = list_sessions(db_path, limit=10)

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["title"], "Human Friendly Title")


if __name__ == "__main__":
    unittest.main()
