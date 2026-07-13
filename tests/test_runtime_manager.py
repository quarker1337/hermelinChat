import asyncio
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from hermelin.config import HermelinConfig
from hermelin.runtime_backends import (
    LegacyRuntimeBackend,
    RuntimeCreateRequest,
    TmuxRuntimeBackend,
    select_runtime_backend,
)
from hermelin.runtime_registry import RuntimeRecord, RuntimeRegistry
from hermelin.server import (
    _hermes_profile_state_db_path,
    _list_hermes_profiles,
    _safe_hermes_profile_name,
    _with_hermes_profile_args,
    create_app,
)


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


def _write_history_session(db_path: Path, session_id: str, title: str, started_at: float = 1.0) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                user_id TEXT,
                model TEXT,
                model_config TEXT,
                system_prompt TEXT,
                parent_session_id TEXT,
                started_at REAL NOT NULL,
                ended_at REAL,
                end_reason TEXT,
                message_count INTEGER DEFAULT 0,
                tool_call_count INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                title TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                timestamp REAL NOT NULL
            );
            """
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO sessions (
                id, source, started_at, message_count, tool_call_count,
                input_tokens, output_tokens, title
            ) VALUES (?, 'cli', ?, 0, 0, 0, 0, ?)
            """,
            (session_id, started_at, title),
        )
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

    def test_tmux_launch_keeps_sidecar_capability_out_of_process_argv(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            backend = TmuxRuntimeBackend(tmux_bin="tmux", prefix="hm")
            captured: dict[str, object] = {}
            token = "sidecar-secret-1234567890-abcdefgh"

            def fake_run(args, *, env=None, timeout=5.0):
                if args[0] == "has-session":
                    return subprocess.CompletedProcess(args, 1, "", "")
                if args[0] == "display-message":
                    return subprocess.CompletedProcess(args, 0, "123\n", "")
                if args[0] == "new-session":
                    captured["args"] = list(args)
                    captured["env"] = dict(env or {})
                    launcher = Path(str(args[-1]).split()[-1])
                    captured["launcher"] = launcher
                    captured["script"] = launcher.read_text(encoding="utf-8")
                    captured["mode"] = launcher.stat().st_mode & 0o777
                    return subprocess.CompletedProcess(args, 0, "", "")
                raise AssertionError(args)

            request = RuntimeCreateRequest(
                runtime_id="demo",
                title="demo",
                profile="default",
                cwd=tmp / "cwd",
                source="user_ui",
                command=["/usr/bin/hermes", "chat", "--tui"],
                env={
                    "PATH": "/usr/bin",
                    "HOME": str(tmp),
                    "HERMES_TUI_SIDECAR_URL": (
                        f"wss://chat.test/ws/pet-events-pub?token={token}&channel=runtime-demo"
                    ),
                },
                launcher_dir=tmp / "launchers",
            )

            with mock.patch.object(backend, "available", return_value=True):
                with mock.patch.object(backend, "_run", side_effect=fake_run):
                    record = asyncio.run(backend.create(request))

            self.assertEqual(record.hermes_pid, 123)
            self.assertNotIn(token, json.dumps(captured["args"]))
            self.assertNotIn(token, json.dumps(captured["env"]))
            self.assertIn(token, str(captured["script"]))
            self.assertIn('rm -f -- "$0"', str(captured["script"]))
            self.assertEqual(captured["mode"], 0o600)
            Path(captured["launcher"]).unlink(missing_ok=True)  # type: ignore[arg-type]


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
            outside = Path(tmpdir) / "outside-profile"
            outside.mkdir()
            (home / "profiles" / "linked").symlink_to(outside, target_is_directory=True)

            profiles = _list_hermes_profiles(home)

        names = [item["name"] for item in profiles]
        self.assertIn("default", names)
        self.assertIn("otrod", names)
        self.assertNotIn("linked", names)
        self.assertNotIn("path", json.dumps(profiles).lower())
        otrod = next(item for item in profiles if item["name"] == "otrod")
        self.assertEqual(otrod["model"], "xiaomi/mimo-v2.5-pro")

    def test_profile_arg_injection_replaces_existing_profile_flags(self):
        self.assertEqual(_safe_hermes_profile_name("../bad"), "")
        argv = _with_hermes_profile_args(["hermes", "chat", "--profile", "old", "--toolsets", "hermes-cli"], "otrod")
        self.assertEqual(argv, ["hermes", "chat", "--toolsets", "hermes-cli", "--profile", "otrod"])
        self.assertEqual(_with_hermes_profile_args(["hermes", "chat", "--profile=old"], "default"), ["hermes", "chat", "--profile=old"])

    def test_profile_state_db_path_is_bounded_to_known_layout(self):
        home = Path("/tmp/hermes-home")
        self.assertEqual(_hermes_profile_state_db_path(home, "default"), home / "state.db")
        self.assertEqual(_hermes_profile_state_db_path(home, "otrod"), home / "profiles" / "otrod" / "state.db")
        with self.assertRaises(ValueError):
            _hermes_profile_state_db_path(home, "../escape")


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

    def test_session_history_and_resume_use_selected_profile_database(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = _config(tmpdir, runtime_backend="legacy", runtime_autostart_default=False)
            _write_history_session(config.db_path, "default-session", "Default history")
            profile_dir = config.hermes_home / "profiles" / "otrod"
            profile_dir.mkdir(parents=True, exist_ok=True)
            (profile_dir / "config.yaml").write_text("model:\n  default: xiaomi/mimo-v2.5-pro\n", encoding="utf-8")
            profile_db = profile_dir / "state.db"
            _write_history_session(profile_db, "otrod-session", "Otrod history")

            with TestClient(create_app(config)) as client:
                default_history = client.get("/api/sessions?profile=default")
                otrod_history = client.get("/api/sessions?profile=otrod")
                invalid_history = client.get("/api/sessions?profile=../escape")
                profile_resume = client.post(
                    "/api/runtimes",
                    json={"title": "Resume Otrod", "profile": "otrod", "resume": "otrod-session"},
                )
                wrong_profile_resume = client.post(
                    "/api/runtimes",
                    json={"title": "Wrong profile", "profile": "default", "resume": "otrod-session"},
                )

            default_items = default_history.json()["sessions"]
            otrod_items = otrod_history.json()["sessions"]
            self.assertEqual(default_history.status_code, 200)
            self.assertEqual([item["id"] for item in default_items], ["default-session"])
            self.assertEqual(default_items[0]["profile"], "default")
            self.assertEqual(otrod_history.status_code, 200)
            self.assertEqual([item["id"] for item in otrod_items], ["otrod-session"])
            self.assertEqual(otrod_items[0]["profile"], "otrod")
            self.assertEqual(invalid_history.status_code, 400)
            self.assertEqual(profile_resume.status_code, 200)
            self.assertEqual(profile_resume.json()["runtime"]["profile"], "otrod")
            self.assertEqual(wrong_profile_resume.status_code, 400)

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

    def test_legacy_websocket_rejects_invalid_profile_before_spawning(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            app = create_app(_config(tmpdir, runtime_backend="legacy", runtime_autostart_default=False))
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/ws/pty?profile=../escape",
                    headers={"origin": "http://testserver"},
                ) as websocket:
                    message = websocket.receive()

            self.assertEqual(message.get("type"), "websocket.close")
            self.assertEqual(message.get("code"), 1008)


if __name__ == "__main__":
    unittest.main()
