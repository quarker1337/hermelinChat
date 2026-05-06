import json
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from fastapi.testclient import TestClient

from hermelin.artifacts import artifact_session_dir, list_artifacts
from hermelin.config import HermelinConfig
from hermelin.server import create_app


def write_session_artifact(root: Path, artifact_id: str = "transient") -> Path:
    target = artifact_session_dir(root) / f"{artifact_id}.json"
    target.write_text(
        json.dumps(
            {
                "id": artifact_id,
                "type": "markdown",
                "title": artifact_id,
                "timestamp": 1.0,
                "data": {"markdown": "keep me visible across browser connects"},
            }
        ),
        encoding="utf-8",
    )
    return target


class WebSocketArtifactCleanupTests(unittest.TestCase):
    def _make_client(self, tmp: Path) -> tuple[TestClient, Path, Path]:
        hermes_home = tmp / "hermes-home"
        artifact_root = hermes_home / "artifacts"
        config = HermelinConfig(
            hermes_home=hermes_home,
            meta_db_path=tmp / "hermelin_meta.db",
            spawn_cwd=tmp / "spawn-cwd",
            hermes_cmd=f'{sys.executable} -c "print(123)"',
            hermes_cmd_override=True,
            auth_password_hash="",
            allowed_ips="*",
        )
        return TestClient(create_app(config)), hermes_home, artifact_root

    def _connect_once(self, client: TestClient, path: str = "/ws/pty?cols=80&rows=24") -> None:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", ResourceWarning)
                with client.websocket_connect(path) as ws:
                    ws.send_text(json.dumps({"type": "resize", "cols": 80, "rows": 24}))
                    try:
                        ws.receive()
                    except Exception:
                        pass
        except Exception:
            # The fake PTY command exits immediately; the regression only cares
            # whether opening the websocket performed artifact cleanup.
            pass

    def test_new_websocket_connection_preserves_session_scoped_artifacts_by_default(self):
        with tempfile.TemporaryDirectory() as td:
            client, hermes_home, artifact_root = self._make_client(Path(td))
            target = write_session_artifact(artifact_root)

            self._connect_once(client)

            self.assertTrue(target.exists())
            self.assertEqual(
                [item["id"] for item in list_artifacts(artifact_root, hermes_home=hermes_home)],
                ["transient"],
            )


if __name__ == "__main__":
    unittest.main()
