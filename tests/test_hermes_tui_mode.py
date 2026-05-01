import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

from hermelin import __main__ as hermelin_main
from hermelin.config import HermelinConfig
from hermelin.config_editor import (
    _update_hermelin_launch_mode_config_text,
    _update_platform_toolset_enabled_config_text,
)
from hermelin.server import (
    _build_hermes_command_for_launch_mode,
    _is_managed_hermes_command,
    _normalize_hermes_launch_mode,
    create_app,
)


def _route_for_path(app, path: str, method: str = "GET"):
    wanted = method.upper()
    for route in app.router.routes:
        methods = {m.upper() for m in getattr(route, "methods", set())}
        if getattr(route, "path", "") == path and wanted in methods:
            return route
    raise AssertionError(f"route not found: {method} {path}")


class HermesTuiModeTests(unittest.TestCase):
    def test_normalize_hermes_launch_mode_defaults_to_chat(self):
        self.assertEqual(_normalize_hermes_launch_mode(None), "chat")
        self.assertEqual(_normalize_hermes_launch_mode(""), "chat")
        self.assertEqual(_normalize_hermes_launch_mode("nope"), "chat")
        self.assertEqual(_normalize_hermes_launch_mode("TUI"), "tui")

    def test_build_hermes_command_for_classic_chat(self):
        self.assertEqual(
            _build_hermes_command_for_launch_mode("chat", strudel_enabled=False),
            'hermes chat --toolsets "hermes-cli, artifacts"',
        )
        self.assertEqual(
            _build_hermes_command_for_launch_mode("chat", strudel_enabled=True),
            'hermes chat --toolsets "hermes-cli, artifacts, strudel"',
        )

    def test_build_hermes_command_for_tui_does_not_depend_on_toolsets_flag(self):
        self.assertEqual(
            _build_hermes_command_for_launch_mode("tui", strudel_enabled=True),
            "hermes chat --tui",
        )

    def test_managed_hermes_command_detection_accepts_absolute_installer_path(self):
        self.assertTrue(
            _is_managed_hermes_command('/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts"')
        )
        self.assertTrue(
            _is_managed_hermes_command('/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts, strudel"')
        )
        self.assertFalse(_is_managed_hermes_command('/home/user/bin/custom-hermes chat --toolsets "hermes-cli, artifacts"'))

    def test_update_hermelin_launch_mode_preserves_other_yaml(self):
        text = "model:\n  default: nous/foo\nhermelin:\n  default_artifacts:\n    strudel: true\n"

        updated, changed = _update_hermelin_launch_mode_config_text(text, "tui")

        self.assertTrue(changed)
        self.assertIn("model:\n  default: nous/foo", updated)
        self.assertIn("hermelin:\n  hermes_launch_mode: tui\n  default_artifacts:", updated)

    def test_update_hermelin_launch_mode_rewrites_existing_value(self):
        text = "hermelin:\n  hermes_launch_mode: chat # old\n"

        updated, changed = _update_hermelin_launch_mode_config_text(text, "tui")

        self.assertTrue(changed)
        self.assertIn("hermes_launch_mode: tui # old", updated)

    def test_update_hermelin_launch_mode_handles_inline_mapping_without_duplicate_key(self):
        text = "hermelin: {default_artifacts: {strudel: true}, toolsets: {strudel: true}}\nmodel: foo/bar\n"

        updated, changed = _update_hermelin_launch_mode_config_text(text, "tui")
        data = yaml.safe_load(updated)

        self.assertTrue(changed)
        self.assertEqual(updated.count("hermelin:"), 1)
        self.assertTrue(data["hermelin"]["default_artifacts"]["strudel"])
        self.assertTrue(data["hermelin"]["toolsets"]["strudel"])
        self.assertEqual(data["hermelin"]["hermes_launch_mode"], "tui")
        self.assertEqual(data["model"], "foo/bar")

    def test_update_hermelin_launch_mode_replaces_scalar_value_without_duplicate_key(self):
        text = "hermelin: false\nmodel: foo/bar\n"

        updated, changed = _update_hermelin_launch_mode_config_text(text, "tui")
        data = yaml.safe_load(updated)

        self.assertTrue(changed)
        self.assertEqual(updated.count("hermelin:"), 1)
        self.assertEqual(data["hermelin"], {"hermes_launch_mode": "tui"})
        self.assertEqual(data["model"], "foo/bar")

    def test_update_platform_toolset_enabled_adds_strudel_to_cli_list(self):
        text = "platform_toolsets:\n  cli:\n    - hermes-cli\n    - artifacts\n    - web\n"

        updated, changed = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", True)

        self.assertTrue(changed)
        self.assertIn("    - hermes-cli\n", updated)
        self.assertIn("    - artifacts\n", updated)
        self.assertIn("    - web\n", updated)
        self.assertIn("    - strudel\n", updated)

    def test_update_platform_toolset_enabled_removes_strudel_only(self):
        text = "platform_toolsets:\n  cli:\n    - hermes-cli\n    - artifacts\n    - strudel\n    - web\n"

        updated, changed = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", False)

        self.assertTrue(changed)
        self.assertIn("    - hermes-cli\n", updated)
        self.assertIn("    - artifacts\n", updated)
        self.assertIn("    - web\n", updated)
        self.assertNotIn("strudel", updated)

    def test_update_platform_toolset_enabled_creates_missing_cli_list(self):
        updated, changed = _update_platform_toolset_enabled_config_text("model: foo/bar\n", "cli", "artifacts", True)

        self.assertTrue(changed)
        self.assertIn("platform_toolsets:\n  cli:\n    - hermes-cli\n    - artifacts\n", updated)

    def test_update_platform_toolset_enabled_leaves_all_sentinel_alone(self):
        text = "platform_toolsets:\n  cli:\n    - all\n"

        updated, changed = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", False)

        self.assertFalse(changed)
        self.assertEqual(updated, text)

    def test_update_platform_toolset_enabled_leaves_top_level_all_sentinel_alone(self):
        text = "platform_toolsets: all\nmodel: foo/bar\n"

        updated, changed = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", False)
        updated_enabled, changed_enabled = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", True)

        self.assertFalse(changed)
        self.assertEqual(updated, text)
        self.assertFalse(changed_enabled)
        self.assertEqual(updated_enabled, text)

    def test_update_platform_toolset_enabled_handles_inline_mapping_without_duplicate_key(self):
        text = "platform_toolsets: {cli: [hermes-cli, artifacts, web]}\nmodel: foo/bar\n"

        updated, changed = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", True)
        data = yaml.safe_load(updated)

        self.assertTrue(changed)
        self.assertEqual(updated.count("platform_toolsets:"), 1)
        self.assertEqual(data["platform_toolsets"]["cli"], ["hermes-cli", "artifacts", "web", "strudel"])
        self.assertEqual(data["model"], "foo/bar")

    def test_update_platform_toolset_enabled_handles_same_indent_sequence_items(self):
        text = (
            "platform_toolsets:\n"
            "  cli:\n"
            "  - hermes-cli\n"
            "  - artifacts\n"
            "  discord:\n"
            "  - hermes-discord\n"
            "  homeassistant:\n"
            "  - hermes-homeassistant\n"
        )

        updated, changed = _update_platform_toolset_enabled_config_text(text, "cli", "strudel", True)
        data = yaml.safe_load(updated)

        self.assertTrue(changed)
        self.assertEqual(data["platform_toolsets"]["cli"], ["hermes-cli", "artifacts", "strudel"])
        self.assertEqual(data["platform_toolsets"]["discord"], ["hermes-discord"])
        self.assertEqual(data["platform_toolsets"]["homeassistant"], ["hermes-homeassistant"])
        self.assertNotIn("\n  - hermes-cli", updated)

    def test_agent_settings_post_tui_syncs_platform_toolsets_from_existing_tool_flags(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            hermes_home = tmp / "hermes-home"
            hermes_home.mkdir(parents=True, exist_ok=True)
            fake_hermes = tmp / "fake-hermes"
            fake_hermes.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake_hermes.chmod(0o755)
            (hermes_home / "config.yaml").write_text(
                "hermelin:\n"
                "  hermes_launch_mode: chat\n"
                "  toolsets:\n"
                "    strudel: true\n"
                "platform_toolsets:\n"
                "  cli:\n"
                "    - web\n",
                encoding="utf-8",
            )
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp,
                hermes_cmd=f'{fake_hermes} chat --toolsets "hermes-cli, artifacts"',
                hermes_cmd_override=True,
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/settings/agent", method="POST")

            result = asyncio.run(route.endpoint({"hermelin": {"hermes_launch_mode": "tui"}}))
            data = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))

            self.assertTrue(result["ok"])
            self.assertEqual(data["hermelin"]["hermes_launch_mode"], "tui")
            self.assertEqual(data["platform_toolsets"]["cli"], ["web", "artifacts", "strudel"])

    def test_agent_settings_get_exposes_tui_launch_mode(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            hermes_home = tmp / "hermes-home"
            hermes_home.mkdir(parents=True, exist_ok=True)
            (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts"',
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/settings/agent", method="GET")

            result = asyncio.run(route.endpoint())

            self.assertEqual(result["hermelin"]["hermes_launch_mode"], "tui")
            self.assertFalse(result["hermelin"]["hermes_cmd_override"])
            self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "hermes chat --tui")

    def test_agent_settings_get_reads_dotted_hermelin_launch_mode_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            hermes_home = tmp / "hermes-home"
            hermes_home.mkdir(parents=True, exist_ok=True)
            (hermes_home / "config.yaml").write_text("hermelin.hermes_launch_mode: tui\n", encoding="utf-8")
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts"',
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/settings/agent", method="GET")

            result = asyncio.run(route.endpoint())

            self.assertEqual(result["hermelin"]["hermes_launch_mode"], "tui")
            self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "hermes chat --tui")

    def test_agent_settings_get_reads_dotted_hermelin_toolset_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            hermes_home = tmp / "hermes-home"
            hermes_home.mkdir(parents=True, exist_ok=True)
            (hermes_home / "config.yaml").write_text(
                "hermelin.hermes_launch_mode: chat\nhermelin.toolsets.strudel: true\n", encoding="utf-8"
            )
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts"',
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/settings/agent", method="GET")

            result = asyncio.run(route.endpoint())

            self.assertEqual(result["hermelin"]["hermes_launch_mode"], "chat")
            self.assertEqual(
                result["hermelin"]["effective_hermes_cmd"],
                'hermes chat --toolsets "hermes-cli, artifacts, strudel"',
            )

    def test_agent_settings_get_preserves_absolute_managed_executable_for_chat_and_tui(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            hermes_home = tmp / "hermes-home"
            hermes_home.mkdir(parents=True, exist_ok=True)
            config = HermelinConfig(
                hermes_home=hermes_home,
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                hermes_cmd='/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts, strudel"',
            )

            (hermes_home / "config.yaml").write_text(
                "hermelin:\n  hermes_launch_mode: chat\n  toolsets:\n    strudel: true\n",
                encoding="utf-8",
            )
            app = create_app(config)
            route = _route_for_path(app, "/api/settings/agent", method="GET")
            chat_result = asyncio.run(route.endpoint())

            (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
            tui_result = asyncio.run(route.endpoint())

            self.assertFalse(chat_result["hermelin"]["hermes_cmd_override"])
            self.assertEqual(
                chat_result["hermelin"]["effective_hermes_cmd"],
                '/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts, strudel"',
            )
            self.assertFalse(tui_result["hermelin"]["hermes_cmd_override"])
            self.assertEqual(tui_result["hermelin"]["effective_hermes_cmd"], "/home/user/.local/bin/hermes chat --tui")

    def test_agent_settings_get_reports_env_command_override(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        try:
            os.environ["HERMELIN_HERMES_CMD"] = "custom-hermes --flag"
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                    hermes_cmd="custom-hermes --flag",
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="GET")

                result = asyncio.run(route.endpoint())

                self.assertEqual(result["hermelin"]["hermes_launch_mode"], "tui")
                self.assertTrue(result["hermelin"]["hermes_cmd_override"])
                self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "custom Hermes command override")
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env

    def test_agent_settings_get_reports_explicit_config_command_override_without_env(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        try:
            os.environ.pop("HERMELIN_HERMES_CMD", None)
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                    hermes_cmd="custom-hermes --flag",
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="GET")

                result = asyncio.run(route.endpoint())

                self.assertTrue(result["hermelin"]["hermes_cmd_override"])
                self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "custom Hermes command override")
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env

    def test_agent_settings_get_honors_explicit_managed_command_override(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        old_override_env = os.environ.get("HERMELIN_HERMES_CMD_OVERRIDE")
        try:
            os.environ.pop("HERMELIN_HERMES_CMD", None)
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                    hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts"',
                    hermes_cmd_override=True,
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="GET")

                result = asyncio.run(route.endpoint())

                self.assertTrue(result["hermelin"]["hermes_cmd_override"])
                self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "custom Hermes command override")
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env
            if old_override_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            else:
                os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = old_override_env

    def test_agent_settings_get_honors_reload_override_flag_for_managed_env_command(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        old_override_env = os.environ.get("HERMELIN_HERMES_CMD_OVERRIDE")
        try:
            os.environ["HERMELIN_HERMES_CMD"] = 'hermes chat --toolsets "hermes-cli, artifacts"'
            os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = "1"
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                    hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts"',
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="GET")

                result = asyncio.run(route.endpoint())

                self.assertTrue(result["hermelin"]["hermes_cmd_override"])
                self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "custom Hermes command override")
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env
            if old_override_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            else:
                os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = old_override_env

    def test_reload_preserves_absolute_managed_env_command_without_override_flag(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        old_override_env = os.environ.get("HERMELIN_HERMES_CMD_OVERRIDE")
        absolute_cmd = '/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts"'
        try:
            os.environ["HERMELIN_HERMES_CMD"] = absolute_cmd
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)

            with mock.patch("sys.argv", ["hermelin", "--reload", "--host", "127.0.0.1"]), mock.patch.object(
                hermelin_main.uvicorn, "run"
            ) as uvicorn_run:
                hermelin_main.main()

            uvicorn_run.assert_called_once()
            self.assertEqual(os.environ["HERMELIN_HERMES_CMD"], absolute_cmd)
            self.assertNotIn("HERMELIN_HERMES_CMD_OVERRIDE", os.environ)
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env
            if old_override_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            else:
                os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = old_override_env

    def test_agent_settings_get_treats_managed_env_command_as_non_override(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        old_override_env = os.environ.get("HERMELIN_HERMES_CMD_OVERRIDE")
        try:
            os.environ["HERMELIN_HERMES_CMD"] = 'hermes chat --toolsets "hermes-cli, artifacts, strudel"'
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                    hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts, strudel"',
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="GET")

                result = asyncio.run(route.endpoint())

                self.assertFalse(result["hermelin"]["hermes_cmd_override"])
                self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "hermes chat --tui")
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env
            if old_override_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            else:
                os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = old_override_env

    def test_agent_settings_get_treats_absolute_managed_env_command_as_non_override(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        old_override_env = os.environ.get("HERMELIN_HERMES_CMD_OVERRIDE")
        try:
            os.environ["HERMELIN_HERMES_CMD"] = '/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts, strudel"'
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                    hermes_cmd='/home/user/.local/bin/hermes chat --toolsets "hermes-cli, artifacts, strudel"',
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="GET")

                result = asyncio.run(route.endpoint())

                self.assertFalse(result["hermelin"]["hermes_cmd_override"])
                self.assertEqual(result["hermelin"]["effective_hermes_cmd"], "/home/user/.local/bin/hermes chat --tui")
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env
            if old_override_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            else:
                os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = old_override_env

    def test_explicit_config_command_takes_precedence_over_custom_env_command(self):
        old_env = os.environ.get("HERMELIN_HERMES_CMD")
        old_override_env = os.environ.get("HERMELIN_HERMES_CMD_OVERRIDE")
        try:
            os.environ["HERMELIN_HERMES_CMD"] = "missing-env-hermes --flag"
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / "hermes-home"
                hermes_home.mkdir(parents=True, exist_ok=True)
                fake_hermes = tmp / "fake-hermes"
                fake_hermes.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                fake_hermes.chmod(0o755)
                (hermes_home / "config.yaml").write_text("hermelin:\n  hermes_launch_mode: tui\n", encoding="utf-8")
                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp,
                    hermes_cmd=f"{fake_hermes} --explicit",
                    hermes_cmd_override=True,
                )
                app = create_app(config)
                route = _route_for_path(app, "/api/settings/agent", method="POST")

                result = asyncio.run(route.endpoint({"hermelin": {"hermes_launch_mode": "tui"}}))

                self.assertTrue(result["ok"])
        finally:
            if old_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD", None)
            else:
                os.environ["HERMELIN_HERMES_CMD"] = old_env
            if old_override_env is None:
                os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
            else:
                os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = old_override_env


if __name__ == "__main__":
    unittest.main()
