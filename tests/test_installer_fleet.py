from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "configure_fleet.py"
INSTALLER = ROOT / "scripts" / "install.sh"


def test_main_installer_exposes_fleet_modes_and_local_service_dependency() -> None:
    help_result = subprocess.run(
        ["bash", str(INSTALLER), "--help"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert help_result.returncode == 0, help_result.stderr
    assert "--fleet-mode MODE" in help_result.stdout
    assert "--fleet-token-file" in help_result.stdout
    script = INSTALLER.read_text(encoding="utf-8")
    assert 'FLEET_MODE="off"' in script  # -y default
    assert 'read -r -p "Enable HermelinFleet' in script
    assert 'FLEET_UNIT_WANTS="Wants=hermelinfleet-central.service"' in script
    assert 'python3 "$SELF_DIR/configure_fleet.py"' in script
    assert 'PRESERVE_EXISTING_ENV=1' in script
    assert 'preserving existing non-Fleet env settings' in script
    assert 'local HermelinFleet is installed as a user service' in script


def run_helper(tmp_path: Path, *args: str, stdin: str = "", env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    isolated_home = tmp_path / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    merged["HOME"] = str(isolated_home)
    merged.update(env or {})
    return subprocess.run(
        [sys.executable, str(HELPER), *args],
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=merged,
        cwd=ROOT,
        check=False,
    )


def test_off_mode_removes_stale_fleet_secrets_and_preserves_other_env(tmp_path: Path) -> None:
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text(
        "HERMELIN_PORT=3000\n"
        "HERMELIN_FLEET_MODE=external\n"
        "HERMELIN_FLEET_URL=https://old.example\n"
        "HERMELIN_FLEET_SERVICE_TOKEN=stale-service-secret\n"
        "HERMELIN_FLEET_ADMIN_TOKEN=stale-secret\n",
        encoding="utf-8",
    )

    result = run_helper(tmp_path, "--env-file", str(env_file), "--mode", "off")

    assert result.returncode == 0, result.stderr
    text = env_file.read_text(encoding="utf-8")
    assert "HERMELIN_PORT=3000" in text
    assert "HERMELIN_FLEET_MODE=off" in text
    assert "HERMELIN_FLEET_URL" not in text
    assert "HERMELIN_FLEET_ADMIN_TOKEN" not in text
    assert "HERMELIN_FLEET_SERVICE_TOKEN" not in text
    assert "stale-secret" not in result.stdout + result.stderr
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600


def test_external_mode_reads_token_from_stdin_without_printing_it(tmp_path: Path) -> None:
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")
    secret = "external-test-secret"

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "external",
        "--url",
        "https://fleet.example.test",
        "--token-stdin",
        stdin=secret,
    )

    assert result.returncode == 0, result.stderr
    text = env_file.read_text(encoding="utf-8")
    assert "HERMELIN_FLEET_MODE=external" in text
    assert "HERMELIN_FLEET_URL=https://fleet.example.test" in text
    assert f"HERMELIN_FLEET_SERVICE_TOKEN={secret}" in text
    assert "HERMELIN_FLEET_ADMIN_TOKEN" not in text
    assert secret not in result.stdout + result.stderr


@pytest.mark.parametrize("url", ["http://fleet.example.test", "ftp://127.0.0.1:8080", "http://169.254.169.254"])
def test_external_mode_rejects_unsafe_url(tmp_path: Path, url: str) -> None:
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "external",
        "--url",
        url,
        "--token-stdin",
        stdin="secret",
    )

    assert result.returncode != 0
    assert "unsafe Fleet URL" in result.stderr
    assert "secret" not in result.stdout + result.stderr


def test_local_mode_rejects_mismatched_fleet_contract_before_install(tmp_path: Path) -> None:
    source = tmp_path / "fleet-mismatch"
    (source / "scripts").mkdir(parents=True)
    (source / "contracts").mkdir(parents=True)
    installer = source / "scripts" / "install.sh"
    installer.write_text("#!/usr/bin/env sh\ntouch \"$HOME/installer-ran\"\n", encoding="utf-8")
    installer.chmod(0o755)
    (source / "contracts" / "hermelinfleet-api-v1.json").write_text(
        '{"contract_id":"wrong","api_prefix":"/api/v1"}\n', encoding="utf-8"
    )
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "local",
        "--fleet-source",
        str(source),
    )

    assert result.returncode != 0
    assert "contract does not match" in result.stderr
    assert not (tmp_path / "home" / "installer-ran").exists()


def test_local_mode_invokes_fleet_installer_and_imports_scoped_service_secret(tmp_path: Path) -> None:
    home = tmp_path / "home"
    source = tmp_path / "fleet"
    scripts = source / "scripts"
    scripts.mkdir(parents=True)
    contracts = source / "contracts"
    contracts.mkdir(parents=True)
    contracts.joinpath("hermelinfleet-api-v1.json").write_text(
        (ROOT / "contracts" / "hermelinfleet-api-v1.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    installer = scripts / "install.sh"
    installer.write_text(
        "#!/usr/bin/env sh\n"
        "set -eu\n"
        "printf '%s\\n' \"$*\" > \"$HOME/fleet-install.args\"\n"
        "mkdir -p \"$HOME/.config/hermelinfleet\"\n"
        "printf 'FLEET_HERMELIN_TOKEN=local-test-secret\\n' > \"$HOME/.config/hermelinfleet/central.env\"\n"
        "chmod 600 \"$HOME/.config/hermelinfleet/central.env\"\n",
        encoding="utf-8",
    )
    installer.chmod(0o755)
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "local",
        "--fleet-source",
        str(source),
        env={"HOME": str(home)},
    )

    assert result.returncode == 0, result.stderr
    assert (home / "fleet-install.args").read_text(encoding="utf-8").strip() == f"--mode combined --source {source}"
    text = env_file.read_text(encoding="utf-8")
    assert "HERMELIN_FLEET_MODE=local" in text
    assert "HERMELIN_FLEET_URL=http://127.0.0.1:8080" in text
    assert "HERMELIN_FLEET_SERVICE_TOKEN=local-test-secret" in text
    assert "HERMELIN_FLEET_ADMIN_TOKEN" not in text
    assert "local-test-secret" not in result.stdout + result.stderr
