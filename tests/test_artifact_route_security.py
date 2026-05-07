import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from hermelin.auth import create_runner_token
from hermelin.config import HermelinConfig
from hermelin.server import create_app


GENERATED_SECRET = "generated-content-must-not-be-public-6e3bf33c"
RUNNER_TAB_ID = "generated-runner"
COOKIE_SECRET = "artifact-route-security-cookie-secret"


def _write_generated_artifact(artifact_dir: Path, artifact_id: str = RUNNER_TAB_ID, secret: str = GENERATED_SECRET) -> None:
    session_dir = artifact_dir / "session"
    session_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": artifact_id,
        "type": "html",
        "title": "Generated secret artifact",
        "timestamp": 1713379200,
        "data": {
            "html": f"<main>{secret}</main>",
            "srcdoc": f"<script>window.__secret = {secret!r}</script>",
        },
    }
    (session_dir / f"{artifact_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def _write_runner_manifest(artifact_dir: Path, artifact_id: str = RUNNER_TAB_ID, port: int = 43123) -> None:
    project_dir = artifact_dir / "runners" / "projects" / artifact_id
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "runner.json").write_text(
        json.dumps({"scheme": "http", "host": "127.0.0.1", "port": port}),
        encoding="utf-8",
    )


def _auth_enabled_config(tmp: Path) -> HermelinConfig:
    return HermelinConfig(
        hermes_home=tmp / "hermes-home",
        meta_db_path=tmp / "hermelin_meta.db",
        spawn_cwd=tmp / "spawn-cwd",
        auth_password_hash="auth-enabled-without-cookie",
        cookie_secret=COOKIE_SECRET,
        allowed_ips="*",
        runner_token_bind_ip=False,
        hermes_dashboard_enabled=False,
    )


class ArtifactRouteSecurityTests(unittest.TestCase):
    def test_generated_content_api_surfaces_require_session_auth(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = _auth_enabled_config(tmp)
            _write_generated_artifact(config.artifact_dir)
            _write_runner_manifest(config.artifact_dir)
            client = TestClient(create_app(config))

            checks = [
                ("get", "/api/artifacts", None),
                ("get", "/api/artifacts/latest", None),
                ("get", "/api/default-artifacts/strudel/index.html", None),
                ("post", f"/api/runners/{RUNNER_TAB_ID}/token", None),
                (
                    "post",
                    "/api/artifacts/bridge/event",
                    {"artifact_id": RUNNER_TAB_ID, "channel": "test", "event": "ready", "payload": {}},
                ),
                ("post", f"/api/artifacts/{RUNNER_TAB_ID}/rename", {"title": "renamed"}),
                ("delete", f"/api/artifacts/{RUNNER_TAB_ID}", None),
                ("post", "/api/artifacts/clear-session", None),
            ]

            for method, path, payload in checks:
                request = getattr(client, method)
                response = request(path, json=payload) if payload is not None else request(path)
                with self.subTest(path=path):
                    self.assertEqual(response.status_code, 401)
                    self.assertNotIn(GENERATED_SECRET, response.text)

    def test_runner_proxy_rejects_missing_or_invalid_runner_token_without_leaking_content(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = _auth_enabled_config(tmp)
            _write_generated_artifact(config.artifact_dir)
            _write_runner_manifest(config.artifact_dir)
            client = TestClient(create_app(config))

            for path in (f"/r/{RUNNER_TAB_ID}/_t/", f"/r/{RUNNER_TAB_ID}/_t/not-a-valid-token"):
                response = client.get(path)
                with self.subTest(path=path):
                    self.assertEqual(response.status_code, 401)
                    self.assertNotIn(GENERATED_SECRET, response.text)

    def test_tokenized_runner_proxy_path_is_frameable_for_sandboxed_iframes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = _auth_enabled_config(tmp)
            _write_runner_manifest(config.artifact_dir)
            token = create_runner_token(
                secret=COOKIE_SECRET.encode("utf-8"),
                tab_id=RUNNER_TAB_ID,
                ttl_seconds=300,
            )
            client = TestClient(create_app(config))

            response = client.options(f"/r/{RUNNER_TAB_ID}/_t/{token}")

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers.get("x-frame-options"), "SAMEORIGIN")


if __name__ == "__main__":
    unittest.main()
