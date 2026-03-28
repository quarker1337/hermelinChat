import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from hermelin.config import HermelinConfig
from hermelin.server import create_app, _set_command_toolset_enabled, _update_nested_bool_flag_config_text


def _route_for_path(app, path: str, method: str = "GET"):
    wanted = method.upper()
    for route in app.router.routes:
        methods = {m.upper() for m in getattr(route, "methods", set())}
        if getattr(route, "path", "") == path and wanted in methods:
            return route
    raise AssertionError(f"route not found: {method} {path}")


class StrudelEnvSyncTests(unittest.TestCase):
    def test_update_nested_bool_flag_adds_toolset_flag(self):
        updated, changed = _update_nested_bool_flag_config_text(
            'model: foo/bar\n',
            ('hermelin', 'toolsets', 'strudel'),
            True,
        )

        self.assertTrue(changed)
        self.assertIn('hermelin:\n  toolsets:\n    strudel: true\n', updated)

    def test_set_command_toolset_enabled_adds_strudel(self):
        updated, changed, error = _set_command_toolset_enabled(
            'hermes chat --toolsets "hermes-cli, artifacts"',
            'strudel',
            True,
        )

        self.assertTrue(changed)
        self.assertIsNone(error)
        self.assertIn('--toolsets', updated)
        self.assertIn('strudel', updated)
        self.assertIn('artifacts', updated)

    def test_set_command_toolset_enabled_removes_strudel(self):
        updated, changed, error = _set_command_toolset_enabled(
            'hermes chat --toolsets "hermes-cli, artifacts, strudel"',
            'strudel',
            False,
        )

        self.assertTrue(changed)
        self.assertIsNone(error)
        self.assertIn('artifacts', updated)
        self.assertNotIn('strudel', updated)

    def test_default_artifact_save_updates_env_file_and_runtime_command(self):
        old_env = os.environ.get('HERMELIN_ENV_FILE')
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                tmp = Path(tmpdir)
                hermes_home = tmp / 'hermes-home'
                hermes_home.mkdir(parents=True, exist_ok=True)
                env_file = tmp / '.hermelin.env'
                env_file.write_text(
                    'HERMELIN_HERMES_CMD="hermes chat --toolsets \\\"hermes-cli, artifacts\\\""\n',
                    encoding='utf-8',
                )
                os.environ['HERMELIN_ENV_FILE'] = str(env_file)

                config = HermelinConfig(
                    hermes_home=hermes_home,
                    meta_db_path=tmp / 'hermelin_meta.db',
                    spawn_cwd=tmp / 'spawn-cwd',
                    hermes_cmd='hermes chat --toolsets "hermes-cli, artifacts"',
                )
                app = create_app(config)
                route = _route_for_path(app, '/api/settings/default-artifacts', method='POST')

                result = asyncio.run(route.endpoint(payload={'items': [{'id': 'strudel', 'enabled': True}]}))

                self.assertTrue(result['ok'])
                self.assertTrue(result['items'][0]['enabled'])
                runtime_info_route = _route_for_path(app, '/api/info', method='GET')
                runtime_info = asyncio.run(runtime_info_route.endpoint())
                self.assertIn('strudel', runtime_info['hermes_cmd'])
                cfg_text = (hermes_home / 'config.yaml').read_text(encoding='utf-8')
                self.assertIn('default_artifacts:\n    strudel: true', cfg_text)
                self.assertIn('toolsets:\n    strudel: true', cfg_text)
                env_text = env_file.read_text(encoding='utf-8')
                self.assertIn('strudel', env_text)

                result = asyncio.run(route.endpoint(payload={'items': [{'id': 'strudel', 'enabled': False}]}))
                self.assertTrue(result['ok'])
                self.assertFalse(result['items'][0]['enabled'])
                runtime_info = asyncio.run(runtime_info_route.endpoint())
                self.assertNotIn('strudel', runtime_info['hermes_cmd'])
                cfg_text = (hermes_home / 'config.yaml').read_text(encoding='utf-8')
                self.assertIn('default_artifacts:\n    strudel: false', cfg_text)
                self.assertIn('toolsets:\n    strudel: false', cfg_text)
                env_text = env_file.read_text(encoding='utf-8')
                self.assertNotIn('strudel', env_text)
        finally:
            if old_env is None:
                os.environ.pop('HERMELIN_ENV_FILE', None)
            else:
                os.environ['HERMELIN_ENV_FILE'] = old_env


if __name__ == '__main__':
    unittest.main()
