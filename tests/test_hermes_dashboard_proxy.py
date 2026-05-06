import asyncio
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hermelin.config import HermelinConfig
from hermelin.runners import discover_runner_upstream
from hermelin.dashboard_proxy import websockets_connect_kwargs
from hermelin.server import create_app


DASHBOARD_BASE_PATH = "/api/runners/hermes-dashboard"


def _route_for_path(app, path: str):
    for route in app.router.routes:
        if getattr(route, "path", "") == path:
            return route
    raise AssertionError(f"route not found: {path}")


class HermesDashboardManagerTests(unittest.TestCase):
    def test_dashboard_command_uses_secure_loopback_flags_and_base_path_when_supported(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        cases = (
            (True, True),
            (False, False),
        )
        for supported, expects_base_path in cases:
            with self.subTest(base_path_supported=supported), tempfile.TemporaryDirectory() as tmpdir:
                manager = HermesDashboardManager(
                    hermes_command="/usr/bin/hermes",
                    hermes_home=Path(tmpdir) / "home",
                    cwd=Path(tmpdir),
                    port=45678,
                    base_path=DASHBOARD_BASE_PATH,
                )
                manager._base_path_supported = supported

                command = manager.build_command(45678)

                self.assertEqual(command[:2], ["/usr/bin/hermes", "dashboard"])
                self.assertEqual(command[command.index("--host") + 1], "127.0.0.1")
                self.assertEqual(command[command.index("--port") + 1], "45678")
                self.assertIn("--no-open", command)
                self.assertNotIn("--insecure", command)
                if expects_base_path:
                    self.assertEqual(command[command.index("--base-path") + 1], DASHBOARD_BASE_PATH)
                else:
                    self.assertNotIn("--base-path", command)
                    self.assertNotIn(DASHBOARD_BASE_PATH, command)

    def test_dashboard_command_normalizes_full_hermes_command_overrides(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        cases = (
            ('hermes chat --toolsets "hermes-cli, artifacts"', ["hermes", "dashboard"]),
            ("hermes dashboard --tui", ["hermes", "dashboard"]),
            ("uv run hermes chat --toolsets hermes-cli,artifacts", ["uv", "run", "hermes", "dashboard"]),
            ("uv run hermes dashboard --tui", ["uv", "run", "hermes", "dashboard"]),
        )
        for hermes_command, expected_prefix in cases:
            with self.subTest(hermes_command=hermes_command), tempfile.TemporaryDirectory() as tmpdir:
                manager = HermesDashboardManager(
                    hermes_command=hermes_command,
                    hermes_home=Path(tmpdir) / "home",
                    cwd=Path(tmpdir),
                    port=45678,
                    base_path=DASHBOARD_BASE_PATH,
                )

                command = manager.build_command(45678)

                self.assertEqual(command[: len(expected_prefix)], expected_prefix)
                self.assertEqual(command.count("dashboard"), 1)
                self.assertNotIn("chat", command)
                self.assertNotIn("--toolsets", command)
                self.assertEqual(command[command.index("--host") + 1], "127.0.0.1")
                self.assertEqual(command[command.index("--port") + 1], "45678")
                self.assertIn("--no-open", command)
                self.assertNotIn("--insecure", command)

    def test_dashboard_body_rewriter_scopes_spa_assets_api_and_router(self):
        from hermelin.hermes_dashboard import rewrite_dashboard_body

        html = b'''<!doctype html><html><head><script type="module" src="/assets/app.js"></script><link href="/assets/app.css"></head><body></body></html>'''
        rewritten_html = rewrite_dashboard_body(html, content_type="text/html", base_path=DASHBOARD_BASE_PATH).decode()

        self.assertIn('window.__HERMES_BASE_PATH__="/api/runners/hermes-dashboard"', rewritten_html)
        self.assertIn('src="/api/runners/hermes-dashboard/assets/app.js"', rewritten_html)
        self.assertIn('href="/api/runners/hermes-dashboard/assets/app.css"', rewritten_html)

        js = b'''const bk="";B5.createRoot(document.getElementById("root")).render(u.jsx(i3,{children:u.jsx(App,{})}));new WebSocket(`${n}//${location.host}/api/ws?token=x`);new WebSocket(`${H}//${window.location.host}/api/events?x`);return `${n}//${window.location.host}/api/pty?${q}`;'''
        rewritten_js = rewrite_dashboard_body(js, content_type="application/javascript", base_path=DASHBOARD_BASE_PATH).decode()

        self.assertIn('const bk=window.__HERMES_BASE_PATH__||""', rewritten_js)
        self.assertIn('basename:window.__HERMES_BASE_PATH__||""', rewritten_js)
        self.assertIn('${location.host}${window.__HERMES_BASE_PATH__||""}/api/ws?', rewritten_js)
        self.assertIn('${window.location.host}${window.__HERMES_BASE_PATH__||""}/api/events?', rewritten_js)
        self.assertIn('${window.location.host}${window.__HERMES_BASE_PATH__||""}/api/pty?', rewritten_js)

    def test_dashboard_base_path_probe_creates_missing_cwd(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake = root / "fake-hermes"
            fake.write_text("#!/usr/bin/env python3\nprint('usage: hermes dashboard --base-path PATH')\n", encoding="utf-8")
            fake.chmod(0o755)
            missing_cwd = root / "missing" / "cwd"
            manager = HermesDashboardManager(
                hermes_command=str(fake),
                hermes_home=root / "home",
                cwd=missing_cwd,
                port=45678,
                base_path=DASHBOARD_BASE_PATH,
            )

            supported = asyncio.run(manager.base_path_supported())
            cwd_exists = missing_cwd.exists()
            last_error = manager.status()["last_error"]

        self.assertTrue(supported)
        self.assertTrue(cwd_exists)
        self.assertEqual(last_error, "")

    def test_dashboard_stop_prevents_proxy_auto_restart_until_explicit_start(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            manager = HermesDashboardManager(
                hermes_command=str(root / "missing-hermes"),
                hermes_home=root / "home",
                cwd=root / "cwd",
                port=45678,
                base_path=DASHBOARD_BASE_PATH,
            )

            stopped = asyncio.run(manager.stop())
            auto_started = asyncio.run(manager.ensure_started())

        self.assertFalse(stopped["running"])
        self.assertTrue(stopped["stopped_by_user"])
        self.assertFalse(auto_started["running"])
        self.assertTrue(auto_started["stopped_by_user"])
        self.assertEqual(auto_started["last_error"], "")

    def test_dashboard_start_and_restart_report_configured_port_already_in_use_without_spawning(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        for action in ("start", "restart"):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as blocker:
                    blocker.bind(("127.0.0.1", 0))
                    blocker.listen(1)
                    blocked_port = int(blocker.getsockname()[1])

                    manager = HermesDashboardManager(
                        hermes_command=str(root / "missing-hermes"),
                        hermes_home=root / "home",
                        cwd=root / "cwd",
                        port=blocked_port,
                        base_path=DASHBOARD_BASE_PATH,
                    )
                    manager._base_path_supported = True

                    with patch("hermelin.hermes_dashboard.subprocess.Popen") as popen:
                        status = asyncio.run(getattr(manager, action)())

                popen.assert_not_called()
                self.assertFalse(status["running"])
                self.assertEqual(status["last_error_code"], "port_in_use")
                self.assertIn("already in use", status["last_error"])

    def test_dashboard_stop_reports_foreign_process_still_blocking_configured_port(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as blocker:
                blocker.bind(("127.0.0.1", 0))
                blocker.listen(1)
                blocked_port = int(blocker.getsockname()[1])

                manager = HermesDashboardManager(
                    hermes_command=str(root / "missing-hermes"),
                    hermes_home=root / "home",
                    cwd=root / "cwd",
                    port=blocked_port,
                    base_path=DASHBOARD_BASE_PATH,
                )

                status = asyncio.run(manager.stop())

        self.assertFalse(status["running"])
        self.assertTrue(status["stopped_by_user"])
        self.assertEqual(status["last_error_code"], "port_still_in_use")
        self.assertIn("still in use", status["last_error"])

    def test_dashboard_rewrites_upstream_locations_to_proxy_prefix(self):
        from hermelin.hermes_dashboard import rewrite_prefixed_location

        self.assertEqual(
            rewrite_prefixed_location("/sessions", base_path=DASHBOARD_BASE_PATH, upstream_port=45678),
            f"{DASHBOARD_BASE_PATH}/sessions",
        )
        self.assertEqual(
            rewrite_prefixed_location(
                "http://127.0.0.1:45678/api/status?x=1",
                base_path=DASHBOARD_BASE_PATH,
                upstream_port=45678,
            ),
            f"{DASHBOARD_BASE_PATH}/api/status?x=1",
        )
        self.assertEqual(
            rewrite_prefixed_location("https://example.com/oauth", base_path=DASHBOARD_BASE_PATH, upstream_port=45678),
            "https://example.com/oauth",
        )

    def test_dashboard_start_reports_missing_native_dashboard_frontend_from_log(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fake = root / "fake-hermes"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "print('Web UI frontend not built and npm is not available.')\n"
                "print('Install Node.js, then run:  cd web && npm install && npm run build')\n"
                "sys.exit(1)\n",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            manager = HermesDashboardManager(
                hermes_command=str(fake),
                hermes_home=root / "home",
                cwd=root / "cwd",
                port=45678,
                base_path=DASHBOARD_BASE_PATH,
                startup_timeout_seconds=1,
            )

            status = asyncio.run(manager.start())

        self.assertFalse(status["running"])
        self.assertEqual(status["last_error_code"], "frontend_not_built")
        self.assertIn("frontend is not built", status["last_error"])


class HermesDashboardReservedRunnerTests(unittest.TestCase):
    def test_reserved_dashboard_runner_id_does_not_resolve_artifact_manifest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_dir = Path(tmpdir) / "artifacts"
            project_dir = artifact_dir / "runners" / "projects" / "hermes-dashboard"
            project_dir.mkdir(parents=True)
            (project_dir / "runner.json").write_text(
                json.dumps({"scheme": "http", "host": "127.0.0.1", "port": 45678}),
                encoding="utf-8",
            )

            upstream = discover_runner_upstream(artifact_dir, "hermes-dashboard")

        self.assertIsNone(upstream)


class _FakeDashboardManager:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.started = False
        self.stopped_by_user = False
        self.start_count = 0
        _FakeDashboardManager.instances.append(self)

    def status(self):
        return {
            "ok": True,
            "enabled": True,
            "running": self.started,
            "base_path": self.kwargs.get("base_path"),
            "proxy_path": self.kwargs.get("base_path"),
            "host": "127.0.0.1",
            "port": 45678,
            "stopped_by_user": self.stopped_by_user,
            "last_error": "",
        }

    async def start(self):
        self.started = True
        self.stopped_by_user = False
        self.start_count += 1
        return self.status()

    async def restart(self):
        self.started = True
        self.stopped_by_user = False
        self.start_count += 1
        return self.status()

    async def stop(self):
        self.started = False
        self.stopped_by_user = True
        return self.status()

    async def ensure_started(self):
        if not self.started and not self.stopped_by_user:
            return await self.start()
        return self.status()

    def upstream(self):
        return ("http", "127.0.0.1", 45678) if self.started else None

    async def aclose(self):
        self.started = False


class _LeakyDashboardManager(_FakeDashboardManager):
    secret = "secret stack detail from /tmp/private/hermes-token"

    def status(self):
        data = super().status()
        data["running"] = False
        data["last_error"] = self.secret
        return data

    async def start(self):
        self.start_count += 1
        return self.status()

    async def restart(self):
        self.start_count += 1
        return self.status()

    async def ensure_started(self):
        return self.status()

    def upstream(self):
        return None


class _PortBusyDashboardManager(_LeakyDashboardManager):
    def status(self):
        data = super().status()
        data["last_error_code"] = "port_in_use"
        return data


class _FrontendMissingDashboardManager(_LeakyDashboardManager):
    def status(self):
        data = super().status()
        data["last_error_code"] = "frontend_not_built"
        return data


class _CaptureDashboardHttpClient:
    def __init__(self, response=None):
        self.requests = []
        self.response = response or _FakeDashboardUpstreamResponse()

    def build_request(self, *, method, url, headers, content):
        captured = {
            "method": method,
            "url": str(url),
            "headers": dict(headers),
            "content": content,
        }
        self.requests.append(captured)
        return httpx.Request(method, url, headers=headers, content=content)

    async def send(self, request, stream=False):
        return self.response


class _FakeDashboardUpstreamResponse:
    def __init__(self, status_code=204, headers=None, body=b""):
        self.status_code = status_code
        self.headers = httpx.Headers(headers or {"content-type": "application/octet-stream"})
        self.body = body

    async def aiter_raw(self):
        if self.body:
            yield self.body

    async def aread(self):
        return self.body

    async def aclose(self):
        return None


class _FakeDashboardWebSocketUpstream:
    def __init__(self):
        self.closed = False
        self.sent_messages = []
        self._messages = ["upstream-ok"]
        self._closed = asyncio.Event()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.close()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._messages:
            return self._messages.pop(0)
        await self._closed.wait()
        raise StopAsyncIteration

    async def send(self, message):
        self.sent_messages.append(message)

    async def close(self):
        self.closed = True
        self._closed.set()


async def _asgi_request(app, method: str, path: str, *, base_url: str = "https://chat.example", **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
        return await client.request(method, path, **kwargs)


def _dashboard_config(tmpdir: str, **overrides) -> HermelinConfig:
    root = Path(tmpdir)
    values = {
        "hermes_home": root / "hermes-home",
        "meta_db_path": root / "hermelin_meta.db",
        "spawn_cwd": root / "spawn-cwd",
        "hermes_dashboard_base_path": DASHBOARD_BASE_PATH,
    }
    values.update(overrides)
    return HermelinConfig(**values)


def _create_dashboard_app(tmpdir: str, manager_cls=_FakeDashboardManager, **config_overrides):
    _FakeDashboardManager.instances = []
    with patch("hermelin.server.HermesDashboardManager", manager_cls):
        return create_app(_dashboard_config(tmpdir, **config_overrides))


class HermesDashboardEndpointTests(unittest.TestCase):
    def test_dashboard_status_and_control_endpoints_use_managed_service(self):
        endpoint_cases = (
            ("GET", "/api/hermes-dashboard/status", False),
            ("POST", "/api/hermes-dashboard/start", True),
            ("POST", "/api/hermes-dashboard/restart", True),
            ("POST", "/api/hermes-dashboard/stop", False),
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)

            for _, path, _ in endpoint_cases:
                _route_for_path(app, path)
            proxy_route = _route_for_path(app, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

            for method, path, expected_running in endpoint_cases:
                with self.subTest(method=method, path=path):
                    response = asyncio.run(_asgi_request(app, method, path))
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["running"], expected_running)

        self.assertEqual(_FakeDashboardManager.instances[0].kwargs["base_path"], DASHBOARD_BASE_PATH)
        self.assertEqual(proxy_route.path, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

    def test_dashboard_public_endpoints_do_not_expose_manager_error_details(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir, _LeakyDashboardManager)

            status = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status"))
            started = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/start"))
            restarted = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/restart"))
            proxied = asyncio.run(_asgi_request(app, "GET", f"{DASHBOARD_BASE_PATH}/api/status"))

        for response in (status, started, restarted, proxied):
            body = response.text
            self.assertNotIn(_LeakyDashboardManager.secret, body)
            self.assertNotIn("/tmp/private", body)
            self.assertNotIn("stack detail", body)

        self.assertEqual(status.status_code, 200)
        self.assertEqual(started.status_code, 200)
        self.assertEqual(restarted.status_code, 200)
        self.assertEqual(proxied.status_code, 503)
        self.assertEqual(
            status.json()["last_error"],
            "Hermes dashboard unavailable. Check hermelinChat server logs for details.",
        )
        self.assertEqual(
            proxied.json()["detail"],
            "Hermes dashboard unavailable. Check hermelinChat server logs for details.",
        )

    def test_dashboard_public_status_reports_port_conflict_without_raw_details(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir, _PortBusyDashboardManager)

            response = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/start"))

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertFalse(body["running"])
        self.assertEqual(body["last_error_code"], "port_in_use")
        self.assertIn("port is already in use", body["last_error"])
        self.assertNotIn(_LeakyDashboardManager.secret, response.text)
        self.assertNotIn("/tmp/private", response.text)

    def test_dashboard_public_status_reports_missing_native_frontend_without_raw_details(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir, _FrontendMissingDashboardManager)

            response = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/start"))

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertFalse(body["running"])
        self.assertEqual(body["last_error_code"], "frontend_not_built")
        self.assertIn("dashboard frontend is not built", body["last_error"])
        self.assertIn("hermes update", body["last_error"])
        self.assertNotIn(_LeakyDashboardManager.secret, response.text)
        self.assertNotIn("/tmp/private", response.text)

    def test_dashboard_public_status_does_not_expose_process_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)

            response = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status"))

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("host", body)
        self.assertNotIn("port", body)
        self.assertNotIn("pid", body)

    def test_dashboard_theme_sync_errors_do_not_expose_exception_details(self):
        secret = "secret stack detail from /tmp/private/dashboard-theme"
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)

            with patch("hermelin.dashboard_proxy.logger"):
                with patch("hermelin.dashboard_proxy.sync_dashboard_theme_for_ui_theme", side_effect=RuntimeError(secret)):
                    response = asyncio.run(
                        _asgi_request(app, "POST", "/api/hermes-dashboard/theme", json={"ui_theme": "matrix"})
                    )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "failed to sync dashboard theme")
        self.assertNotIn(secret, response.text)
        self.assertNotIn("/tmp/private", response.text)

    def test_dashboard_proxy_routes_honor_safe_custom_base_path(self):
        custom_base_path = "/api/hermes-dashboard-frame"
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir, hermes_dashboard_base_path=custom_base_path)

            proxy_route = _route_for_path(app, f"{custom_base_path}" + "/{path:path}")

        self.assertEqual(_FakeDashboardManager.instances[0].kwargs["base_path"], custom_base_path)
        self.assertEqual(proxy_route.path, f"{custom_base_path}" + "/{path:path}")

    def test_dashboard_proxy_ignores_unsafe_custom_base_path(self):
        unsafe_paths = (
            "/public-dashboard",
            "/api/auth/dashboard",
            "/api/default-artifacts/dashboard",
            "/api/hermes-dashboard/frame",
            "/api/runners/hermes-dashboard/../auth/dashboard",
            "/api/runners/hermes-dashboard/./status",
            "/api/runners//hermes-dashboard",
            "/api/runners/hermes-dashboard%2fapi%2fauth",
            "/api/runners/hermes-dashboard/%2e%2e/auth",
            "/api/runners/hermes-dashboard/%252e%252e/auth",
            "/api/runners/hermes-dashboard?x=1",
        )
        for unsafe_path in unsafe_paths:
            with self.subTest(unsafe_path=unsafe_path), tempfile.TemporaryDirectory() as tmpdir:
                with patch("hermelin.dashboard_proxy.logger"):
                    app = _create_dashboard_app(tmpdir, hermes_dashboard_base_path=unsafe_path)

                proxy_route = _route_for_path(app, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

            self.assertEqual(_FakeDashboardManager.instances[0].kwargs["base_path"], DASHBOARD_BASE_PATH)
            self.assertEqual(proxy_route.path, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

    def test_dashboard_proxy_strips_spoofed_forwarded_headers(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)
            capture_client = _CaptureDashboardHttpClient()
            app.state.httpx_client = capture_client

            response = asyncio.run(
                _asgi_request(
                    app,
                    "GET",
                    f"{DASHBOARD_BASE_PATH}/api/status",
                    headers={
                        "X-Forwarded-Host": "evil.example",
                        "X-Forwarded-Proto": "http",
                        "X-Forwarded-Prefix": "/api/auth",
                        "X-Forwarded-For": "203.0.113.7",
                        "Forwarded": "for=203.0.113.7;host=evil.example;proto=http",
                        "X-Real-IP": "203.0.113.7",
                        "Cookie": "hermelin_session=leak-me-not",
                        "Authorization": "Bearer leak-me-not",
                        "X-Hermes-Session-Token": "dashboard-session-token",
                    },
                )
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(len(capture_client.requests), 1)
        headers = {k.lower(): v for k, v in capture_client.requests[0]["headers"].items()}
        self.assertEqual(headers.get("x-forwarded-host"), "chat.example")
        self.assertEqual(headers.get("x-forwarded-proto"), "https")
        self.assertEqual(headers.get("x-forwarded-prefix"), DASHBOARD_BASE_PATH)
        self.assertEqual(headers.get("x-hermes-session-token"), "dashboard-session-token")
        self.assertNotIn("x-forwarded-for", headers)
        self.assertNotIn("forwarded", headers)
        self.assertNotIn("x-real-ip", headers)
        self.assertNotIn("cookie", headers)
        self.assertNotIn("authorization", headers)

    def test_dashboard_proxy_strips_cors_request_and_response_headers(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)
            capture_client = _CaptureDashboardHttpClient(
                response=_FakeDashboardUpstreamResponse(
                    headers={
                        "content-type": "application/octet-stream",
                        "access-control-allow-origin": "https://evil.example",
                        "access-control-allow-credentials": "true",
                        "access-control-expose-headers": "X-Secret-Dashboard-Header",
                        "timing-allow-origin": "*",
                    }
                )
            )
            app.state.httpx_client = capture_client

            response = asyncio.run(
                _asgi_request(
                    app,
                    "GET",
                    f"{DASHBOARD_BASE_PATH}/api/status",
                    headers={
                        "Origin": "https://chat.example",
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "X-Hermes-Session-Token",
                    },
                )
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(len(capture_client.requests), 1)
        upstream_headers = {k.lower(): v for k, v in capture_client.requests[0]["headers"].items()}
        response_headers = {k.lower(): v for k, v in response.headers.items()}
        self.assertNotIn("origin", upstream_headers)
        self.assertNotIn("access-control-request-method", upstream_headers)
        self.assertNotIn("access-control-request-headers", upstream_headers)
        self.assertNotIn("access-control-allow-origin", response_headers)
        self.assertNotIn("access-control-allow-credentials", response_headers)
        self.assertNotIn("access-control-expose-headers", response_headers)
        self.assertNotIn("timing-allow-origin", response_headers)

    def test_dashboard_http_endpoints_reject_cross_site_origin_before_starting_dashboard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)
            capture_client = _CaptureDashboardHttpClient()
            app.state.httpx_client = capture_client

            cross_site_start = asyncio.run(
                _asgi_request(app, "POST", "/api/hermes-dashboard/start", headers={"Origin": "https://evil.example"})
            )
            cross_site_proxy = asyncio.run(
                _asgi_request(
                    app,
                    "GET",
                    f"{DASHBOARD_BASE_PATH}/api/status",
                    headers={"Origin": "https://evil.example"},
                )
            )
            same_origin_status = asyncio.run(
                _asgi_request(app, "GET", "/api/hermes-dashboard/status", headers={"Origin": "https://chat.example"})
            )
            missing_origin_status = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status"))
            manager = _FakeDashboardManager.instances[0]

        self.assertEqual(cross_site_start.status_code, 403)
        self.assertEqual(cross_site_proxy.status_code, 403)
        self.assertEqual(same_origin_status.status_code, 200)
        self.assertEqual(missing_origin_status.status_code, 200)
        self.assertFalse(manager.started)
        self.assertEqual(manager.start_count, 0)
        self.assertEqual(capture_client.requests, [])

    def test_dashboard_http_origin_accepts_trusted_forwarded_https_proto(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(
                tmpdir,
                allowed_ips="*",
                trust_x_forwarded_for=True,
                trusted_proxy_ips="127.0.0.1",
            )
            capture_client = _CaptureDashboardHttpClient()
            app.state.httpx_client = capture_client

            response = asyncio.run(
                _asgi_request(
                    app,
                    "GET",
                    f"{DASHBOARD_BASE_PATH}/api/status",
                    base_url="http://chat.example",
                    headers={"Origin": "https://chat.example", "X-Forwarded-Proto": "https"},
                )
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(len(capture_client.requests), 1)
        headers = {k.lower(): v for k, v in capture_client.requests[0]["headers"].items()}
        self.assertEqual(headers.get("x-forwarded-proto"), "https")

    def test_dashboard_http_origin_ignores_untrusted_forwarded_https_proto(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(
                tmpdir,
                allowed_ips="*",
                trust_x_forwarded_for=True,
                trusted_proxy_ips="10.0.0.1",
            )
            capture_client = _CaptureDashboardHttpClient()
            app.state.httpx_client = capture_client

            response = asyncio.run(
                _asgi_request(
                    app,
                    "GET",
                    f"{DASHBOARD_BASE_PATH}/api/status",
                    base_url="http://chat.example",
                    headers={"Origin": "https://chat.example", "X-Forwarded-Proto": "https"},
                )
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(capture_client.requests, [])

    def test_dashboard_websocket_origin_accepts_trusted_forwarded_https_proto(self):
        captured_connects = []

        def fake_connect(*args, **kwargs):
            captured_connects.append({"args": args, "kwargs": kwargs})
            return _FakeDashboardWebSocketUpstream()

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("hermelin.dashboard_proxy.websockets.connect", fake_connect):
                app = _create_dashboard_app(tmpdir, allowed_ips="*", trust_x_forwarded_for=True)
                with TestClient(app, base_url="http://chat.example") as client:
                    with client.websocket_connect(
                        f"{DASHBOARD_BASE_PATH}/api/ws",
                        headers={"Host": "chat.example", "Origin": "https://chat.example", "X-Forwarded-Proto": "https"},
                    ) as ws:
                        self.assertEqual(ws.receive_text(), "upstream-ok")
                manager = _FakeDashboardManager.instances[0]

        self.assertEqual(manager.start_count, 1)
        self.assertEqual(len(captured_connects), 1)
        forwarded_headers = next(
            value
            for key, value in captured_connects[0]["kwargs"].items()
            if key in {"additional_headers", "extra_headers"}
        )
        self.assertEqual(forwarded_headers["X-Forwarded-Proto"], "https")

    def test_dashboard_websocket_rejects_cross_site_origin_before_starting_dashboard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir, allowed_ips="*")

            with TestClient(app, base_url="https://chat.example") as client:
                with self.assertRaises(WebSocketDisconnect) as cm:
                    with client.websocket_connect(
                        f"{DASHBOARD_BASE_PATH}/api/ws", headers={"Origin": "https://evil.example"}
                    ) as ws:
                        ws.receive_text()
            manager = _FakeDashboardManager.instances[0]

        self.assertEqual(cm.exception.code, 1008)
        self.assertFalse(manager.started)
        self.assertEqual(manager.start_count, 0)

    def test_dashboard_proxy_does_not_auto_restart_after_stop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(tmpdir)
            capture_client = _CaptureDashboardHttpClient()
            app.state.httpx_client = capture_client

            started = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/start"))
            stopped = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/stop"))
            stale_iframe_response = asyncio.run(_asgi_request(app, "GET", f"{DASHBOARD_BASE_PATH}/api/status"))
            manager = _FakeDashboardManager.instances[0]

        self.assertEqual(started.status_code, 200)
        self.assertTrue(started.json()["running"])
        self.assertEqual(stopped.status_code, 200)
        self.assertFalse(stopped.json()["running"])
        self.assertEqual(stale_iframe_response.status_code, 503)
        self.assertEqual(manager.start_count, 1)
        self.assertEqual(capture_client.requests, [])

    def test_dashboard_http_endpoints_require_auth_when_password_enabled(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = _create_dashboard_app(
                tmpdir,
                auth_password_hash="auth-enabled-without-cookie",
                cookie_secret="test-cookie-secret",
            )

            status_response = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status"))
            proxy_response = asyncio.run(_asgi_request(app, "GET", f"{DASHBOARD_BASE_PATH}/"))

        self.assertEqual(status_response.status_code, 401)
        self.assertEqual(proxy_response.status_code, 401)
        self.assertFalse(_FakeDashboardManager.instances[0].started)

    def test_dashboard_websocket_header_kwargs_support_installed_websockets(self):
        kwargs = websockets_connect_kwargs(
            subprotocols=["chat"],
            extra_headers={"X-Forwarded-Prefix": DASHBOARD_BASE_PATH},
        )

        self.assertEqual(kwargs["subprotocols"], ["chat"])
        self.assertTrue("additional_headers" in kwargs or "extra_headers" in kwargs)
        self.assertIn({"X-Forwarded-Prefix": DASHBOARD_BASE_PATH}, kwargs.values())


if __name__ == "__main__":
    unittest.main()
