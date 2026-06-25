import base64
import json
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
