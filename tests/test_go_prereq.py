from __future__ import annotations

import os
import shutil
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = REPO_ROOT / "scripts" / "go_prereq.sh"


class GoPrerequisiteTests(unittest.TestCase):
    def _link_runtime_tool(self, directory: Path, name: str) -> None:
        for base in (Path("/usr/bin"), Path("/bin")):
            candidate = base / name
            if candidate.exists():
                (directory / name).symlink_to(candidate)
                return
        raise FileNotFoundError(name)

    def _fake_tool(self, directory: Path, name: str, body: str = "exit 0") -> Path:
        path = directory / name
        path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def _run(
        self,
        snippet: str,
        *,
        os_release: str = "ID=unknown\n",
        fake_tools: dict[str, str] | None = None,
        home_go: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            home = tmp / "home"
            home.mkdir()
            os_release_path = tmp / "os-release"
            os_release_path.write_text(os_release, encoding="utf-8")
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            for name in ("sed", "head", "tr"):
                self._link_runtime_tool(bin_dir, name)
            for name, body in (fake_tools or {}).items():
                self._fake_tool(bin_dir, name, body)
            if home_go is not None:
                go_path = home / ".local" / "go" / "bin" / "go"
                go_path.parent.mkdir(parents=True)
                go_path.write_text(f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(home_go)}\n", encoding="utf-8")
                go_path.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "HOME": str(home),
                    "PATH": str(bin_dir),
                    "HERMELIN_OS_RELEASE_FILE": str(os_release_path),
                }
            )
            bash = "/bin/bash" if Path("/bin/bash").exists() else "/usr/bin/bash"
            return subprocess.run(
                [bash, "-c", f"source {shlex.quote(str(HELPER_PATH))}; {snippet}"],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_reports_debian_install_command(self) -> None:
        proc = self._run(
            "hermelin_go_install_command",
            os_release='ID=ubuntu\nID_LIKE="debian"\n',
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            proc.stdout.strip(),
            "sudo apt-get update && sudo apt-get install -y golang-go",
        )

    def test_reports_fedora_and_arch_install_commands(self) -> None:
        fedora = self._run(
            "hermelin_go_install_command",
            os_release='ID=fedora\nID_LIKE="rhel"\n',
        )
        arch = self._run(
            "hermelin_go_install_command",
            os_release='ID=arch\nID_LIKE="archlinux"\n',
        )
        self.assertEqual(fedora.stdout.strip(), "sudo dnf install -y golang")
        self.assertEqual(arch.stdout.strip(), "sudo pacman -S --needed go")

    def test_finds_user_local_go_even_when_not_in_path(self) -> None:
        proc = self._run(
            'go_bin="$(hermelin_find_go)" && printf "%s\\n" "$go_bin" && hermelin_go_meets_minimum "$go_bin"',
            home_go="go version go1.22.12 linux/amd64",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.strip().endswith("/.local/go/bin/go"))

    def test_rejects_go_older_than_1_22(self) -> None:
        proc = self._run(
            'go_bin="$(hermelin_find_go)" && hermelin_go_meets_minimum "$go_bin"',
            home_go="go version go1.21.13 linux/amd64",
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_package_install_uses_sudo_without_eval(self) -> None:
        proc = self._run(
            "hermelin_install_go_package",
            os_release='ID=ubuntu\nID_LIKE="debian"\n',
            fake_tools={
                "sudo": 'printf "%s\\n" "$*"',
                "apt-get": "exit 0",
            },
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            proc.stdout.splitlines(),
            ["apt-get update", "apt-get install -y golang-go"],
        )

    def test_help_mentions_minimum_version_rerun_and_exact_command(self) -> None:
        proc = self._run(
            "hermelin_print_go_fix_help",
            os_release='ID=ubuntu\nID_LIKE="debian"\n',
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Go 1.22 or newer", proc.stderr)
        self.assertIn("sudo apt-get update && sudo apt-get install -y golang-go", proc.stderr)
        self.assertIn("rerun ./scripts/install.sh", proc.stderr)

    def test_role_two_installer_offers_and_verifies_sudo_go_install(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            root = tmp / "hermelinChat"
            scripts = root / "scripts"
            scripts.mkdir(parents=True)
            shutil.copy2(REPO_ROOT / "scripts" / "install.sh", scripts / "install.sh")
            shutil.copy2(HELPER_PATH, scripts / "go_prereq.sh")

            (scripts / "configure_fleet.py").write_text(
                "from pathlib import Path\n"
                "import os, sys\n"
                "Path(os.environ['HOME'], 'configure-fleet.args').write_text(' '.join(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            (scripts / "update.sh").write_text(
                "#!/bin/sh\nset -eu\nmkdir -p hermelin/static\nprintf '<html></html>\\n' > hermelin/static/index.html\n",
                encoding="utf-8",
            )
            (scripts / "update.sh").chmod(0o755)

            home = tmp / "home"
            local_bin = home / ".local" / "bin"
            local_bin.mkdir(parents=True)
            hermes = local_bin / "hermes"
            hermes.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            hermes.chmod(0o755)

            fake_bin = tmp / "bin"
            fake_bin.mkdir()
            installed_go = home / ".local" / "go" / "bin" / "go"
            sudo = fake_bin / "sudo"
            sudo.write_text(
                "#!/bin/sh\n"
                "set -eu\n"
                "printf '%s\\n' \"$*\" >> \"$HOME/sudo.calls\"\n"
                "case \"$*\" in\n"
                "  'apt-get install -y golang-go')\n"
                "    mkdir -p \"$(dirname \"$HERMELIN_TEST_GO\")\"\n"
                "    printf '%s\\n' '#!/bin/sh' \"echo 'go version go1.22.12 linux/amd64'\" > \"$HERMELIN_TEST_GO\"\n"
                "    chmod 755 \"$HERMELIN_TEST_GO\"\n"
                "    ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            sudo.chmod(0o755)
            systemctl = fake_bin / "systemctl"
            systemctl.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            systemctl.chmod(0o755)

            os_release = tmp / "os-release"
            os_release.write_text('ID=ubuntu\nID_LIKE="debian"\n', encoding="utf-8")
            env_file = root / ".hermelin.env"
            env_file.write_text("HERMELIN_PORT=3000\nHERMELIN_PASSWORD_HASH='set'\n", encoding="utf-8")

            env = os.environ.copy()
            env.update(
                {
                    "HOME": str(home),
                    "PATH": f"{fake_bin}:{local_bin}:/usr/bin:/bin",
                    "HERMELIN_OS_RELEASE_FILE": str(os_release),
                    "HERMELIN_TEST_GO": str(installed_go),
                }
            )
            result = subprocess.run(
                [
                    "/bin/bash",
                    str(scripts / "install.sh"),
                    "--no-https",
                    "--user-service",
                    "--fleet-role",
                    "manager",
                    "--fleet-manager-profile",
                    "overlay",
                    "--fleet-manager-host",
                    "192.168.50.10",
                    "--env-file",
                    str(env_file),
                ],
                input="y\ny\n",
                text=True,
                capture_output=True,
                cwd=root,
                env=env,
                check=False,
            )

            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            self.assertIn("needs Go 1.22 or newer", combined)
            self.assertIn("sudo apt-get update && sudo apt-get install -y golang-go", combined)
            self.assertIn("sudo may ask for your account password", combined)
            self.assertIn("Go prerequisite satisfied: go version go1.22.12", combined)
            self.assertEqual(
                (home / "sudo.calls").read_text(encoding="utf-8").splitlines(),
                ["apt-get update", "apt-get install -y golang-go"],
            )
            self.assertIn("--mode local", (home / "configure-fleet.args").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
