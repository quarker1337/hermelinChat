import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from hermelin.auth import create_session_token, extract_session_exp, extract_session_jti, hash_login_password, verify_session_token
from hermelin.config import HermelinConfig
from hermelin.security import ip_allowed
from hermelin.server import _github_release_tag_for_version, _is_update_available, create_app


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

    def test_session_token_exp_extracts_signed_expiration(self):
        secret = b"test-secret-key-for-exp"
        before = int(time.time())
        token = create_session_token(secret=secret, ttl_seconds=300)

        exp = extract_session_exp(token=token, secret=secret)

        self.assertIsNotNone(exp)
        exp_value = int(exp or 0)
        self.assertGreaterEqual(exp_value, before + 300)
        self.assertLessEqual(exp_value, int(time.time()) + 300)
        self.assertIsNone(extract_session_exp(token=token, secret=b"wrong-secret"))

    def test_wrong_secret_rejected(self):
        secret_a = b"secret-alpha"
        secret_b = b"secret-bravo"
        token = create_session_token(secret=secret_a, ttl_seconds=300)
        result = verify_session_token(token=token, secret=secret_b)
        self.assertFalse(result)

class AuthSessionCookieTests(unittest.TestCase):
    def test_auth_me_renews_valid_session_cookie(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = HermelinConfig(
                hermes_home=tmp / "hermes-home",
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                allowed_ips="*",
                auth_password_hash=hash_login_password("secret-password"),
                cookie_secret="stable-cookie-secret",
                session_ttl_seconds=300,
            )
            app = create_app(config)
            client = TestClient(app)

            login = client.post("/api/auth/login", json={"password": "secret-password"})
            self.assertEqual(login.status_code, 200)
            initial_cookie = client.cookies.get(config.cookie_name)
            self.assertTrue(initial_cookie)

            time.sleep(1)
            me = client.get("/api/auth/me")

            self.assertEqual(me.status_code, 200)
            self.assertEqual(me.json()["authenticated"], True)
            self.assertEqual(me.json()["session_ttl_seconds"], 300)
            set_cookie = me.headers.get("set-cookie", "")
            self.assertIn(f"{config.cookie_name}=", set_cookie)
            self.assertIn("Max-Age=300", set_cookie)
            renewed_cookie = client.cookies.get(config.cookie_name)
            self.assertNotEqual(renewed_cookie, initial_cookie)
            self.assertNotEqual(
                extract_session_jti(token=renewed_cookie, secret=config.cookie_secret.encode("utf-8")),
                extract_session_jti(token=initial_cookie, secret=config.cookie_secret.encode("utf-8")),
            )

            concurrent = TestClient(app).get("/api/health", cookies={config.cookie_name: initial_cookie})
            self.assertEqual(concurrent.status_code, 200)

            duplicate_rotation = TestClient(app).get("/api/auth/me", cookies={config.cookie_name: initial_cookie})
            self.assertEqual(duplicate_rotation.status_code, 200)
            self.assertEqual(duplicate_rotation.json()["authenticated"], True)
            self.assertNotIn("set-cookie", duplicate_rotation.headers)

            with patch("hermelin.server.time.monotonic", return_value=time.monotonic() + 11):
                expired_grace = TestClient(app).get("/api/auth/me", cookies={config.cookie_name: initial_cookie})
            self.assertEqual(expired_grace.status_code, 200)
            self.assertEqual(expired_grace.json()["authenticated"], False)
            self.assertNotIn("set-cookie", expired_grace.headers)

            logout = client.post("/api/auth/logout")
            self.assertEqual(logout.status_code, 200)
            replay = TestClient(app).get("/api/auth/me", cookies={config.cookie_name: initial_cookie})
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(replay.json()["authenticated"], False)
            self.assertNotIn("set-cookie", replay.headers)

            renewed_replay = TestClient(app).get("/api/auth/me", cookies={config.cookie_name: renewed_cookie})
            self.assertEqual(renewed_replay.status_code, 200)
            self.assertEqual(renewed_replay.json()["authenticated"], False)
            self.assertNotIn("set-cookie", renewed_replay.headers)

    def test_auth_me_does_not_renew_expired_cookie(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = HermelinConfig(
                hermes_home=tmp / "hermes-home",
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                allowed_ips="*",
                auth_password_hash=hash_login_password("secret-password"),
                cookie_secret="stable-cookie-secret",
                session_ttl_seconds=300,
            )
            client = TestClient(create_app(config))
            expired = create_session_token(secret=config.cookie_secret.encode("utf-8"), ttl_seconds=0)

            me = client.get("/api/auth/me", cookies={config.cookie_name: expired})

            self.assertEqual(me.status_code, 200)
            self.assertEqual(me.json()["authenticated"], False)
            self.assertNotIn("set-cookie", me.headers)


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
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, *args, **kwargs):
        raise RuntimeError("secret stack detail from /tmp/private/github-token")


class _StaticStatusResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code

    def json(self):
        return {}


class _JsonStatusResponse(_StaticStatusResponse):
    def __init__(self, status_code: int, payload: dict):
        super().__init__(status_code)
        self._payload = payload

    def json(self):
        return self._payload


class _GitHubUpdateAsyncClient:
    calls = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, *args, **kwargs):
        type(self).calls.append(url)
        if url.endswith("/releases/latest"):
            return _JsonStatusResponse(200, {"tag_name": "v0.15"})
        if url.endswith("/compare/v0.14...main"):
            return _JsonStatusResponse(
                200,
                {
                    "ahead_by": 42,
                    "html_url": "https://github.com/quarker1337/hermelinChat/compare/v0.14...main",
                },
            )
        return _StaticStatusResponse(404)


class _Http503AsyncClient:
    calls = 0

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, *args, **kwargs):
        type(self).calls += 1
        return _StaticStatusResponse(503)


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
            self.assertIsNone(response["commits_behind_main"])

    def test_update_check_reports_commits_behind_main(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/update-check")
            _GitHubUpdateAsyncClient.calls = []

            with (
                patch("hermelin.__version__", "0.14"),
                patch("hermelin.server.httpx.AsyncClient", _GitHubUpdateAsyncClient),
            ):
                response = asyncio.run(route.endpoint())

            self.assertEqual(response["latest"], "0.15")
            self.assertTrue(response["update_available"])
            self.assertEqual(response["commits_behind_main"], 42)
            self.assertEqual(
                response["compare_url"],
                "https://github.com/quarker1337/hermelinChat/compare/v0.14...main",
            )
            self.assertEqual(len(_GitHubUpdateAsyncClient.calls), 2)
            self.assertTrue(_GitHubUpdateAsyncClient.calls[0].endswith("/releases/latest"))
            self.assertTrue(_GitHubUpdateAsyncClient.calls[1].endswith("/compare/v0.14...main"))

    def test_update_check_caches_failures_for_backoff(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/update-check")
            _Http503AsyncClient.calls = 0

            with patch("hermelin.server.httpx.AsyncClient", _Http503AsyncClient):
                first = asyncio.run(route.endpoint())
                second = asyncio.run(route.endpoint())

            self.assertEqual(_Http503AsyncClient.calls, 1)
            self.assertEqual(first["error"], "GitHub API returned 503")
            self.assertFalse(first["cached"])
            self.assertEqual(second["error"], "GitHub API returned 503")
            self.assertTrue(second["cached"])
            self.assertFalse(second["update_available"])


class UpdateCheckVersionComparisonTests(unittest.TestCase):
    def test_update_check_compares_versions_semantically(self):
        self.assertTrue(_is_update_available("0.14", "0.15"))
        self.assertTrue(_is_update_available("0.14.dev1", "0.14"))
        self.assertFalse(_is_update_available("0.15.dev1", "0.14"))
        self.assertFalse(_is_update_available("0.14+local", "0.14"))

    def test_update_check_builds_safe_github_compare_tags(self):
        self.assertEqual(_github_release_tag_for_version("0.14"), "v0.14")
        self.assertEqual(_github_release_tag_for_version("v0.14+local"), "v0.14")
        self.assertIsNone(_github_release_tag_for_version("../../main"))
        self.assertIsNone(_github_release_tag_for_version("0.14/foo"))


if __name__ == "__main__":
    unittest.main()
