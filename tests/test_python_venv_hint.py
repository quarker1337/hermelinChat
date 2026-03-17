import os
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = REPO_ROOT / "scripts" / "python_venv_hint.sh"


class PythonVenvHintTests(unittest.TestCase):
    def _make_fake_bin(self, dir_path: Path, name: str) -> None:
        path = dir_path / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _link_runtime_tool(self, dir_path: Path, name: str) -> None:
        for base in (Path("/usr/bin"), Path("/bin")):
            candidate = base / name
            if candidate.exists():
                (dir_path / name).symlink_to(candidate)
                return
        raise FileNotFoundError(name)

    def _run_helper(self, shell_snippet: str, *, os_release_text: str | None = None, fake_bins: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            os_release = tmp / "os-release"
            if os_release_text is not None:
                os_release.write_text(os_release_text, encoding="utf-8")
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            for name in ("sed", "head", "tr"):
                self._link_runtime_tool(bin_dir, name)
            for name in fake_bins:
                self._make_fake_bin(bin_dir, name)

            env = os.environ.copy()
            env["PATH"] = str(bin_dir)
            if os_release_text is not None:
                env["HERMELIN_OS_RELEASE_FILE"] = str(os_release)
            else:
                env.pop("HERMELIN_OS_RELEASE_FILE", None)

            bash_path = "/bin/bash" if Path("/bin/bash").exists() else "/usr/bin/bash"
            return subprocess.run(
                [
                    bash_path,
                    "-c",
                    f"source {shlex.quote(str(HELPER_PATH))}; {shell_snippet}",
                ],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
            )

    def test_detects_debian_family_from_os_release(self):
        proc = self._run_helper(
            "hermelin_python_venv_install_command",
            os_release_text='ID=ubuntu\nID_LIKE="debian"\n',
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "sudo apt install python3-venv")

    def test_detects_fedora_family_from_os_release(self):
        proc = self._run_helper(
            "hermelin_python_venv_install_command",
            os_release_text='ID=fedora\nID_LIKE="fedora rhel"\n',
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "sudo dnf install python3 python3-pip")

    def test_detects_arch_family_from_os_release(self):
        proc = self._run_helper(
            "hermelin_python_venv_install_command",
            os_release_text='ID=arch\nID_LIKE="archlinux"\n',
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "sudo pacman -S python python-pip")

    def test_falls_back_to_available_package_manager(self):
        proc = self._run_helper(
            "hermelin_python_venv_install_command",
            os_release_text="ID=unknown\n",
            fake_bins=("pacman",),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "sudo pacman -S python python-pip")

    def test_printed_help_tells_user_to_rerun_scripts(self):
        proc = self._run_helper(
            "hermelin_print_python_venv_fix_help",
            os_release_text='ID=ubuntu\nID_LIKE="debian"\n',
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("rerun ./scripts/update.sh", proc.stderr)
        self.assertIn("rerun ./scripts/install.sh", proc.stderr)
        self.assertIn("sudo apt install python3-venv", proc.stderr)


if __name__ == "__main__":
    unittest.main()
