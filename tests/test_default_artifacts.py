import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from hermelin.artifacts import list_artifacts
from hermelin.config import HermelinConfig
from hermelin.server import create_app


DEFAULT_STRUDEL_SRC = "/api/default-artifacts/strudel/index.html"


def _load_artifact_tool_module():
    module_path = Path(__file__).resolve().parents[1] / "scripts" / "hermes_artifact_patch" / "artifact_tool.py"
    spec = importlib.util.spec_from_file_location("artifact_tool_for_tests", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load artifact tool module from {module_path}")

    class _DummyRegistry:
        def register(self, *args, **kwargs):
            return None

    registry_module = types.ModuleType("tools.registry")
    registry_module.registry = _DummyRegistry()
    tools_module = types.ModuleType("tools")
    tools_module.registry = registry_module
    sys.modules.setdefault("tools", tools_module)
    sys.modules["tools.registry"] = registry_module

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _route_for_path(app, path: str):
    for route in app.router.routes:
        if getattr(route, "path", "") == path:
            return route
    raise AssertionError(f"route not found: {path}")


class DefaultArtifactsTests(unittest.TestCase):
    def test_list_artifacts_includes_default_strudel(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts"
            items = list_artifacts(artifact_root)

        strudel = next((item for item in items if item.get("id") == "strudel"), None)
        self.assertIsNotNone(strudel)
        self.assertEqual(strudel.get("type"), "iframe")
        self.assertEqual(strudel.get("title"), "Strudel")
        self.assertTrue(strudel.get("default"))
        self.assertEqual((strudel.get("data") or {}).get("src"), DEFAULT_STRUDEL_SRC)

    def test_disk_artifact_overrides_default_entry_with_same_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact_root = Path(tmpdir) / "artifacts"
            session_dir = artifact_root / "session"
            session_dir.mkdir(parents=True, exist_ok=True)
            (session_dir / "strudel.json").write_text(
                json.dumps(
                    {
                        "id": "strudel",
                        "type": "markdown",
                        "title": "Override",
                        "timestamp": 123.0,
                        "data": {"content": "hello"},
                    }
                ),
                encoding="utf-8",
            )

            items = list_artifacts(artifact_root)

        strudel = next((item for item in items if item.get("id") == "strudel"), None)
        self.assertIsNotNone(strudel)
        self.assertEqual(strudel.get("type"), "markdown")
        self.assertEqual(strudel.get("title"), "Override")
        self.assertFalse(strudel.get("default", False))
        self.assertEqual((strudel.get("data") or {}).get("content"), "hello")

    def test_server_lists_and_serves_default_strudel(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = HermelinConfig(
                hermes_home=tmp / "hermes-home",
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
            )
            app = create_app(config)

            artifacts_route = _route_for_path(app, "/api/artifacts")
            asset_route = _route_for_path(app, "/api/default-artifacts/{asset_path:path}")

            artifacts_payload = asyncio.run(artifacts_route.endpoint())
            asset_response = asyncio.run(asset_route.endpoint(asset_path="strudel/index.html"))
            asset_text = Path(asset_response.path).read_text(encoding="utf-8")

        ids = {item.get("id") for item in artifacts_payload if isinstance(item, dict)}
        self.assertIn("strudel", ids)

        self.assertEqual(asset_response.status_code, 200)
        self.assertIn("<strudel-editor", asset_text)

    def test_artifact_tool_lists_default_strudel(self):
        tool_module = _load_artifact_tool_module()

        with tempfile.TemporaryDirectory() as tmpdir:
            artifacts_home = Path(tmpdir) / "artifacts"
            tool_module.HERMES_HOME = str(Path(tmpdir))
            tool_module.ARTIFACTS_HOME = str(artifacts_home)
            tool_module.ARTIFACT_SESSION_DIR = str(artifacts_home / "session")
            tool_module.ARTIFACT_PERSISTENT_DIR = str(artifacts_home / "persistent")
            tool_module.ARTIFACTS_ROOT_DIR = str(artifacts_home)
            tool_module.RUNNERS_DIR = str(artifacts_home / "runners")
            tool_module.RUNNER_PROJECTS_DIR = str(artifacts_home / "runners" / "projects")
            tool_module.PIDS_DIR = str(artifacts_home / "pids")

            items = json.loads(tool_module.list_artifacts())

        strudel = next((item for item in items if item.get("id") == "strudel"), None)
        self.assertIsNotNone(strudel)
        self.assertEqual(strudel.get("type"), "iframe")
        self.assertEqual(strudel.get("title"), "Strudel")
        self.assertTrue(strudel.get("default"))


if __name__ == "__main__":
    unittest.main()
