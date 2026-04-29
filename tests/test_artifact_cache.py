import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from hermelin import artifacts
from hermelin.artifacts import delete_artifact, latest_artifact, list_artifacts


def write_artifact(root: Path, artifact_id: str, *, payload_size: int = 8) -> Path:
    target = artifacts.artifact_session_dir(root) / f"{artifact_id}.json"
    target.write_text(
        json.dumps(
            {
                "id": artifact_id,
                "type": "markdown",
                "title": artifact_id,
                "timestamp": 1.0,
                "data": {"markdown": "x" * payload_size},
            }
        ),
        encoding="utf-8",
    )
    return target


class ArtifactCacheTests(unittest.TestCase):
    def setUp(self):
        artifacts._clear_artifact_cache()
        self._old_limits = (
            artifacts._ARTIFACT_CACHE_MAX_ENTRIES,
            artifacts._ARTIFACT_CACHE_MAX_BYTES,
            artifacts._ARTIFACT_CACHE_MAX_FILE_BYTES,
            artifacts._ARTIFACT_READ_MAX_FILE_BYTES,
        )

    def tearDown(self):
        (
            artifacts._ARTIFACT_CACHE_MAX_ENTRIES,
            artifacts._ARTIFACT_CACHE_MAX_BYTES,
            artifacts._ARTIFACT_CACHE_MAX_FILE_BYTES,
            artifacts._ARTIFACT_READ_MAX_FILE_BYTES,
        ) = self._old_limits
        artifacts._clear_artifact_cache()

    def test_artifact_cache_is_bounded_by_entry_count(self):
        artifacts._ARTIFACT_CACHE_MAX_ENTRIES = 2
        artifacts._ARTIFACT_CACHE_MAX_BYTES = 1024 * 1024
        artifacts._ARTIFACT_CACHE_MAX_FILE_BYTES = 1024 * 1024

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_artifact(root, "one")
            write_artifact(root, "two")
            write_artifact(root, "three")

            listed = list_artifacts(root)

            self.assertEqual({item["id"] for item in listed}, {"one", "two", "three"})
            self.assertLessEqual(len(artifacts._ARTIFACT_FILE_CACHE), 2)

    def test_delete_artifact_invalidates_cached_payload(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            target = write_artifact(root, "doomed")

            self.assertEqual(list_artifacts(root)[0]["id"], "doomed")
            self.assertIn(target.resolve(), artifacts._ARTIFACT_FILE_CACHE)

            self.assertTrue(delete_artifact(root, "doomed"))

            self.assertNotIn(target.resolve(), artifacts._ARTIFACT_FILE_CACHE)
            self.assertEqual(list_artifacts(root), [])

    def test_oversized_artifacts_are_not_cached(self):
        artifacts._ARTIFACT_CACHE_MAX_ENTRIES = 10
        artifacts._ARTIFACT_CACHE_MAX_BYTES = 1024 * 1024
        artifacts._ARTIFACT_CACHE_MAX_FILE_BYTES = 64
        artifacts._ARTIFACT_READ_MAX_FILE_BYTES = 1024 * 1024

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            target = write_artifact(root, "large", payload_size=512)

            self.assertEqual(list_artifacts(root)[0]["id"], "large")
            self.assertNotIn(target.resolve(), artifacts._ARTIFACT_FILE_CACHE)

    def test_oversized_artifacts_are_not_read_and_invalidate_existing_cache(self):
        artifacts._ARTIFACT_CACHE_MAX_ENTRIES = 10
        artifacts._ARTIFACT_CACHE_MAX_BYTES = 1024 * 1024
        artifacts._ARTIFACT_CACHE_MAX_FILE_BYTES = 1024 * 1024
        artifacts._ARTIFACT_READ_MAX_FILE_BYTES = 256

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            target = write_artifact(root, "large", payload_size=8)

            self.assertEqual(list_artifacts(root)[0]["id"], "large")
            self.assertIn(target.resolve(), artifacts._ARTIFACT_FILE_CACHE)

            write_artifact(root, "large", payload_size=1024)

            self.assertEqual(list_artifacts(root), [])
            self.assertNotIn(target.resolve(), artifacts._ARTIFACT_FILE_CACHE)

    def test_persistent_live_artifact_without_runner_reports_stopped(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            target = artifacts.artifact_persistent_dir(root) / "saved-live.json"
            target.write_text(
                json.dumps(
                    {
                        "id": "saved-live",
                        "type": "iframe",
                        "title": "Saved Live Dashboard",
                        "timestamp": 10.0,
                        "updated_at": 10.0,
                        "live": True,
                        "refresh_seconds": 2,
                        "data": {"src": "http://127.0.0.1:43123/"},
                    }
                ),
                encoding="utf-8",
            )

            listed = list_artifacts(root)
            self.assertEqual(len(listed), 1)
            self.assertTrue(listed[0]["live"])
            self.assertTrue(listed[0]["persistent"])
            self.assertFalse(listed[0]["runner_active"])
            self.assertEqual(listed[0]["runner_status"], "stopped")

            latest = latest_artifact(root)
            self.assertIsNotNone(latest)
            self.assertFalse(latest["runner_active"])
            self.assertEqual(latest["runner_status"], "stopped")

    def test_runner_status_ignores_stale_pid_files(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_artifact(root, "stale-live")
            artifact_path = artifacts.artifact_session_dir(root) / "stale-live.json"
            payload = json.loads(artifact_path.read_text(encoding="utf-8"))
            payload.update({"live": True, "refresh_seconds": 1})
            artifact_path.write_text(json.dumps(payload), encoding="utf-8")
            (artifacts.artifact_pids_dir(root) / "stale-live.pid").write_text("not-a-pid", encoding="utf-8")

            item = list_artifacts(root)[0]
            self.assertFalse(item["runner_active"])
            self.assertEqual(item["runner_status"], "stale_pid")

    def test_runner_status_detects_active_runner_project_process(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_artifact(root, "active-live")
            artifact_path = artifacts.artifact_session_dir(root) / "active-live.json"
            payload = json.loads(artifact_path.read_text(encoding="utf-8"))
            payload.update({"live": True, "refresh_seconds": 1})
            artifact_path.write_text(json.dumps(payload), encoding="utf-8")

            project_dir = artifacts.artifact_runners_dir(root) / "projects" / "active-live"
            project_dir.mkdir(parents=True)
            proc = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                cwd=str(project_dir),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                (artifacts.artifact_pids_dir(root) / "active-live.pid").write_text(str(proc.pid), encoding="utf-8")

                item = list_artifacts(root)[0]
                self.assertTrue(item["runner_active"])
                self.assertIn(item["runner_status"], {"running", "running_unverified"})
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
