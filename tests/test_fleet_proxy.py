import os
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hermelin.config import HermelinConfig
from hermelin.fleet_proxy import (
    FLEET_DISABLED_PAYLOAD,
    _read_protected_service_token,
    normalize_fleet_bridge_url,
    public_fleet_config,
    resolve_fleet_settings,
)
from hermelin.server import (
    _FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES,
    _fleet_runtime_attach_frame_size,
    create_app,
)


class FakeFleetHTTPClient:
    def __init__(self, response: httpx.Response):
        self.response = response
        self.calls = []

    async def request(self, method, url, *, headers=None, json=None, params=None):
        self.calls.append({
            "method": method,
            "url": url,
            "headers": dict(headers or {}),
            "json": json,
            "params": params,
        })
        return self.response


class FailingFleetHTTPClient:
    async def request(self, method, url, **_kwargs):
        request = httpx.Request(method, url)
        raise httpx.ConnectError(f"failed to connect to {url}", request=request)


class MappingFleetHTTPClient:
    def __init__(self, payloads: dict[str, object]):
        self.payloads = payloads
        self.calls = []

    async def request(self, method, url, *, headers=None, json=None, params=None):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), "json": json})
        path = httpx.URL(url).path
        if path not in self.payloads:
            return httpx.Response(404, json={"detail": "not found"})
        value = self.payloads[path]
        if isinstance(value, tuple):
            status, value = value
            return httpx.Response(status, json=value)
        return httpx.Response(200, json=value)


class FakeUpstreamWebSocket:
    async def send(self, _message):
        return None

    def __aiter__(self):
        async def empty():
            if False:
                yield b""

        return empty()


class FakeWebSocketConnect:
    def __init__(self):
        self.upstream = FakeUpstreamWebSocket()

    async def __aenter__(self):
        return self.upstream

    async def __aexit__(self, *_args):
        return False


def _config(tmpdir: str, **overrides) -> HermelinConfig:
    tmp = Path(tmpdir)
    kwargs = dict(
        hermes_home=tmp / "hermes-home",
        meta_db_path=tmp / "hermelin_meta.db",
        spawn_cwd=tmp / "cwd",
        allowed_ips="*",
        fleet_mode="external",
        fleet_bridge_url="https://fleet.local:19081",
        fleet_service_token="fleet-secret",
        fleet_admin_token="",
    )
    kwargs.update(overrides)
    return HermelinConfig(**kwargs)  # type: ignore[arg-type]


class FleetProxyTests(unittest.TestCase):
    def test_normalizes_valid_http_urls_only(self):
        self.assertEqual(normalize_fleet_bridge_url("http://127.0.0.1:8080/"), "http://127.0.0.1:8080")
        self.assertEqual(normalize_fleet_bridge_url("https://fleet.example/api/"), "https://fleet.example/api")
        self.assertEqual(normalize_fleet_bridge_url(""), "")
        self.assertEqual(normalize_fleet_bridge_url("ftp://fleet.example"), "")
        self.assertEqual(normalize_fleet_bridge_url("localhost:8080"), "")

    def test_public_config_contains_only_safe_mode_and_availability_fields(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, fleet_service_token="super-secret-token", fleet_admin_token="")
            data = public_fleet_config(config)

        self.assertEqual(
            set(data),
            {"mode", "enabled", "configured", "available", "admin_token_configured"},
        )
        self.assertEqual(data["mode"], "external")
        self.assertTrue(data["enabled"])
        self.assertTrue(data["configured"])
        self.assertTrue(data["available"])
        self.assertTrue(data["admin_token_configured"])
        self.assertNotIn("base_url", data)
        self.assertNotIn("api_prefix", data)
        self.assertNotIn("token", data)
        self.assertNotIn("super-secret-token", str(data))

    def test_unset_mode_with_valid_url_migrates_to_external_with_one_warning(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, fleet_mode="", fleet_bridge_url="https://fleet.example")
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                app = create_app(config)
                with TestClient(app) as client:
                    first = client.get("/api/fleet/config").json()
                    second = client.get("/api/fleet/config").json()

        deprecations = [item for item in caught if issubclass(item.category, DeprecationWarning)]
        self.assertEqual(len(deprecations), 1)
        self.assertIn("HERMELIN_FLEET_MODE", str(deprecations[0].message))
        self.assertEqual(first, second)
        self.assertEqual(first["mode"], "external")
        self.assertTrue(first["available"])

    def test_fresh_unset_mode_without_url_is_off(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            settings = resolve_fleet_settings(_config(tmpdir, fleet_mode="", fleet_bridge_url=""))

        self.assertEqual(settings.mode, "off")
        self.assertFalse(settings.enabled)
        self.assertFalse(settings.configured)
        self.assertFalse(settings.available)

    def test_local_mode_defaults_to_loopback(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            settings = resolve_fleet_settings(_config(tmpdir, fleet_mode="local", fleet_bridge_url=""))

        self.assertEqual(settings.mode, "local")
        self.assertEqual(settings.base_url, "http://127.0.0.1:8080")
        self.assertTrue(settings.available)

    def test_local_mode_rejects_explicit_non_loopback_urls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            for url in ("http://192.168.1.20:8080", "https://fleet.example", "http://100.100.20.30:8080"):
                settings = resolve_fleet_settings(_config(tmpdir, fleet_mode="local", fleet_bridge_url=url))
                self.assertEqual(settings.mode, "local")
                self.assertEqual(settings.base_url, "")
                self.assertFalse(settings.configured)
                self.assertFalse(settings.available)

    def test_external_public_http_requires_explicit_development_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            blocked = resolve_fleet_settings(
                _config(tmpdir, fleet_mode="external", fleet_bridge_url="http://fleet.example")
            )
            blocked_ipv6 = resolve_fleet_settings(
                _config(tmpdir, fleet_mode="external", fleet_bridge_url="http://[2606:4700:4700::1111]")
            )
            allowed = resolve_fleet_settings(
                _config(
                    tmpdir,
                    fleet_mode="external",
                    fleet_bridge_url="http://fleet.example",
                    fleet_allow_insecure_http=True,
                )
            )

        self.assertFalse(blocked.configured)
        self.assertFalse(blocked.available)
        self.assertEqual(blocked.base_url, "")
        self.assertFalse(blocked_ipv6.available)
        self.assertEqual(blocked_ipv6.base_url, "")
        self.assertTrue(allowed.configured)
        self.assertTrue(allowed.available)
        self.assertEqual(allowed.base_url, "http://fleet.example")

    def test_external_plain_http_accepts_only_loopback_without_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loopback = resolve_fleet_settings(
                _config(tmpdir, fleet_bridge_url="http://127.0.0.1:8080")
            )
            non_loopback_urls = (
                "http://10.20.30.40:8080",
                "http://100.100.20.30:8080",
                "http://central.tailnet.ts.net:8080",
            )
            blocked = [resolve_fleet_settings(_config(tmpdir, fleet_bridge_url=url)) for url in non_loopback_urls]

        self.assertTrue(loopback.available)
        self.assertTrue(all(not item.available for item in blocked))

    def test_off_mode_has_no_fleet_client_and_all_http_routes_are_inert(self):
        cases = (
            ("get", "/api/fleet/snapshot", None),
            ("get", "/api/fleet/status", None),
            ("get", "/api/fleet/nodes", None),
            ("get", "/api/fleet/agents", None),
            ("get", "/api/fleet/agents/agent-1", None),
            ("get", "/api/fleet/agents/agent-1/logs", None),
            ("post", "/api/fleet/agents/agent-1/inject", {}),
            ("get", "/api/fleet/sessions", None),
            ("get", "/api/fleet/runtimes", None),
            ("get", "/api/fleet/nodes/node-1/runtimes", None),
            ("post", "/api/fleet/nodes/node-1/runtimes", []),
            ("post", "/api/fleet/nodes/node-1/runtimes/runtime-1/stop", None),
            ("get", "/api/fleet/capabilities", None),
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(
                _config(
                    tmpdir,
                    fleet_mode="off",
                    fleet_bridge_url="http://does-not-resolve.invalid:19081",
                )
            )
            with TestClient(app) as client:
                self.assertIsNone(getattr(app.state, "fleet_http_client", None))
                for method, path, body in cases:
                    kwargs = {"json": body} if body is not None else {}
                    response = getattr(client, method)(path, **kwargs)
                    with self.subTest(method=method, path=path):
                        self.assertEqual(response.status_code, 503)
                        self.assertEqual(response.json(), FLEET_DISABLED_PAYLOAD)
                self.assertIsNone(getattr(app.state, "fleet_http_client", None))

    def test_off_mode_websocket_routes_return_stable_disabled_frame_without_connecting(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(
                _config(
                    tmpdir,
                    fleet_mode="off",
                    fleet_bridge_url="http://does-not-resolve.invalid:19081",
                )
            )
            with patch("hermelin.server.websockets.connect") as connect:
                with TestClient(app) as client:
                    paths = (
                        "/ws/fleet/agents/agent-1/attach",
                        "/ws/fleet/nodes/node-1/runtimes/runtime-1/attach",
                    )
                    for path in paths:
                        with client.websocket_connect(path) as websocket:
                            with self.subTest(path=path):
                                self.assertEqual(websocket.receive_json(), FLEET_DISABLED_PAYLOAD)
                                with self.assertRaises(WebSocketDisconnect) as closed:
                                    websocket.receive_json()
                                self.assertEqual(closed.exception.code, 1008)

        connect.assert_not_called()

    def test_runtime_attach_mints_session_bound_ticket_and_never_uses_service_token_on_websocket(self):
        attach_path = "/api/v1/nodes/node-1/runtimes/runtime-1/attach"
        ticket_path = f"{attach_path}-ticket"
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_service_token="service-token", fleet_admin_token=""))
            fake = MappingFleetHTTPClient(
                {ticket_path: (201, {"ticket": "single-use-ticket", "attach_path": attach_path})}
            )
            with patch("hermelin.server.websockets.connect", return_value=FakeWebSocketConnect()) as connect:
                with TestClient(app) as client:
                    app.state.fleet_http_client = fake
                    with client.websocket_connect(
                        "/ws/fleet/nodes/node-1/runtimes/runtime-1/attach",
                        headers={"origin": "http://testserver"},
                    ) as websocket:
                        message = websocket.receive()
                        self.assertEqual(message["type"], "websocket.close")

        self.assertEqual(len(fake.calls), 1)
        ticket_call = fake.calls[0]
        self.assertEqual(ticket_call["method"], "POST")
        self.assertEqual(httpx.URL(ticket_call["url"]).path, ticket_path)
        self.assertEqual(ticket_call["headers"].get("Authorization"), "Bearer service-token")
        self.assertEqual(ticket_call["json"]["user_id"], "hermelin-browser")
        self.assertEqual(len(ticket_call["json"]["session_id"]), 64)
        connect.assert_called_once()
        websocket_headers = connect.call_args.kwargs["additional_headers"]
        self.assertEqual(websocket_headers.get("Authorization"), "Bearer single-use-ticket")
        self.assertEqual(websocket_headers.get("X-Fleet-Attach-User-ID"), "hermelin-browser")
        self.assertEqual(websocket_headers.get("X-Fleet-Attach-Session-ID"), ticket_call["json"]["session_id"])
        self.assertEqual(connect.call_args.kwargs["max_size"], _FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES)
        self.assertEqual(connect.call_args.kwargs["max_queue"], 4)
        self.assertNotIn("service-token", str(connect.call_args))

    def test_runtime_attach_frame_budget_counts_utf8_wire_bytes(self):
        limit = _FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES
        self.assertEqual(_fleet_runtime_attach_frame_size(b"x" * limit), limit)
        self.assertEqual(_fleet_runtime_attach_frame_size("é" * (limit // 2)), limit)
        self.assertGreater(_fleet_runtime_attach_frame_size("é" * (limit // 2 + 1)), limit)

    def test_fleet_http_client_lifecycle_exists_only_when_mode_is_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            available_app = create_app(_config(tmpdir, fleet_mode="external"))
            with TestClient(available_app):
                fleet_client = available_app.state.fleet_http_client
                self.assertIsInstance(fleet_client, httpx.AsyncClient)
                self.assertFalse(fleet_client.is_closed)
            self.assertTrue(fleet_client.is_closed)

            unavailable_app = create_app(
                _config(
                    tmpdir,
                    fleet_mode="external",
                    fleet_bridge_url="http://fleet.example",
                )
            )
            with TestClient(unavailable_app):
                self.assertIsNone(getattr(unavailable_app.state, "fleet_http_client", None))

    def test_status_proxy_uses_server_side_credential_for_protected_read(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir))
            fake = FakeFleetHTTPClient(httpx.Response(200, json={"ok": True, "nodes": 1, "agents": 2, "sessions": 3, "capabilities": []}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.get("/api/fleet/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["agents"], 2)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0]["method"], "GET")
        self.assertEqual(fake.calls[0]["url"], "https://fleet.local:19081/api/v1/status")
        self.assertEqual(fake.calls[0]["headers"].get("Authorization"), "Bearer fleet-secret")

    def test_transport_errors_do_not_reveal_hidden_fleet_url(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_bridge_url="https://hidden-fleet.internal:19081"))
            with TestClient(app) as client:
                app.state.fleet_http_client = FailingFleetHTTPClient()
                response = client.get("/api/fleet/status")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "fleet bridge unavailable"})
        self.assertNotIn("hidden-fleet", response.text)

    def test_scoped_service_credential_is_used_and_admin_identity_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_service_token="service-secret", fleet_admin_token="admin-secret"))
            fake = FakeFleetHTTPClient(httpx.Response(200, json={"ok": True}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.get("/api/fleet/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fake.calls[0]["headers"].get("Authorization"), "Bearer service-secret")

    def test_service_credential_file_must_be_owned_by_service_user(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            token_path = Path(tmpdir) / "fleet-service.token"
            token_path.write_text("service-token\n", encoding="utf-8")
            token_path.chmod(0o600)
            real_info = token_path.stat()
            foreign_info = type(
                "ForeignStat",
                (),
                {
                    "st_mode": real_info.st_mode,
                    "st_uid": os.geteuid() + 1,
                    "st_size": real_info.st_size,
                },
            )()
            with patch("hermelin.fleet_proxy.os.fstat", return_value=foreign_info):
                self.assertEqual(_read_protected_service_token(token_path), "")

    def test_reloadable_service_credential_file_rotates_without_app_restart_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            token_path = Path(tmpdir) / "fleet-service.token"
            token_path.write_text("old-service-token\n", encoding="utf-8")
            token_path.chmod(0o600)
            app = create_app(
                _config(
                    tmpdir,
                    fleet_service_token="stale-env-token",
                    fleet_service_token_file=token_path,
                    fleet_admin_token="legacy-admin-token",
                )
            )
            fake = FakeFleetHTTPClient(httpx.Response(200, json={"ok": True}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                first = client.get("/api/fleet/status")
                replacement = token_path.with_suffix(".new")
                replacement.write_text("new-service-token\n", encoding="utf-8")
                replacement.chmod(0o600)
                os.replace(replacement, token_path)
                second = client.get("/api/fleet/status")
                token_path.chmod(0o644)
                rejected = client.get("/api/fleet/status")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(rejected.status_code, 503)
        self.assertEqual(fake.calls[0]["headers"].get("Authorization"), "Bearer old-service-token")
        self.assertEqual(fake.calls[1]["headers"].get("Authorization"), "Bearer new-service-token")
        self.assertEqual(len(fake.calls), 2)
        self.assertNotIn("stale-env-token", str(fake.calls))
        self.assertNotIn("legacy-admin-token", str(fake.calls))

    def test_snapshot_collapses_six_protected_reads_into_one_browser_response(self):
        payloads = {
            "/api/v1/status": {"ok": True, "nodes": 1},
            "/api/v1/nodes": [{"node": "node-a"}],
            "/api/v1/agents": [{"agent_id": "agent-a"}],
            "/api/v1/runtimes": {"runtimes": [{"runtime_id": "rt-a"}]},
            "/api/v1/sessions": [{"session_id": "session-a"}],
            "/api/v1/capabilities": {"verbs": ["inject_task"]},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_service_token="server-token"))
            fake = MappingFleetHTTPClient(payloads)
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.get("/api/fleet/snapshot")

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"]["nodes"], 1)
        self.assertEqual(data["nodes"][0]["node"], "node-a")
        self.assertEqual(data["runtimes"]["runtimes"][0]["runtime_id"], "rt-a")
        self.assertEqual(len(fake.calls), 6)
        self.assertTrue(all(call["headers"].get("Authorization") == "Bearer server-token" for call in fake.calls))
        self.assertNotIn("server-token", response.text)

    def test_snapshot_downgrades_to_cockpit_only_when_runtime_extension_is_absent(self):
        payloads = {
            "/api/v1/status": {"ok": True, "nodes": 1},
            "/api/v1/nodes": [{"node": "node-a"}],
            "/api/v1/agents": [{"agent_id": "agent-a"}],
            "/api/v1/sessions": [{"session_id": "session-a"}],
            "/api/v1/capabilities": {"verbs": ["inject_task"]},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_service_token="service-token"))
            fake = MappingFleetHTTPClient(payloads)
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.get("/api/fleet/snapshot")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["runtimes"], {"runtimes": []})
        self.assertEqual(response.json()["agents"][0]["agent_id"], "agent-a")

    def test_inject_proxy_uses_server_side_admin_token_and_encodes_agent_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_service_token="server-token"))
            fake = FakeFleetHTTPClient(httpx.Response(200, json={"agent_id": "agent 1", "result": {"ok": True}}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.post(
                    "/api/fleet/agents/agent%201/inject",
                    json={"message": "Continue", "session_id": "sess-live"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(fake.calls), 1)
        call = fake.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "https://fleet.local:19081/api/v1/agents/agent%201/inject")
        self.assertEqual(call["headers"].get("Authorization"), "Bearer server-token")
        self.assertEqual(call["json"], {"message": "Continue", "session_id": "sess-live"})
        self.assertNotIn("server-token", response.text)

    def test_runtime_create_enriches_skin_payload_server_side(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, fleet_service_token="server-token")
            skin_dir = config.hermes_home / "skins"
            skin_dir.mkdir(parents=True, exist_ok=True)
            skin_text = "name: nous\ndescription: Nous test skin\ncolors:\n  banner_border: '#ffcc00'\n"
            (skin_dir / "nous.yaml").write_text(skin_text, encoding="utf-8")
            app = create_app(config)
            fake = FakeFleetHTTPClient(httpx.Response(200, json={"runtime": {"runtime_id": "rt-nous"}}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.post(
                    "/api/fleet/nodes/node-a/runtimes",
                    json={"title": "Hermes 1", "ui_theme": "nous", "skin": "nous"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(fake.calls), 1)
        call = fake.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], "https://fleet.local:19081/api/v1/nodes/node-a/runtimes")
        self.assertEqual(call["headers"].get("Authorization"), "Bearer server-token")
        self.assertEqual(call["json"]["skin"], "nous")
        self.assertEqual(call["json"]["ui_theme"], "nous")
        self.assertEqual(call["json"]["skin_yaml"], skin_text)
        self.assertNotIn("server-token", response.text)

    def test_inject_refuses_without_service_credential_and_never_falls_back_to_admin(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, fleet_service_token="", fleet_admin_token="legacy-admin-token"))
            fake = FakeFleetHTTPClient(httpx.Response(200, json={"ok": True}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.post("/api/fleet/agents/agent-1/inject", json={"message": "Continue"})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(fake.calls, [])

    def test_upstream_unauthorized_is_not_returned_as_ui_logout_401(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir))
            fake = FakeFleetHTTPClient(httpx.Response(401, json={"detail": "bad token"}))
            with TestClient(app) as client:
                app.state.fleet_http_client = fake
                response = client.post("/api/fleet/agents/agent-1/inject", json={"message": "Continue"})

        self.assertEqual(response.status_code, 502)
        self.assertIn("configured service credential", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
