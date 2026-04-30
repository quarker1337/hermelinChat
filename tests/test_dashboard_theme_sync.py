import asyncio
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import yaml

from hermelin.config import HermelinConfig
from hermelin.config_editor import _update_dashboard_theme_config_text
from hermelin.dashboard_themes import (
    available_ui_themes,
    dashboard_theme_name_for_ui_theme,
    sync_dashboard_theme_for_ui_theme,
)
from hermelin.server import create_app


DASHBOARD_BASE_PATH = "/api/runners/hermes-dashboard"


class DashboardThemeConfigUpdateTests(unittest.TestCase):
    def test_replaces_existing_nested_theme_without_rewriting_other_content(self):
        original = textwrap.dedent(
            """\
            # top comment
            model: foo/bar
            dashboard:
              compact: true
              theme: old-theme # keep inline
              # keep me
            memory:
              memory_enabled: true
            """
        )

        updated, changed = _update_dashboard_theme_config_text(original, "hermelinchat-nous")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                # top comment
                model: foo/bar
                dashboard:
                  compact: true
                  theme: hermelinchat-nous # keep inline
                  # keep me
                memory:
                  memory_enabled: true
                """
            ),
        )

    def test_inserts_theme_into_existing_dashboard_block(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            dashboard:
              # dashboard prefs
              enabled: true
            """
        )

        updated, changed = _update_dashboard_theme_config_text(original, "hermelinchat-matrix")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                dashboard:
                  # dashboard prefs
                  theme: hermelinchat-matrix
                  enabled: true
                """
            ),
        )

    def test_appends_nested_dashboard_block_when_missing(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            memory:
              memory_enabled: true
            """
        )

        updated, changed = _update_dashboard_theme_config_text(original, "hermelinchat-hermelin")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                memory:
                  memory_enabled: true

                dashboard:
                  theme: hermelinchat-hermelin
                """
            ),
        )

    def test_converts_flat_dashboard_theme_key_to_effective_nested_block(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            dashboard.theme: old-theme # keep inline
            memory:
              memory_enabled: true
            """
        )

        updated, changed = _update_dashboard_theme_config_text(original, "hermelinchat-samaritan")

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                dashboard:
                  theme: hermelinchat-samaritan # keep inline
                memory:
                  memory_enabled: true
                """
            ),
        )

    def test_noops_when_nested_theme_already_matches(self):
        original = "dashboard:\n  theme: hermelinchat-nous\n"

        updated, changed = _update_dashboard_theme_config_text(original, "hermelinchat-nous")

        self.assertFalse(changed)
        self.assertEqual(updated, original)


class DashboardThemeSyncTests(unittest.TestCase):
    def test_sync_writes_namespaced_theme_files_and_nested_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir) / "hermes-home"
            hermes_home.mkdir()
            (hermes_home / "config.yaml").write_text(
                textwrap.dedent(
                    """\
                    # keep config comment
                    model: foo/bar
                    dashboard:
                      theme: default
                    """
                ),
                encoding="utf-8",
            )

            first = sync_dashboard_theme_for_ui_theme(hermes_home, "nous")
            second = sync_dashboard_theme_for_ui_theme(hermes_home, "nous")

            config = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
            theme_file = hermes_home / "dashboard-themes" / "hermelinchat-nous.yaml"
            theme_yaml = yaml.safe_load(theme_file.read_text(encoding="utf-8"))

        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertEqual(first["dashboard_theme"], "hermelinchat-nous")
        self.assertEqual(config["dashboard"]["theme"], "hermelinchat-nous")
        self.assertEqual(theme_yaml["name"], "hermelinchat-nous")
        self.assertIn("nous", available_ui_themes())

    def test_unknown_ui_theme_falls_back_to_hermelin(self):
        self.assertEqual(dashboard_theme_name_for_ui_theme("missing-theme"), "hermelinchat-hermelin")


class _FakeDashboardManager:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.started = False
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
            "last_error": "",
        }

    async def start(self):
        self.started = True
        return self.status()

    async def restart(self):
        self.started = True
        return self.status()

    async def stop(self):
        self.started = False
        return self.status()

    async def ensure_started(self):
        if not self.started:
            return await self.start()
        return self.status()

    def upstream(self):
        return ("http", "127.0.0.1", 45678) if self.started else None

    async def aclose(self):
        self.started = False


async def _asgi_request(app, method: str, path: str, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://chat.example") as client:
        return await client.request(method, path, **kwargs)


class DashboardThemeEndpointTests(unittest.TestCase):
    def test_theme_endpoint_syncs_requested_ui_theme(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )
            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

            response = asyncio.run(
                _asgi_request(app, "POST", "/api/hermes-dashboard/theme", json={"ui_theme": "matrix"})
            )
            config_yaml = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
            theme_file_exists = (hermes_home / "dashboard-themes" / "hermelinchat-matrix.yaml").exists()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["dashboard_theme"], "hermelinchat-matrix")
        self.assertEqual(config_yaml["dashboard"]["theme"], "hermelinchat-matrix")
        self.assertTrue(theme_file_exists)

    def test_start_syncs_theme_before_launching_dashboard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            _FakeDashboardManager.instances = []
            hermes_home = Path(tmpdir) / "hermes-home"
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=Path(tmpdir) / "hermelin_meta.db",
                spawn_cwd=Path(tmpdir) / "spawn-cwd",
                hermes_dashboard_base_path=DASHBOARD_BASE_PATH,
            )
            with patch("hermelin.server.HermesDashboardManager", _FakeDashboardManager):
                app = create_app(config)

            response = asyncio.run(
                _asgi_request(app, "POST", "/api/hermes-dashboard/start", json={"ui_theme": "samaritan"})
            )
            config_yaml = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["running"])
        self.assertEqual(data["dashboard_theme"], "hermelinchat-samaritan")
        self.assertEqual(data["theme_sync"]["dashboard_theme"], "hermelinchat-samaritan")
        self.assertEqual(config_yaml["dashboard"]["theme"], "hermelinchat-samaritan")


if __name__ == "__main__":
    unittest.main()
