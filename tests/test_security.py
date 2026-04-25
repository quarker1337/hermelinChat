import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from hermelin.auth import create_session_token, extract_session_jti, verify_session_token
from hermelin.config import HermelinConfig
from hermelin.security import ip_allowed
from hermelin.server import create_app


def _route_for_path(app, path: str):
    for route in app.router.routes:
        if getattr(route, "path", "") == path:
            return route
    raise AssertionError(f"route not found: {path}")


class PathTraversalTests(unittest.TestCase):
    def test_path_traversal_blocked(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            static_dir = Path(tmpdir) / "static"
            static_dir.mkdir()
            index_html = static_dir / "index.html"
            index_html.write_text("<html>safe</html>", encoding="utf-8")

            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
            )
            # Patch static_dir on the config's class to point at our temp dir.
            # The server reads config.static_dir which is derived from the module
            # location, so we need to ensure our app uses our custom static_dir.
            # Instead, we build the app normally and rely on the server's own
            # static_dir handling. We need to create the app with a static dir
            # that has an index.html.
            #
            # The create_app function uses config.static_dir (which is the
            # hermelin/static folder). We'll create the index.html there
            # temporarily, but that would be fragile. Instead, we can test
            # the path traversal logic directly by calling the endpoint.

            app = create_app(config)
            route = _route_for_path(app, "/{path:path}")

            # Call with a path traversal attempt
            response = asyncio.run(route.endpoint(path="../../etc/passwd"))

            # The endpoint should return a FileResponse for index.html (the SPA
            # fallback), NOT the contents of /etc/passwd.
            # The .resolve().is_relative_to() check catches traversal and falls
            # back to index.html.
            from starlette.responses import FileResponse

            self.assertIsInstance(response, FileResponse)
            # The returned file should be the index.html, not /etc/passwd
            self.assertNotEqual(Path(response.path).name, "passwd")


class SessionTokenTests(unittest.TestCase):
    def test_session_token_roundtrip(self):
        secret = b"test-secret-key-for-roundtrip"
        token = create_session_token(secret=secret, ttl_seconds=300)
        result = verify_session_token(token=token, secret=secret)
        self.assertTrue(result)

    def test_expired_token_rejected(self):
        secret = b"test-secret-key-for-expiry"
        token = create_session_token(secret=secret, ttl_seconds=0)
        time.sleep(1)
        result = verify_session_token(token=token, secret=secret)
        self.assertFalse(result)

    def test_revoked_token_rejected(self):
        secret = b"test-secret-key-for-revoke"
        token = create_session_token(secret=secret, ttl_seconds=300)
        jti = extract_session_jti(token=token, secret=secret)
        self.assertIsNotNone(jti)

        revoked = {jti}
        result = verify_session_token(token=token, secret=secret, revoked_jtis=revoked)
        self.assertFalse(result)

    def test_wrong_secret_rejected(self):
        secret_a = b"secret-alpha"
        secret_b = b"secret-bravo"
        token = create_session_token(secret=secret_a, ttl_seconds=300)
        result = verify_session_token(token=token, secret=secret_b)
        self.assertFalse(result)


class IpAllowlistTests(unittest.TestCase):
    def test_ip_allowlist_blocks(self):
        self.assertFalse(ip_allowed("192.168.1.1", "10.0.0.0/8"))
        self.assertTrue(ip_allowed("10.0.0.1", "10.0.0.0/8"))
        self.assertTrue(ip_allowed("127.0.0.1", "*"))


class HealthEndpointTests(unittest.TestCase):
    def test_health_no_sensitive_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/health")
            response = asyncio.run(route.endpoint())

            self.assertIn("ok", response)
            for sensitive_key in ("hermes_home", "db_path", "allowed_ips", "cookie_name"):
                self.assertNotIn(sensitive_key, response)


class InfoEndpointTests(unittest.TestCase):
    def test_info_no_sensitive_fields(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/info")
            response = asyncio.run(route.endpoint())

            self.assertIn("spawn_cwd", response)
            self.assertIn("default_model", response)
            for sensitive_key in ("hermes_cmd", "artifact_dir"):
                self.assertNotIn(sensitive_key, response)


class _ExplodingAsyncClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, *args, **kwargs):
        raise RuntimeError("secret stack detail from /tmp/private/github-token")


class UpdateCheckEndpointTests(unittest.TestCase):
    def test_update_check_hides_exception_details(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/update-check")

            with patch("hermelin.server.httpx.AsyncClient", _ExplodingAsyncClient):
                response = asyncio.run(route.endpoint())

            self.assertEqual(response["error"], "Update check temporarily unavailable")
            self.assertNotIn("secret stack detail", response["error"])
            self.assertNotIn("/tmp/private", response["error"])
            self.assertFalse(response["cached"])


if __name__ == "__main__":
    unittest.main()
