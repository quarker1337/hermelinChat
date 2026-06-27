import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml
from fastapi.testclient import TestClient

from hermelin.config import HermelinConfig
from hermelin.server import _prepare_pty_managed_scope, create_app


class PetOverlayTests(unittest.TestCase):
    def _config(self, tmp: Path) -> HermelinConfig:
        return HermelinConfig(
            hermes_home=tmp / "hermes-home",
            meta_db_path=tmp / "hermelin_meta.db",
            spawn_cwd=tmp / "spawn-cwd",
            allowed_ips="*",
            auth_password_hash="",
            cookie_secret="test-secret",
            hermes_dashboard_enabled=False,
        )

    def _write_pet(self, hermes_home: Path, slug: str = "slime") -> bytes:
        pet_dir = hermes_home / "pets" / slug
        pet_dir.mkdir(parents=True, exist_ok=True)
        raw = b"fake-webp-spritesheet"
        (pet_dir / "spritesheet.webp").write_bytes(raw)
        (pet_dir / "pet.json").write_text(
            json.dumps(
                {
                    "id": slug,
                    "displayName": "Slime",
                    "description": "test pet",
                    "spritesheetPath": "spritesheet.webp",
                }
            ),
            encoding="utf-8",
        )
        return raw

    def test_pet_info_returns_selected_installed_pet(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = self._config(tmp)
            raw = self._write_pet(config.hermes_home)
            config.hermes_home.mkdir(parents=True, exist_ok=True)
            (config.hermes_home / "config.yaml").write_text(
                yaml.safe_dump({"display": {"pet": {"enabled": True, "slug": "slime", "scale": 0.42}}}),
                encoding="utf-8",
            )

            response = TestClient(create_app(config)).get("/api/pet/info")

            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["enabled"])
            self.assertEqual(data["slug"], "slime")
            self.assertEqual(data["displayName"], "Slime")
            self.assertEqual(data["mime"], "image/webp")
            self.assertEqual(data["scale"], 0.42)
            self.assertEqual(base64.b64decode(data["spritesheetBase64"]), raw)
            self.assertIn({"slug": "slime", "displayName": "Slime", "description": "test pet"}, data["installedPets"])

    def test_pet_info_can_return_local_slug_override_without_mutating_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = self._config(tmp)
            self._write_pet(config.hermes_home, "slime")
            ghost_raw = self._write_pet(config.hermes_home, "ghost")
            config.hermes_home.mkdir(parents=True, exist_ok=True)
            config_path = config.hermes_home / "config.yaml"
            config_path.write_text(
                yaml.safe_dump({"display": {"pet": {"enabled": True, "slug": "slime", "scale": 0.42}}}),
                encoding="utf-8",
            )

            response = TestClient(create_app(config)).get("/api/pet/info?slug=ghost")

            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertTrue(data["enabled"])
            self.assertEqual(data["source"], "override")
            self.assertEqual(data["slug"], "ghost")
            self.assertEqual(data["configuredSlug"], "slime")
            self.assertEqual(base64.b64decode(data["spritesheetBase64"]), ghost_raw)
            self.assertEqual(yaml.safe_load(config_path.read_text(encoding="utf-8"))["display"]["pet"]["slug"], "slime")

    def test_pet_info_hides_when_user_disabled_pet(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = self._config(tmp)
            self._write_pet(config.hermes_home)
            config.hermes_home.mkdir(parents=True, exist_ok=True)
            (config.hermes_home / "config.yaml").write_text(
                yaml.safe_dump({"display": {"pet": {"enabled": False, "slug": "slime"}}}),
                encoding="utf-8",
            )

            response = TestClient(create_app(config)).get("/api/pet/info")

            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertFalse(data["enabled"])
            self.assertEqual(data["slug"], "slime")
            self.assertIn({"slug": "slime", "displayName": "Slime", "description": "test pet"}, data["installedPets"])

    def test_pty_managed_scope_disables_terminal_pet_without_touching_real_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            config = self._config(tmp)
            config.hermes_home.mkdir(parents=True, exist_ok=True)
            real_config = config.hermes_home / "config.yaml"
            real_config.write_text(
                yaml.safe_dump({"display": {"pet": {"enabled": True, "slug": "slime"}}}),
                encoding="utf-8",
            )
            inherited = tmp / "managed"
            inherited.mkdir()
            (inherited / "config.yaml").write_text(
                yaml.safe_dump({"model": {"default": "example/model"}, "display": {"skin": "matrix"}}),
                encoding="utf-8",
            )

            managed_dir = _prepare_pty_managed_scope(config, {"HERMES_MANAGED_DIR": str(inherited)})

            self.assertIsNotNone(managed_dir)
            assert managed_dir is not None
            managed_config = yaml.safe_load((managed_dir / "config.yaml").read_text(encoding="utf-8"))
            self.assertEqual(managed_config["model"]["default"], "example/model")
            self.assertEqual(managed_config["display"]["skin"], "matrix")
            self.assertFalse(managed_config["display"]["pet"]["enabled"])
            self.assertIn("enabled: true", real_config.read_text(encoding="utf-8"))

    def test_pty_tui_launch_injects_pet_sidecar_and_announces_structured_sync(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            code = (
                "import os, time; "
                "print(os.environ.get('HERMES_TUI_SIDECAR_URL', 'missing'), flush=True); "
                "time.sleep(0.2)"
            )
            config = HermelinConfig(
                hermes_home=tmp / "hermes-home",
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                allowed_ips="*",
                auth_password_hash="",
                cookie_secret="test-secret",
                hermes_dashboard_enabled=False,
                hermes_cmd=f"{sys.executable} -c {json.dumps(code)} --tui",
                hermes_cmd_override=True,
                host="127.0.0.1",
                port=32123,
            )

            saw_pet_sync = False
            saw_sidecar_env = False
            with TestClient(create_app(config)) as client:
                with client.websocket_connect("/ws/pty?cols=80&rows=20") as ws:
                    for _ in range(20):
                        message = ws.receive()
                        if message.get("type") == "websocket.close":
                            break

                        text = message.get("text")
                        if text:
                            try:
                                payload = json.loads(text)
                            except Exception:
                                payload = None
                            if isinstance(payload, dict) and payload.get("type") == "pet_sync":
                                self.assertEqual(payload.get("payload", {}).get("mode"), "structured")
                                self.assertEqual(payload.get("payload", {}).get("source"), "tui-sidecar")
                                saw_pet_sync = True
                            if "/ws/pet-events-pub" in text and "channel=" in text:
                                saw_sidecar_env = True

                        data = message.get("bytes")
                        if data:
                            decoded = data.decode("utf-8", errors="ignore")
                            if "/ws/pet-events-pub" in decoded and "channel=" in decoded:
                                saw_sidecar_env = True

                        if saw_pet_sync and saw_sidecar_env:
                            break

            self.assertTrue(saw_pet_sync)
            self.assertTrue(saw_sidecar_env)

    def test_pty_tui_launch_uses_wss_and_ca_bundle_for_builtin_tls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            cert = tmp / "cert.pem"
            key = tmp / "key.pem"
            cert.write_text(
                "-----BEGIN CERTIFICATE-----\nhermelin-test-cert\n-----END CERTIFICATE-----\n",
                encoding="utf-8",
            )
            key.write_text("test-key\n", encoding="utf-8")
            code = (
                "import os, time; "
                "print(os.environ.get('HERMES_TUI_SIDECAR_URL', 'missing'), flush=True); "
                "print('SSL_CERT_FILE=' + os.environ.get('SSL_CERT_FILE', 'missing'), flush=True); "
                "time.sleep(0.2)"
            )
            config = HermelinConfig(
                hermes_home=tmp / "hermes-home",
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                allowed_ips="*",
                auth_password_hash="",
                cookie_secret="test-secret",
                hermes_dashboard_enabled=False,
                hermes_cmd=f"{sys.executable} -c {json.dumps(code)} --tui",
                hermes_cmd_override=True,
                host="127.0.0.1",
                port=32124,
                ssl_certfile=str(cert),
                ssl_keyfile=str(key),
            )

            decoded_output = ""
            with TestClient(create_app(config)) as client:
                with client.websocket_connect("/ws/pty?cols=80&rows=20") as ws:
                    for _ in range(20):
                        message = ws.receive()
                        if message.get("type") == "websocket.close":
                            break
                        data = message.get("bytes")
                        if data:
                            decoded_output += data.decode("utf-8", errors="ignore")
                        if "SSL_CERT_FILE=" in decoded_output:
                            break

            self.assertIn("wss://127.0.0.1:32124/ws/pet-events-pub", decoded_output)
            self.assertIn("SSL_CERT_FILE=", decoded_output)
            bundle_path = config.hermes_home / "hermelin" / "pet-sidecar-ca-bundle.pem"
            self.assertIn(str(bundle_path), decoded_output)
            self.assertIn("hermelin-test-cert", bundle_path.read_text(encoding="utf-8"))

    def test_pty_tui_tls_sidecar_uses_certificate_dns_for_wildcard_bind(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            cert = tmp / "cert.pem"
            key = tmp / "key.pem"
            cert.write_text(
                "-----BEGIN CERTIFICATE-----\nhermelin-test-cert\n-----END CERTIFICATE-----\n",
                encoding="utf-8",
            )
            key.write_text("test-key\n", encoding="utf-8")
            code = (
                "import os, time; "
                "print(os.environ.get('HERMES_TUI_SIDECAR_URL', 'missing'), flush=True); "
                "time.sleep(0.2)"
            )
            config = HermelinConfig(
                hermes_home=tmp / "hermes-home",
                meta_db_path=tmp / "hermelin_meta.db",
                spawn_cwd=tmp / "spawn-cwd",
                allowed_ips="*",
                auth_password_hash="",
                cookie_secret="test-secret",
                hermes_dashboard_enabled=False,
                hermes_cmd=f"{sys.executable} -c {json.dumps(code)} --tui",
                hermes_cmd_override=True,
                host="0.0.0.0",
                port=32125,
                ssl_certfile=str(cert),
                ssl_keyfile=str(key),
            )

            decoded_output = ""
            decoded_cert = {"subjectAltName": (("DNS", "chat.example.test"),)}
            with mock.patch("ssl._ssl._test_decode_cert", return_value=decoded_cert):
                with TestClient(create_app(config)) as client:
                    with client.websocket_connect("/ws/pty?cols=80&rows=20") as ws:
                        for _ in range(20):
                            message = ws.receive()
                            if message.get("type") == "websocket.close":
                                break
                            data = message.get("bytes")
                            if data:
                                decoded_output += data.decode("utf-8", errors="ignore")
                            if "ws/pet-events-pub" in decoded_output:
                                break

            self.assertIn("wss://chat.example.test:32125/ws/pet-events-pub", decoded_output)

    def test_pet_event_frames_are_not_droppable(self):
        source = (Path(__file__).resolve().parents[1] / "hermelin" / "server.py").read_text(encoding="utf-8")
        start = source.index("async def pump_pet_events_to_ws")
        end = source.index("t1 = asyncio.create_task", start)
        block = source[start:end]

        self.assertIn("payload = await queue.get()", block)
        self.assertIn("droppable=False", block)
        self.assertNotIn("droppable=True", block)


if __name__ == "__main__":
    unittest.main()
