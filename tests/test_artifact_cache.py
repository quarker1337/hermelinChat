import json
import tempfile
import unittest
from pathlib import Path

from hermelin import artifacts
from hermelin.artifacts import delete_artifact, list_artifacts


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


if __name__ == "__main__":
    unittest.main()
