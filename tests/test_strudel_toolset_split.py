import importlib.util
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


if __name__ == "__main__":
    unittest.main()
