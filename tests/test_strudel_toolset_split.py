import importlib.util
import tempfile
import unittest
from pathlib import Path


def _load_install_patch_module():
    module_path = Path(__file__).resolve().parents[1] / "scripts" / "install_hermes_artifact_patch.py"
    spec = importlib.util.spec_from_file_location("install_hermes_artifact_patch_for_tests", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StrudelToolsetSplitTests(unittest.TestCase):
    def test_install_patch_registers_separate_artifacts_and_strudel_toolsets(self):
        module = _load_install_patch_module()
        block = module.ARTIFACT_TOOLSETS_BLOCK

        self.assertIn('"artifacts": {', block)
        self.assertIn('"strudel": {', block)

        artifacts_section = block.split('"artifacts": {', 1)[1].split('"strudel": {', 1)[0]
        strudel_section = block.split('"strudel": {', 1)[1]

        self.assertIn('"create_artifact"', artifacts_section)
        self.assertIn('"artifact_bridge_command"', artifacts_section)
        self.assertNotIn('"strudel_get_code"', artifacts_section)
        self.assertNotIn('"strudel_play"', artifacts_section)

        self.assertIn('"strudel_get_code"', strudel_section)
        self.assertIn('"strudel_stop"', strudel_section)
        self.assertNotIn('"create_artifact"', strudel_section)

    def test_detect_hermes_python_follows_shell_wrapper_to_console_script(self):
        module = _load_install_patch_module()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_python = root / "venv" / "bin" / "python"
            console_script = root / "venv" / "bin" / "hermes"
            wrapper = root / "bin" / "hermes"

            fake_python.parent.mkdir(parents=True)
            wrapper.parent.mkdir(parents=True)
            fake_python.write_text("", encoding="utf-8")
            console_script.write_text(f"#!{fake_python}\n", encoding="utf-8")
            wrapper.write_text(
                f'#!/usr/bin/env bash\nunset PYTHONPATH\nexec "{console_script}" "$@"\n',
                encoding="utf-8",
            )

            detected = module._detect_hermes_python(wrapper, "")

        self.assertEqual(detected, fake_python)

    def test_detect_hermes_python_rejects_shell_wrapper_without_exec_target(self):
        module = _load_install_patch_module()

        with tempfile.TemporaryDirectory() as tmp:
            wrapper = Path(tmp) / "hermes"
            wrapper.write_text("#!/usr/bin/env bash\necho hermes\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "non-Python interpreter"):
                module._detect_hermes_python(wrapper, "")


if __name__ == "__main__":
    unittest.main()
