import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from hermelin.runners import discover_runner_upstream, read_runner_manifest
from hermelin.state_reader import resolve_resume_session_id


SESSIONS_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY
);
"""


def _init_state_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SESSIONS_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _insert_session(db_path: Path, *, session_id: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("INSERT INTO sessions (id) VALUES (?)", (session_id,))
        conn.commit()
    finally:
        conn.close()


class RunnerSecurityTests(unittest.TestCase):
    def test_read_runner_manifest_accepts_manifest_under_project_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_dir = Path(tmpdir) / "artifacts"
            project_dir = artifact_dir / "runners" / "projects" / "tab-1"
            project_dir.mkdir(parents=True)
            manifest_path = project_dir / "runner.json"
            manifest_path.write_text(
                json.dumps({"scheme": "http", "host": "127.0.0.1", "port": 43123}),
                encoding="utf-8",
            )

            manifest = read_runner_manifest(artifact_dir, "tab-1")

        self.assertEqual(manifest, {"scheme": "http", "host": "127.0.0.1", "port": 43123})

    def test_read_runner_manifest_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            artifact_dir = root / "artifacts"
            project_dir = artifact_dir / "runners" / "projects" / "tab-1"
            project_dir.mkdir(parents=True)

            outside = root / "outside-runner.json"
            outside.write_text(
                json.dumps({"scheme": "http", "host": "127.0.0.1", "port": 43123}),
                encoding="utf-8",
            )
            os.symlink(outside, project_dir / "runner.json")

            manifest = read_runner_manifest(artifact_dir, "tab-1")

        self.assertIsNone(manifest)

    def test_read_runner_manifest_rejects_symlinked_project_dir_escape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            artifact_dir = root / "artifacts"
            projects_root = artifact_dir / "runners" / "projects"
            projects_root.mkdir(parents=True)

            outside_dir = root / "outside-project"
            outside_dir.mkdir()
            (outside_dir / "runner.json").write_text(
                json.dumps({"scheme": "http", "host": "127.0.0.1", "port": 43123}),
                encoding="utf-8",
            )
            os.symlink(outside_dir, projects_root / "tab-1")

            manifest = read_runner_manifest(artifact_dir, "tab-1")

        self.assertIsNone(manifest)

    def test_discover_runner_upstream_rejects_symlinked_artifact_escape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            artifact_dir = root / "artifacts"
            session_dir = artifact_dir / "session"
            session_dir.mkdir(parents=True)

            outside = root / "outside-artifact.json"
            outside.write_text(
                json.dumps(
                    {
                        "id": "tab-1",
                        "type": "iframe",
                        "data": {"src": "http://127.0.0.1:43123/"},
                    }
                ),
                encoding="utf-8",
            )
            os.symlink(outside, session_dir / "tab-1.json")

            upstream = discover_runner_upstream(artifact_dir, "tab-1")

        self.assertIsNone(upstream)


class ResumeSessionValidationTests(unittest.TestCase):
    def test_resolve_resume_session_id_accepts_existing_session(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "state.db"
            _init_state_db(db_path)
            _insert_session(db_path, session_id="20260413_134408_76e00f")

            resolved = resolve_resume_session_id(db_path, "20260413_134408_76e00f")

        self.assertEqual(resolved, "20260413_134408_76e00f")

    def test_resolve_resume_session_id_rejects_option_like_values(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "state.db"
            _init_state_db(db_path)
            _insert_session(db_path, session_id="20260413_134408_76e00f")

            self.assertIsNone(resolve_resume_session_id(db_path, "--help"))
            self.assertIsNone(resolve_resume_session_id(db_path, "-r"))
            self.assertIsNone(resolve_resume_session_id(db_path, "../../etc/passwd"))

    def test_resolve_resume_session_id_rejects_unknown_session(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "state.db"
            _init_state_db(db_path)

            resolved = resolve_resume_session_id(db_path, "20260413_134408_76e00f")

        self.assertIsNone(resolved)


if __name__ == "__main__":
    unittest.main()
