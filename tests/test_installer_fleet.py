from __future__ import annotations

import os
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
    assert "--fleet-role ROLE" in help_result.stdout
    assert "--fleet-mode MODE" in help_result.stdout  # legacy automation remains supported
    assert "--fleet-enrollment-token-file" in help_result.stdout
    assert "--fleet-manager-profile" in help_result.stdout
    assert "--fleet-manager-host" in help_result.stdout
    assert "--fleet-token-file" in help_result.stdout
    script = INSTALLER.read_text(encoding="utf-8")
    assert 'FLEET_ROLE="standalone"' in script  # -y default
    assert 'FLEET_REPOSITORY="git@github.com:quarker1337/hermelinfleet.git"' in script
    assert 'FLEET_REF="4b8d4de8ace133f0982347d5b11c1cb3e1e3e617"' in script
    assert "Choose this HermelinChat host's role" in script
    assert "New independent FleetManager" in script
    assert "Join a remote FleetManager" in script
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


@pytest.mark.parametrize(
    "url",
    [
        "http://fleet.example.test",
        "ftp://127.0.0.1:8080",
        "http://169.254.169.254",
        "https://fleet.example.test/unexpected-path",
        "https://user@fleet.example.test",
        "https://fleet.example.test?token=bad",
        "https://fleet.example.test:invalid",
        "https://fleet.example.test;touch-bad",
    ],
)
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


def test_manager_clone_failure_reports_git_diagnostic_without_prompting(tmp_path: Path) -> None:
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "local",
        "--fleet-repository",
        "file:///definitely/missing/hermelinfleet.git",
        "--fleet-ref",
        "missing-ref",
    )

    assert result.returncode != 0
    assert "the compatible HermelinFleet source:" in result.stderr
    assert "terminal prompts disabled" not in result.stderr


def test_manager_clone_rejects_embedded_repository_credentials(tmp_path: Path) -> None:
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")
    repository = "https://user:do-not-print@example.test/fleet.git"

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "local",
        "--fleet-repository",
        repository,
        "--fleet-ref",
        "main",
    )

    assert result.returncode != 0
    assert "credential-free HTTPS, SSH, or file://" in result.stderr
    assert "do-not-print" not in result.stdout + result.stderr


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
    subprocess.run(["git", "init", "-b", "manager-test"], cwd=source, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "add", "."], cwd=source, check=True)
    subprocess.run(
        ["git", "-c", "user.name=Installer Test", "-c", "user.email=installer@example.test", "commit", "-m", "fixture"],
        cwd=source,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    fleet_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "local",
        "--fleet-repository",
        source.as_uri(),
        "--fleet-ref",
        fleet_commit,
        "--manager-profile",
        "overlay",
        "--manager-host",
        "192.168.50.10",
        env={"HOME": str(home)},
    )

    assert result.returncode == 0, result.stderr
    cloned_source = home / ".local" / "share" / "hermelinChat" / "hermelinfleet-source"
    assert (cloned_source / ".git").is_dir()
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=cloned_source, text=True).strip() == fleet_commit
    assert (home / "fleet-install.args").read_text(encoding="utf-8").strip() == (
        f"--mode combined --source {cloned_source} --profile overlay --public-host 192.168.50.10"
    )
    text = env_file.read_text(encoding="utf-8")
    assert "HERMELIN_FLEET_MODE=external" in text
    assert "HERMELIN_FLEET_URL=http://192.168.50.10:8080" in text
    assert "HERMELIN_FLEET_SERVICE_TOKEN=local-test-secret" in text
    assert "HERMELIN_FLEET_ADMIN_TOKEN" not in text
    assert "local-test-secret" not in result.stdout + result.stderr


@pytest.mark.parametrize("kind", ["public-mode", "symlink", "directory", "oversized"])
def test_node_role_rejects_unsafe_enrollment_token_files_without_changing_env(tmp_path: Path, kind: str) -> None:
    env_file = tmp_path / ".hermelin.env"
    original = "HERMELIN_PORT=3000\nHERMELIN_FLEET_MODE=external\n"
    env_file.write_text(original, encoding="utf-8")
    token_path = tmp_path / "enrollment.token"
    if kind == "public-mode":
        token_path.write_text("private-token\n", encoding="utf-8")
        token_path.chmod(0o644)
    elif kind == "symlink":
        target = tmp_path / "real.token"
        target.write_text("private-token\n", encoding="utf-8")
        target.chmod(0o600)
        token_path.symlink_to(target)
    elif kind == "directory":
        token_path.mkdir()
    else:
        token_path.write_text("a" * 9000, encoding="utf-8")
        token_path.chmod(0o600)

    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "node",
        "--url",
        "http://127.0.0.1:9",
        "--token-file",
        str(token_path),
        "--node-id",
        "safe-node",
    )

    expected_error = {
        "public-mode": "must not be accessible",
        "symlink": "could not safely open",
        "directory": "must be a regular file",
        "oversized": "between 1 byte and 8 KiB",
    }[kind]
    assert result.returncode != 0
    assert expected_error in result.stderr
    assert env_file.read_text(encoding="utf-8") == original


def test_node_role_rejects_shell_syntax_in_stdin_token_without_changing_env(tmp_path: Path) -> None:
    env_file = tmp_path / ".hermelin.env"
    original = "HERMELIN_PORT=3000\n"
    env_file.write_text(original, encoding="utf-8")
    marker = tmp_path / "must-not-exist"
    result = run_helper(
        tmp_path,
        "--env-file",
        str(env_file),
        "--mode",
        "node",
        "--url",
        "http://127.0.0.1:9",
        "--token-stdin",
        "--node-id",
        "safe-node",
        stdin=f"$(touch${{IFS}}{marker})",
    )

    assert result.returncode != 0
    assert env_file.read_text(encoding="utf-8") == original
    assert not marker.exists()


def test_node_role_redeems_header_token_and_runs_join_script_without_configuring_cockpit(tmp_path: Path) -> None:
    captured: dict[str, str] = {}
    join_script = b"""#!/bin/sh
set -eu
printf '%s|%s|%s|%s|%s|%s\n' \
  "$FLEET_NODE_ID" "$FLEET_PATCH_HERMES" \
  "$FLEET_REMOTE_RUNTIME_BACKEND" "$FLEET_REMOTE_RUNTIME_EXEC_MODE" \
  "${FLEET_ADMIN_TOKEN-unset}" "${FLEET_ENROLLMENT_TOKEN-unset}" \
  > "$HOME/node-role-result"
: > "$HOME/node-child-default-mode"
stat -c '%a' "$HOME/node-child-default-mode" > "$HOME/node-child-default-mode-result"
stat -c '%a' "$0" > "$HOME/node-role-script-mode"
"""

    class JoinHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            captured["path"] = self.path
            captured["authorization"] = self.headers.get("Authorization", "")
            captured["node_id"] = self.headers.get("X-Fleet-Node-ID", "")
            self.send_response(200)
            self.send_header("Content-Type", "text/x-shellscript; charset=utf-8")
            self.send_header("Content-Length", str(len(join_script)))
            self.end_headers()
            self.wfile.write(join_script)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            del format, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), JoinHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    token = "five-minute-node-enrollment-token"
    token_file = tmp_path / "enrollment.token"
    token_file.write_text(token + "\n", encoding="utf-8")
    token_file.chmod(0o600)
    env_file = tmp_path / ".hermelin.env"
    env_file.write_text("HERMELIN_PORT=3000\n", encoding="utf-8")
    try:
        result = run_helper(
            tmp_path,
            "--env-file",
            str(env_file),
            "--mode",
            "node",
            "--url",
            f"http://127.0.0.1:{server.server_port}",
            "--token-file",
            str(token_file),
            "--node-id",
            "remote-test-node",
            env={
                "FLEET_ADMIN_TOKEN": "must-not-reach-child",
                "FLEET_ENROLLMENT_TOKEN": "must-not-reach-child",
                "HTTP_PROXY": "http://127.0.0.1:9",
                "NO_PROXY": "",
            },
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.returncode == 0, result.stderr
    assert captured == {
        "path": "/join.sh",
        "authorization": f"Bearer {token}",
        "node_id": "remote-test-node",
    }
    home = tmp_path / "home"
    assert (home / "node-role-result").read_text(encoding="utf-8").strip() == "remote-test-node|1|tmux|trusted|unset|unset"
    assert (home / "node-role-script-mode").read_text(encoding="utf-8").strip() == "700"
    assert (home / "node-child-default-mode-result").read_text(encoding="utf-8").strip() == "600"
    text = env_file.read_text(encoding="utf-8")
    assert "HERMELIN_FLEET_MODE=off" in text
    assert "HERMELIN_FLEET_SERVICE_TOKEN" not in text
    assert token not in text
    assert token not in result.stdout + result.stderr
