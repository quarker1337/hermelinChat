import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hermelin.config import HermelinConfig
from hermelin.runners import discover_runner_upstream
from hermelin.server import _websockets_connect_kwargs, create_app


DASHBOARD_BASE_PATH = "/api/runners/hermes-dashboard"


def _route_for_path(app, path: str):
    for route in app.router.routes:
        if getattr(route, "path", "") == path:
            return route
    raise AssertionError(f"route not found: {path}")


class HermesDashboardManagerTests(unittest.TestCase):
    def test_dashboard_command_uses_loopback_base_path_and_no_insecure_flag(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        with tempfile.TemporaryDirectory() as tmpdir:
            manager = HermesDashboardManager(
                hermes_command="/usr/bin/hermes",
                hermes_home=Path(tmpdir) / "home",
                cwd=Path(tmpdir),
                port=45678,
                base_path=DASHBOARD_BASE_PATH,
            )

            manager._base_path_supported = True
            command = manager.build_command(45678)

        self.assertEqual(command[:2], ["/usr/bin/hermes", "dashboard"])
        self.assertIn("--host", command)
        self.assertEqual(command[command.index("--host") + 1], "127.0.0.1")
        self.assertIn("--port", command)
        self.assertEqual(command[command.index("--port") + 1], "45678")
        self.assertIn("--no-open", command)
        self.assertIn("--base-path", command)
        self.assertEqual(command[command.index("--base-path") + 1], DASHBOARD_BASE_PATH)
        self.assertNotIn("--insecure", command)

    def test_dashboard_command_omits_base_path_flag_for_older_hermes(self):
        from hermelin.hermes_dashboard import HermesDashboardManager

        with tempfile.TemporaryDirectory() as tmpdir:
            manager = HermesDashboardManager(
                hermes_command="/usr/bin/hermes",
                hermes_home=Path(tmpdir) / "home",
                cwd=Path(tmpdir),
                port=45678,
                base_path=DASHBOARD_BASE_PATH,
            )
            manager._base_path_supported = False

            command = manager.build_command(45678)

        self.assertIn("--host", command)
        self.assertIn("--no-open", command)
        self.assertNotIn("--base-path", command)
        self.assertNotIn(DASHBOARD_BASE_PATH, command)

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


async def _asgi_request(app, method: str, path: str, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://chat.example") as client:
        return await client.request(method, path, **kwargs)


class HermesDashboardEndpointTests(unittest.TestCase):
    def test_dashboard_status_and_control_endpoints_use_managed_service(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

            status_route = _route_for_path(app, "/api/hermes-dashboard/status")
            start_route = _route_for_path(app, "/api/hermes-dashboard/start")
            restart_route = _route_for_path(app, "/api/hermes-dashboard/restart")
            stop_route = _route_for_path(app, "/api/hermes-dashboard/stop")
            proxy_route = _route_for_path(app, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

            status = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status")).json()
            started = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/start")).json()
            restarted = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/restart")).json()
            stopped = asyncio.run(_asgi_request(app, "POST", "/api/hermes-dashboard/stop")).json()

        self.assertEqual(_FakeDashboardManager.instances[0].kwargs["base_path"], DASHBOARD_BASE_PATH)
        self.assertEqual(proxy_route.path, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")
        self.assertFalse(status["running"])
        self.assertTrue(started["running"])
        self.assertTrue(restarted["running"])
        self.assertFalse(stopped["running"])

    def test_dashboard_public_endpoints_do_not_expose_manager_error_details(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _LeakyDashboardManager):
                app = create_app(config)

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

    def test_dashboard_public_status_does_not_expose_process_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

            response = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status"))

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("host", body)
        self.assertNotIn("port", body)
        self.assertNotIn("pid", body)

    def test_dashboard_theme_sync_errors_do_not_expose_exception_details(self):
        secret = "secret stack detail from /tmp/private/dashboard-theme"
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

            with patch("hermelin.server.logger"):
                with patch("hermelin.server.sync_dashboard_theme_for_ui_theme", side_effect=RuntimeError(secret)):
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
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=custom_base_path,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

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
                _FakeDashboardManager.instances = []
                config = HermelinConfig(
                    hermes_home=Path(tmpdir) / "hermes-home",
                    meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                    spawn_cwd=Path(tmpdir) / "spawn-cwd",
                    hermes_dashboard_base_path=unsafe_path,
                )

                with (
                    patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager),
                    patch("hermelin.server.logger"),
                ):
                    app = create_app(config)

                proxy_route = _route_for_path(app, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

            self.assertEqual(_FakeDashboardManager.instances[0].kwargs["base_path"], DASHBOARD_BASE_PATH)
            self.assertEqual(proxy_route.path, f"{DASHBOARD_BASE_PATH}" + "/{path:path}")

    def test_dashboard_proxy_strips_spoofed_forwarded_headers(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)
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
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)
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
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)
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

    def test_dashboard_websocket_rejects_cross_site_origin_before_starting_dashboard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
                allowed_ips="*",
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

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
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)
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
            _FakeDashboardManager.instances = []
            config = HermelinConfig(
                hermes_home=Path(tmpdir) / "hermes-home",
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
                auth_password_hash="auth-enabled-without-cookie",
                cookie_secret="test-cookie-secret",
            )

            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

            status_response = asyncio.run(_asgi_request(app, "GET", "/api/hermes-dashboard/status"))
            proxy_response = asyncio.run(_asgi_request(app, "GET", f"{DASHBOARD_BASE_PATH}/"))

        self.assertEqual(status_response.status_code, 401)
        self.assertEqual(proxy_response.status_code, 401)
        self.assertFalse(_FakeDashboardManager.instances[0].started)

    def test_dashboard_websocket_header_kwargs_support_installed_websockets(self):
        kwargs = _websockets_connect_kwargs(
            subprotocols=["chat"],
            extra_headers={"X-Forwarded-Prefix": DASHBOARD_BASE_PATH},
        )

        self.assertEqual(kwargs["subprotocols"], ["chat"])
        self.assertTrue("additional_headers" in kwargs or "extra_headers" in kwargs)
        self.assertIn({"X-Forwarded-Prefix": DASHBOARD_BASE_PATH}, kwargs.values())


if __name__ == "__main__":
    unittest.main()
