import asyncio
import tempfile
import textwrap
import unittest
from pathlib import Path

from hermelin.config import HermelinConfig
from hermelin.default_artifacts import list_default_artifact_settings
from hermelin.server import create_app, _update_default_artifact_flag_config_text


def _route_for_path(app, path: str, method: str = "GET"):
    wanted = method.upper()
    for route in app.router.routes:
        methods = {m.upper() for m in getattr(route, "methods", set())}
        if getattr(route, "path", "") == path and wanted in methods:
            return route
    raise AssertionError(f"route not found: {method} {path}")


class DefaultArtifactSettingsTests(unittest.TestCase):
    def test_list_default_artifact_settings_reports_strudel_disabled_by_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            hermes_home = Path(tmpdir)
            items = list_default_artifact_settings(hermes_home=hermes_home)

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "strudel")
        self.assertFalse(items[0]["enabled"])
        self.assertFalse(items[0]["enabled_by_default"])
        self.assertIn("Strudel", items[0]["title"])

    def test_update_default_artifact_flag_replaces_nested_entry_in_place(self):
        original = textwrap.dedent(
            """\
            # keep this comment
            model: foo/bar
            hermelin:
              default_artifacts:
                strudel: false
              note: keep me
            """
        )

        updated, changed = _update_default_artifact_flag_config_text(original, "strudel", True)

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                # keep this comment
                model: foo/bar
                hermelin:
                  default_artifacts:
                    strudel: true
                  note: keep me
                """
            ),
        )

    def test_update_default_artifact_flag_appends_nested_block_when_missing(self):
        original = textwrap.dedent(
            """\
            model: foo/bar
            display:
              compact: true
            """
        )

        updated, changed = _update_default_artifact_flag_config_text(original, "strudel", True)

        self.assertTrue(changed)
        self.assertEqual(
            updated,
            textwrap.dedent(
                """\
                model: foo/bar
                display:
                  compact: true

                hermelin:
                  default_artifacts:
                    strudel: true
                """
            ),
        )

    def test_settings_route_lists_and_saves_default_artifact_flags(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            hermes_home = tmp / "hermes-home"
            hermes_home.mkdir(parents=True, exist_ok=True)
            config_path = hermes_home / "config.yaml"
            config_path.write_text(
                textwrap.dedent(
                    """\
                    # top comment
                    model: foo/bar
                    display:
                      compact: true
                    """
                ),
                encoding="utf-8",
            )

            app = create_app(
                HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / "hermelin_meta.db",
                    spawn_cwd=tmp / "spawn-cwd",
                )
            )

            get_route = _route_for_path(app, "/api/settings/default-artifacts", method="GET")
            post_route = _route_for_path(app, "/api/settings/default-artifacts", method="POST")

            before = asyncio.run(get_route.endpoint())
            self.assertEqual(before["config_path"], str(config_path))
            self.assertEqual(before["items"][0]["id"], "strudel")
            self.assertFalse(before["items"][0]["enabled"])

            result = asyncio.run(post_route.endpoint(payload={"items": [{"id": "strudel", "enabled": True}]}))
            self.assertTrue(result["ok"])
            self.assertTrue(result["items"][0]["enabled"])

            text = config_path.read_text(encoding="utf-8")
            self.assertIn("# top comment", text)
            self.assertIn("model: foo/bar", text)
            self.assertIn("display:\n  compact: true", text)
            self.assertIn("default_artifacts:\n    strudel: true", text)
            self.assertIn("toolsets:\n    strudel: true", text)


if __name__ == "__main__":
    unittest.main()
