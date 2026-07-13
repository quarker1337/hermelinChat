import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"


class InstallScriptCompatibilityTests(unittest.TestCase):
    def test_scripts_do_not_require_bash_4_case_conversion(self):
        incompatible = []
        pattern = re.compile(r"\$\{[^}\n]*(?:,,|\^\^)[^}\n]*\}")
        for path in sorted(SCRIPTS_DIR.glob("*.sh")):
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                if pattern.search(line):
                    incompatible.append(f"{path.name}:{line_number}: {line.strip()}")
        self.assertEqual(incompatible, [], "Bash 4-only case conversion found:\n" + "\n".join(incompatible))

    def test_installer_confirmation_runs_with_macos_bash(self):
        bash = Path("/bin/bash")
        if not bash.exists():
            self.skipTest("macOS system Bash is not available")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "repo"
            scripts = root / "scripts"
            scripts.mkdir(parents=True)
            installer = scripts / "install.sh"
            shutil.copy2(SCRIPTS_DIR / "install.sh", installer)

            home = Path(tmpdir) / "home"
            bin_dir = home / "bin"
            bin_dir.mkdir(parents=True)
            hermes = bin_dir / "hermes"
            hermes.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            hermes.chmod(hermes.stat().st_mode | stat.S_IXUSR)
            uname = bin_dir / "uname"
            uname.write_text("#!/bin/sh\nprintf 'Darwin\\n'\n", encoding="utf-8")
            uname.chmod(uname.stat().st_mode | stat.S_IXUSR)
            launchctl = bin_dir / "launchctl"
            launchctl.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            launchctl.chmod(launchctl.stat().st_mode | stat.S_IXUSR)

            env = os.environ.copy()
            env["HOME"] = str(home)
            env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
            proc = subprocess.run(
                [str(bash), str(installer), "--no-https"],
                input="N\nN\n",
                text=True,
                capture_output=True,
                env=env,
                cwd=root,
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Aborted.", proc.stdout)
        self.assertNotIn("bad substitution", proc.stderr)

    def test_installer_offers_launchagent_on_macos(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "repo"
            scripts = root / "scripts"
            scripts.mkdir(parents=True)
            installer = scripts / "install.sh"
            shutil.copy2(SCRIPTS_DIR / "install.sh", installer)

            home = Path(tmpdir) / "home"
            bin_dir = home / "bin"
            bin_dir.mkdir(parents=True)
            for name, body in {
                "hermes": "#!/bin/sh\nexit 0\n",
                "launchctl": "#!/bin/sh\nexit 0\n",
                "uname": "#!/bin/sh\nprintf 'Darwin\\n'\n",
            }.items():
                executable = bin_dir / name
                executable.write_text(body, encoding="utf-8")
                executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

            env = os.environ.copy()
            env["HOME"] = str(home)
            env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
            proc = subprocess.run(
                ["/bin/bash", str(installer), "--no-https"],
                input="Y\nN\n",
                text=True,
                capture_output=True,
                env=env,
                cwd=root,
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("install + start launchd service: yes (user)", proc.stdout)
        self.assertIn("Aborted.", proc.stdout)

    def test_installer_keeps_systemd_user_service_flow_on_linux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "repo"
            scripts = root / "scripts"
            scripts.mkdir(parents=True)
            installer = scripts / "install.sh"
            shutil.copy2(SCRIPTS_DIR / "install.sh", installer)

            home = Path(tmpdir) / "home"
            bin_dir = home / "bin"
            bin_dir.mkdir(parents=True)
            for name, body in {
                "hermes": "#!/bin/sh\nexit 0\n",
                "systemctl": "#!/bin/sh\nexit 0\n",
                "uname": "#!/bin/sh\nprintf 'Linux\\n'\n",
            }.items():
                executable = bin_dir / name
                executable.write_text(body, encoding="utf-8")
                executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

            env = os.environ.copy()
            env["HOME"] = str(home)
            env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
            proc = subprocess.run(
                ["/bin/bash", str(installer), "--no-https"],
                input="Y\nu\nN\n",
                text=True,
                capture_output=True,
                env=env,
                cwd=root,
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("install + start systemd service: yes (user)", proc.stdout)
        self.assertIn("Aborted.", proc.stdout)

    def test_python_helper_recommends_homebrew_on_macos(self):
        helper = SCRIPTS_DIR / "python_venv_hint.sh"
        proc = subprocess.run(
            [
                "/bin/bash",
                "-c",
                f'source "{helper}"; HERMELIN_PLATFORM=macos hermelin_python_venv_install_command',
            ],
            text=True,
            capture_output=True,
            cwd=REPO_ROOT,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "brew install python")


if __name__ == "__main__":
    unittest.main()
