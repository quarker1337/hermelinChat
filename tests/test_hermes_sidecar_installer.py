from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_script(filename: str, module_name: str):
    path = ROOT / "scripts" / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


UPSTREAM_PUBLISHER = textwrap.dedent(
    '''\
    from __future__ import annotations

    import json
    import logging
    import queue
    import threading
    from typing import Optional

    try:
        from websockets.sync.client import connect as ws_connect
    except ImportError:
        ws_connect = None

    _log = logging.getLogger(__name__)
    _DRAIN_STOP = object()
    _QUEUE_MAX = 256


    class WsPublisherTransport:
        __slots__ = ("_url", "_lock", "_ws", "_dead", "_q", "_worker")

        def __init__(self, url: str, *, connect_timeout: float = 2.0) -> None:
            self._url = url
            self._lock = threading.Lock()
            self._ws: Optional[object] = None
            self._dead = False
            self._q: queue.Queue[object] = queue.Queue(maxsize=_QUEUE_MAX)
            self._worker: Optional[threading.Thread] = None

            if ws_connect is None:
                self._dead = True

                return

            try:
                self._ws = ws_connect(url, open_timeout=connect_timeout, max_size=None)
            except Exception as exc:
                _log.debug("event publisher connect failed: %s", exc)
                self._dead = True
                self._ws = None

                return

            self._worker = threading.Thread(
                target=self._drain,
                name="hermes-ws-pub",
                daemon=True,
            )
            self._worker.start()

        def _drain(self) -> None:
            while True:
                item = self._q.get()
                if item is _DRAIN_STOP:
                    return
                if not isinstance(item, str):
                    continue
                if self._ws is None:
                    continue
                try:
                    with self._lock:
                        if self._ws is not None:
                            self._ws.send(item)
                except Exception as exc:
                    _log.debug("event publisher write failed: %s", exc)
                    self._dead = True
                    self._ws = None

        def write(self, obj: dict) -> bool:
            if self._dead or self._ws is None or self._worker is None:
                return False

            line = json.dumps(obj, ensure_ascii=False)

            try:
                self._q.put_nowait(line)

                return True
            except queue.Full:
                return False

        def close(self) -> None:
            self._dead = True
            w = self._worker
            if w is not None and w.is_alive():
                try:
                    self._q.put_nowait(_DRAIN_STOP)
                except queue.Full:
                    pass
                w.join(timeout=3.0)
            self._worker = None

            if self._ws is None:
                return

            try:
                with self._lock:
                    if self._ws is not None:
                        self._ws.close()
            except Exception:
                pass

            self._ws = None
    '''
)


class _FakeSocket:
    def __init__(self, *, fail_send: bool = False) -> None:
        self.fail_send = fail_send
        self.sent: list[str] = []
        self.closed = False

    def send(self, payload: str) -> None:
        if self.fail_send:
            self.fail_send = False
            raise OSError("server restarted")
        self.sent.append(payload)

    def close(self) -> None:
        self.closed = True


class HermesSidecarInstallerTests(unittest.TestCase):
    def test_full_installer_discovers_patches_and_unpatches_fake_hermes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "tools").mkdir()
            (root / "tui_gateway").mkdir()
            (root / "tools" / "__init__.py").write_text("", encoding="utf-8")
            (root / "tui_gateway" / "__init__.py").write_text("", encoding="utf-8")
            event_publisher = root / "tui_gateway" / "event_publisher.py"
            event_publisher.write_text(UPSTREAM_PUBLISHER, encoding="utf-8")
            (root / "model_tools.py").write_text(
                "def discover_builtin_tools():\n"
                "    return None\n\n"
                "discover_builtin_tools()\n",
                encoding="utf-8",
            )
            (root / "toolsets.py").write_text(
                'TOOLSETS = {\n    "base": {},\n\n'
                "    # Scenario-specific toolsets\n}\n",
                encoding="utf-8",
            )
            hermes_exe = root / "hermes"
            hermes_exe.write_text(f"#!{sys.executable}\n", encoding="utf-8")
            hermes_exe.chmod(0o755)
            env = dict(os.environ, PYTHONPATH=str(root))
            common = [
                "--hermes-exe",
                str(hermes_exe),
                "--hermes-python",
                sys.executable,
            ]
            install_command = [
                sys.executable,
                str(ROOT / "scripts" / "install_hermes_artifact_patch.py"),
                *common,
            ]
            uninstall_command = [
                sys.executable,
                str(ROOT / "scripts" / "uninstall_hermes_artifact_patch.py"),
                *common,
            ]

            first = subprocess.run(
                install_command,
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            first_source = event_publisher.read_text(encoding="utf-8")
            second = subprocess.run(
                install_command,
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            second_source = event_publisher.read_text(encoding="utf-8")
            removed = subprocess.run(
                uninstall_command,
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertIn("restart-safe HermelinChat activity events", first.stdout)
            self.assertIn("restarting only HermelinChat preserves tmux runtimes", first.stdout)
            self.assertIn("restart-safe sidecar reconnect patch", first_source)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("already supports restart-safe sidecar reconnect", second.stdout)
            self.assertEqual(second_source, first_source)
            self.assertEqual(removed.returncode, 0, removed.stderr)
            self.assertIn("Removed hermelinChat sidecar reconnect patch", removed.stdout)
            self.assertEqual(event_publisher.read_text(encoding="utf-8"), UPSTREAM_PUBLISHER)
            self.assertFalse((root / "tools" / "artifact_tool.py").exists())

    def test_patch_is_idempotent_and_reconnects_after_broken_socket(self):
        installer = _load_script(
            "install_hermes_artifact_patch.py",
            "install_hermes_artifact_patch_sidecar_tests",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "event_publisher.py"
            target.write_text(UPSTREAM_PUBLISHER, encoding="utf-8")

            changed, _message = installer._patch_event_publisher(target)
            changed_again, _message_again = installer._patch_event_publisher(target)

            self.assertTrue(changed)
            self.assertFalse(changed_again)
            patched = target.read_text(encoding="utf-8")
            self.assertIn(installer.SIDECAR_RECONNECT_PATCH_MARKER, patched)
            compile(patched, str(target), "exec")

            spec = importlib.util.spec_from_file_location("patched_event_publisher", target)
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            first = _FakeSocket(fail_send=True)
            replacement = _FakeSocket()
            sockets = iter([first, replacement])
            setattr(module, "ws_connect", lambda _url, **_kwargs: next(sockets))
            publisher = module.WsPublisherTransport("ws://chat.test/ws/pet-events-pub")
            try:
                self.assertTrue(publisher.write({"type": "message.start", "payload": {}}))
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and not replacement.sent:
                    time.sleep(0.01)
            finally:
                publisher.close()

            self.assertTrue(replacement.sent)
            self.assertTrue(first.closed)

    def test_unpatch_preserves_upstream_type_ignore_suffixes_exactly(self):
        installer = _load_script(
            "install_hermes_artifact_patch.py",
            "install_hermes_artifact_patch_type_ignore_fixture",
        )
        uninstaller = _load_script(
            "uninstall_hermes_artifact_patch.py",
            "uninstall_hermes_artifact_patch_type_ignore_fixture",
        )
        source = UPSTREAM_PUBLISHER.replace(
            "self._ws.send(item)",
            "self._ws.send(item)  # type: ignore[union-attr]",
        ).replace(
            "self._ws.close()",
            "self._ws.close()  # type: ignore[union-attr]",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "event_publisher.py"
            target.write_text(source, encoding="utf-8")

            installer._patch_event_publisher(target)
            changed, _message = uninstaller._unpatch_event_publisher(target)

            self.assertTrue(changed)
            self.assertEqual(target.read_text(encoding="utf-8"), source)

    def test_unpatch_restores_original_publisher(self):
        installer = _load_script(
            "install_hermes_artifact_patch.py",
            "install_hermes_artifact_patch_unpatch_fixture",
        )
        uninstaller = _load_script(
            "uninstall_hermes_artifact_patch.py",
            "uninstall_hermes_artifact_patch_sidecar_tests",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "event_publisher.py"
            target.write_text(UPSTREAM_PUBLISHER, encoding="utf-8")
            installer._patch_event_publisher(target)

            changed, _message = uninstaller._unpatch_event_publisher(target)

            self.assertTrue(changed)
            self.assertEqual(target.read_text(encoding="utf-8"), UPSTREAM_PUBLISHER)


if __name__ == "__main__":
    unittest.main()
