import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from hermelin import artifacts
from hermelin.config import HermelinConfig
from hermelin.server import create_app


def write_artifact(directory: Path, artifact_id: str, *, persistent: bool = False) -> Path:
    target_dir = artifacts.artifact_persistent_dir(directory) if persistent else artifacts.artifact_session_dir(directory)
    target = target_dir / f"{artifact_id}.json"
    target.write_text(
        json.dumps(
            {
                "id": artifact_id,
                "type": "markdown",
                "title": artifact_id,
                "timestamp": 1.0,
                "data": {"markdown": artifact_id},
            }
        ),
        encoding="utf-8",
    )
    return target


class ArtifactActionEndpointTests(unittest.TestCase):
    def test_clear_session_artifacts_endpoint_removes_transient_artifacts_only(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            hermes_home = tmp / "hermes-home"
            artifact_root = hermes_home / "artifacts"
            transient_path = write_artifact(artifact_root, "transient")
            saved_path = write_artifact(artifact_root, "saved", persistent=True)

            client = TestClient(
                create_app(
                    HermelinConfig(
                        hermes_home=hermes_home,
                        meta_db_path=tmp / "hermelin_meta.db",
                        spawn_cwd=tmp / "spawn-cwd",
                        auth_password_hash="",
                        allowed_ips="*",
                    )
                )
            )

            response = client.post("/api/artifacts/clear-session")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["removed_artifacts"], 1)
            self.assertEqual(payload["removed_artifact_ids"], ["transient"])
            self.assertFalse(transient_path.exists())
            self.assertTrue(saved_path.exists())
            self.assertEqual(
                [item["id"] for item in artifacts.list_artifacts(artifact_root, hermes_home=hermes_home)],
                ["saved"],
            )

    def test_rename_artifact_endpoint_updates_artifact_title(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            hermes_home = tmp / "hermes-home"
            artifact_root = hermes_home / "artifacts"
            artifact_path = write_artifact(artifact_root, "chart")

            client = TestClient(
                create_app(
                    HermelinConfig(
                        hermes_home=hermes_home,
                        meta_db_path=tmp / "hermelin_meta.db",
                        spawn_cwd=tmp / "spawn-cwd",
                        auth_password_hash="",
                        allowed_ips="*",
                    )
                )
            )

            response = client.post("/api/artifacts/chart/rename", json={"title": "Quarterly Revenue"})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["title"], "Quarterly Revenue")
            payload = json.loads(artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["id"], "chart")
            self.assertEqual(payload["title"], "Quarterly Revenue")
            self.assertEqual(
                artifacts.list_artifacts(artifact_root, hermes_home=hermes_home)[0]["title"],
                "Quarterly Revenue",
            )

    def test_rename_artifact_endpoint_rejects_blank_title(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            hermes_home = tmp / "hermes-home"
            artifact_root = hermes_home / "artifacts"
            write_artifact(artifact_root, "chart")

            client = TestClient(
                create_app(
                    HermelinConfig(
                        hermes_home=hermes_home,
                        meta_db_path=tmp / "hermelin_meta.db",
                        spawn_cwd=tmp / "spawn-cwd",
                        auth_password_hash="",
                        allowed_ips="*",
                    )
                )
            )

            response = client.post("/api/artifacts/chart/rename", json={"title": "   "})

            self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
