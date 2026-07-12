import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from hermelin.config import HermelinConfig
from hermelin.runtime_backends import LegacyRuntimeBackend, TmuxRuntimeBackend, select_runtime_backend
from hermelin.runtime_registry import RuntimeRecord, RuntimeRegistry
from hermelin.server import create_app, _list_hermes_profiles, _safe_hermes_profile_name, _with_hermes_profile_args


def _config(tmpdir: str, **overrides) -> HermelinConfig:
    tmp = Path(tmpdir)
    kwargs = dict(
        hermes_home=tmp / "hermes-home",
        meta_db_path=tmp / "hermelin_meta.db",
        spawn_cwd=tmp / "spawn",
        allowed_ips="*",
        runtime_registry_path=tmp / "runtimes.json",
        runtime_backend="legacy",
        runtime_autostart_default=True,
    )
    kwargs.update(overrides)
    return HermelinConfig(**kwargs)  # type: ignore[arg-type]


def _write_state_session(db_path: Path, session_id: str) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)")
        conn.execute("INSERT OR REPLACE INTO sessions (id) VALUES (?)", (session_id,))
        conn.commit()
    finally:
        conn.close()


class RuntimeRegistryTests(unittest.TestCase):
    def test_registry_persists_last_active_and_records(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nested" / "runtimes.json"
            registry = RuntimeRegistry(path)

            one = registry.create_runtime(RuntimeRecord(runtime_id="rt-one", title="One", backend="legacy"))
            two = registry.create_runtime(RuntimeRecord(runtime_id="rt-two", title="Two", backend="tmux", tmux_name="hermelin-rt-two"))
            registry.remember_last_active(one.runtime_id)

            reloaded = RuntimeRegistry(path)
            self.assertEqual(reloaded.get_last_active(), "rt-one")
            self.assertEqual([r.runtime_id for r in reloaded.list_runtimes()], ["rt-one", "rt-two"])
            self.assertEqual(reloaded.get_runtime("rt-two").tmux_name, "hermelin-rt-two")  # type: ignore[union-attr]
            self.assertEqual(two.backend, "tmux")

    def test_registry_recovers_from_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "runtimes.json"
            path.write_text("not json", encoding="utf-8")
            registry = RuntimeRegistry(path)
            self.assertEqual(registry.list_runtimes(), [])
            self.assertIsNone(registry.get_last_active())


class RuntimeBackendSelectionTests(unittest.TestCase):
    def test_auto_uses_legacy_when_tmux_missing(self):
        backend = select_runtime_backend("auto", which=lambda name: None)
        self.assertIsInstance(backend, LegacyRuntimeBackend)

    def test_auto_uses_tmux_when_available(self):
        backend = select_runtime_backend("auto", tmux_prefix="hm", which=lambda name: "/usr/bin/tmux")
        self.assertIsInstance(backend, TmuxRuntimeBackend)
        assert isinstance(backend, TmuxRuntimeBackend)
        self.assertEqual(backend.tmux_name_for("abc/123"), "hm-abc-123")

    def test_explicit_legacy_is_always_available(self):
        backend = select_runtime_backend("legacy", which=lambda name: None)
        self.assertIsInstance(backend, LegacyRuntimeBackend)


class RuntimeProfileTests(unittest.TestCase):
    def test_lists_default_and_named_profiles_without_paths_or_secrets(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir) / "hermes-home"
            home.mkdir(parents=True)
            (home / "config.yaml").write_text("model:\n  default: gpt-default\n", encoding="utf-8")
            profile_dir = home / "profiles" / "otrod"
            profile_dir.mkdir(parents=True)
            (profile_dir / "config.yaml").write_text("model:\n  default: xiaomi/mimo-v2.5-pro\n", encoding="utf-8")
            (home / "profiles" / "../bad").mkdir(parents=True, exist_ok=True)

            profiles = _list_hermes_profiles(home)

        names = [item["name"] for item in profiles]
        self.assertIn("default", names)
        self.assertIn("otrod", names)
        self.assertNotIn("path", json.dumps(profiles).lower())
        otrod = next(item for item in profiles if item["name"] == "otrod")
        self.assertEqual(otrod["model"], "xiaomi/mimo-v2.5-pro")

    def test_profile_arg_injection_replaces_existing_profile_flags(self):
        self.assertEqual(_safe_hermes_profile_name("../bad"), "")
        argv = _with_hermes_profile_args(["hermes", "chat", "--profile", "old", "--toolsets", "hermes-cli"], "otrod")
        self.assertEqual(argv, ["hermes", "chat", "--toolsets", "hermes-cli", "--profile", "otrod"])
        self.assertEqual(_with_hermes_profile_args(["hermes", "chat", "--profile=old"], "default"), ["hermes", "chat", "--profile=old"])


class RuntimeApiTests(unittest.TestCase):
    def test_runtimes_api_autostarts_legacy_default_without_fleet(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, runtime_backend="legacy", runtime_autostart_default=True)
            app = create_app(config)
            with TestClient(app) as client:
                response = client.get("/api/runtimes")

            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(len(data["runtimes"]), 1)
            runtime = data["runtimes"][0]
            self.assertEqual(runtime["backend"], "legacy")
            self.assertEqual(runtime["attach_ws_path"], "/ws/pty")
            self.assertFalse(runtime["can_attach"])
            self.assertEqual(data["last_active_runtime_id"], runtime["runtime_id"])
            self.assertTrue((Path(tmpdir) / "runtimes.json").exists())

    def test_runtime_create_records_managed_source_without_requiring_fleet_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, runtime_backend="legacy", runtime_autostart_default=False)
            app = create_app(config)
            with TestClient(app) as client:
                response = client.post("/api/runtimes", json={"runtime_id": "local-one", "title": "Local One", "source": "user_ui"})

            self.assertEqual(response.status_code, 200)
            runtime = response.json()["runtime"]
            self.assertEqual(runtime["runtime_id"], "local-one")
            self.assertEqual(runtime["title"], "Local One")
            self.assertEqual(runtime["source"], "user_ui")
            self.assertEqual(runtime["backend"], "legacy")

            raw = json.loads((Path(tmpdir) / "runtimes.json").read_text(encoding="utf-8"))
            self.assertEqual(raw["last_active_runtime_id"], "local-one")
            self.assertEqual(raw["runtimes"][0]["source"], "user_ui")

    def test_runtime_create_validates_resume_session_ids(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, runtime_backend="legacy", runtime_autostart_default=False)
            _write_state_session(config.db_path, "20260630_123456_resume")
            app = create_app(config)
            with TestClient(app) as client:
                valid = client.post("/api/runtimes", json={"title": "Resume", "resume": "20260630_123456_resume"})
                invalid = client.post("/api/runtimes", json={"title": "Bad", "resume": "--help"})

            self.assertEqual(valid.status_code, 200)
            self.assertEqual(valid.json()["runtime"]["title"], "Resume")
            self.assertEqual(invalid.status_code, 400)

    def test_runtime_create_records_selected_profile_and_rejects_unknown(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, runtime_backend="legacy", runtime_autostart_default=False)
            profile_dir = config.hermes_home / "profiles" / "otrod"
            profile_dir.mkdir(parents=True, exist_ok=True)
            (profile_dir / "config.yaml").write_text("model:\n  default: xiaomi/mimo-v2.5-pro\n", encoding="utf-8")
            app = create_app(config)
            with TestClient(app) as client:
                valid = client.post("/api/runtimes", json={"runtime_id": "local-otrod", "title": "O Trod", "profile": "otrod"})
                invalid = client.post("/api/runtimes", json={"runtime_id": "local-missing", "title": "Missing", "profile": "missing"})

            self.assertEqual(valid.status_code, 200)
            self.assertEqual(valid.json()["runtime"]["profile"], "otrod")
            self.assertEqual(invalid.status_code, 400)
            self.assertIn("unknown Hermes profile", invalid.json()["detail"])

    def test_runtime_config_exposes_profiles_without_secret_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, runtime_backend="legacy")
            profile_dir = config.hermes_home / "profiles" / "otrod"
            profile_dir.mkdir(parents=True, exist_ok=True)
            (profile_dir / "config.yaml").write_text("model:\n  default: xiaomi/mimo-v2.5-pro\n", encoding="utf-8")
            app = create_app(config)
            with TestClient(app) as client:
                response = client.get("/api/runtimes/config")

            self.assertEqual(response.status_code, 200)
            data = response.json()
            names = [item["name"] for item in data["profiles"]]
            self.assertIn("default", names)
            self.assertIn("otrod", names)
            self.assertNotIn(str(config.hermes_home), json.dumps(data))

    def test_runtime_config_exposes_backend_without_secret_or_fleet_dependency(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, runtime_backend="legacy"))
            with TestClient(app) as client:
                response = client.get("/api/runtimes/config")

            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["enabled"])
            self.assertEqual(data["backend"], "legacy")
            self.assertEqual(data["configured_backend"], "legacy")
            self.assertNotIn("fleet", json.dumps(data).lower())


if __name__ == "__main__":
    unittest.main()
