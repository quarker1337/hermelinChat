from __future__ import annotations

import asyncio
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol

from .pty_handler import PtyProcess
from .runtime_registry import RuntimeRecord, utc_ts


_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PROC_FIELD_LIMIT = 1_048_576


def _safe_session_id(value: object) -> str | None:
    session_id = str(value or "").strip()
    return session_id if _SESSION_ID_RE.fullmatch(session_id) else None


def _session_id_for_process_tree(
    root_pid: int | None,
    *,
    proc_root: Path = Path("/proc"),
    max_processes: int = 256,
) -> str | None:
    """Find a validated Hermes session ID in a managed process tree."""
    try:
        root = int(root_pid or 0)
    except (TypeError, ValueError):
        return None
    if root <= 0:
        return None

    queue = [root]
    seen: set[int] = set()
    while queue and len(seen) < max(1, int(max_processes)):
        pid = queue.pop(0)
        if pid <= 0 or pid in seen:
            continue
        seen.add(pid)
        proc_dir = proc_root / str(pid)

        try:
            environ = (proc_dir / "environ").read_bytes()[:_PROC_FIELD_LIMIT]
            for item in environ.split(b"\0"):
                if item.startswith(b"HERMES_SESSION_ID="):
                    value = item.split(b"=", 1)[1].decode("utf-8", errors="replace")
                    session_id = _safe_session_id(value)
                    if session_id:
                        return session_id
        except (OSError, ValueError):
            pass

        try:
            cmdline = (proc_dir / "cmdline").read_bytes()[:_PROC_FIELD_LIMIT]
            args = [part.decode("utf-8", errors="replace") for part in cmdline.split(b"\0") if part]
            for index, arg in enumerate(args):
                candidate = None
                if arg == "--session-key" and index + 1 < len(args):
                    candidate = args[index + 1]
                elif arg.startswith("--session-key="):
                    candidate = arg.split("=", 1)[1]
                session_id = _safe_session_id(candidate)
                if session_id:
                    return session_id
        except (OSError, ValueError):
            pass

        try:
            children_path = proc_dir / "task" / str(pid) / "children"
            child_values = children_path.read_text(encoding="utf-8", errors="replace")[:_PROC_FIELD_LIMIT].split()
            queue.extend(int(value) for value in child_values if value.isdigit())
        except (OSError, ValueError):
            pass
    return None


class RuntimeBackendError(RuntimeError):
    pass


@dataclass(slots=True)
class RuntimeCreateRequest:
    runtime_id: str
    title: str
    profile: str
    cwd: Path
    source: str
    command: list[str]
    env: dict[str, str]
    launcher_dir: Path | None = None
    tmux_name: str | None = None
    cols: int = 120
    rows: int = 30


@dataclass(slots=True)
class RuntimeStatus:
    exists: bool
    state: str
    hermes_pid: int | None = None
    active_hermes_session_id: str | None = None


class RuntimeBackend(Protocol):
    name: str

    def available(self) -> bool: ...
    async def create(self, request: RuntimeCreateRequest) -> RuntimeRecord: ...
    async def stop(self, runtime: RuntimeRecord) -> None: ...
    async def status(self, runtime: RuntimeRecord) -> RuntimeStatus: ...


class LegacyRuntimeBackend:
    name = "legacy"

    def available(self) -> bool:
        return True

    async def create(self, request: RuntimeCreateRequest) -> RuntimeRecord:
        return RuntimeRecord(
            runtime_id=request.runtime_id,
            title=request.title,
            profile=request.profile,
            cwd=str(request.cwd),
            state="idle",
            source=request.source,
            backend=self.name,
            metadata={"legacy_ws_path": "/ws/pty"},
        )

    async def stop(self, runtime: RuntimeRecord) -> None:
        return None

    async def status(self, runtime: RuntimeRecord) -> RuntimeStatus:
        return RuntimeStatus(exists=True, state="idle", hermes_pid=None)


class TmuxRuntimeBackend:
    name = "tmux"

    def __init__(self, *, tmux_bin: str = "tmux", prefix: str = "hermelin"):
        self.tmux_bin = tmux_bin
        self.prefix = prefix

    def available(self) -> bool:
        return shutil.which(self.tmux_bin) is not None

    def tmux_name_for(self, runtime_id: str) -> str:
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in str(runtime_id))
        return f"{self.prefix}-{safe}"

    def _run(self, args: list[str], *, env: Mapping[str, str] | None = None, timeout: float = 5.0) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.tmux_bin, *args],
            env=dict(env) if env is not None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def has_session(self, name: str) -> bool:
        result = self._run(["has-session", "-t", name], timeout=2.0)
        return result.returncode == 0

    def pane_pid(self, name: str) -> int | None:
        result = self._run(["display-message", "-p", "-t", name, "#{pane_pid}"], timeout=2.0)
        if result.returncode != 0:
            return None
        try:
            value = int((result.stdout or "").strip().splitlines()[0])
            return value if value > 0 else None
        except Exception:
            return None

    def _write_private_launcher(
        self,
        request: RuntimeCreateRequest,
        env: Mapping[str, str],
    ) -> Path:
        launcher_dir = request.launcher_dir or (
            Path.home() / ".cache" / "hermelin" / "runtime-launchers"
        )
        launcher_dir = Path(launcher_dir).expanduser()
        launcher_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = launcher_dir.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeBackendError("runtime launcher directory is not a directory")
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeBackendError("runtime launcher directory must be owner-only")

        safe_runtime_id = "".join(
            ch if ch.isalnum() or ch in "._-" else "-" for ch in request.runtime_id
        )
        launcher = launcher_dir / (
            f"{safe_runtime_id}-{os.getpid()}-{secrets.token_hex(6)}.sh"
        )
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        exports = [
            f"export {key}={shlex.quote(value)}"
            for key, value in env.items()
            if value
        ]
        command = " ".join(shlex.quote(part) for part in request.command)
        script = "\n".join(
            [
                "#!/bin/sh",
                "set -eu",
                *exports,
                'rm -f -- "$0"',
                f"exec {command}",
                "",
            ]
        )
        try:
            fd = os.open(launcher, flags, 0o600)
            try:
                os.write(fd, script.encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
        except Exception:
            try:
                launcher.unlink(missing_ok=True)
            except Exception:
                pass
            raise
        return launcher

    async def create(self, request: RuntimeCreateRequest) -> RuntimeRecord:
        if not self.available():
            raise RuntimeBackendError("tmux is not installed")

        name = request.tmux_name or self.tmux_name_for(request.runtime_id)
        if self.has_session(name):
            pid = self.pane_pid(name)
            return RuntimeRecord(
                runtime_id=request.runtime_id,
                title=request.title,
                profile=request.profile,
                cwd=str(request.cwd),
                state="idle",
                source=request.source,
                backend=self.name,
                tmux_name=name,
                hermes_pid=pid,
                last_seen_at=utc_ts(),
                metadata={"attached": False},
            )

        request.cwd.mkdir(parents=True, exist_ok=True)
        env = dict(request.env)
        env.update(
            {
                "HERMES_MANAGED_BY": "hermelinchat",
                "HERMES_MANAGED_RUNTIME_ID": request.runtime_id,
                "HERMES_MANAGED_SOURCE": request.source,
                "HERMELIN_RUNTIME_ID": request.runtime_id,
                "TERM": env.get("TERM") or "xterm-256color",
                "COLORTERM": env.get("COLORTERM") or "truecolor",
            }
        )
        env.pop("COLUMNS", None)
        env.pop("LINES", None)
        launch_env_keys = [
            "PATH",
            "HERMES_HOME",
            "HERMES_MANAGED_BY",
            "HERMES_MANAGED_RUNTIME_ID",
            "HERMES_MANAGED_SOURCE",
            "HERMELIN_RUNTIME_ID",
            "HERMES_MANAGED_DIR",
            "HERMES_TUI_SIDECAR_URL",
            "HERMELIN_PET_EVENT_CHANNEL",
            "SSL_CERT_FILE",
            "PYTHONUNBUFFERED",
            "COLORTERM",
        ]
        launch_env = {key: env[key] for key in launch_env_keys if env.get(key)}
        launcher = self._write_private_launcher(request, launch_env)
        command = " ".join((shlex.quote("/bin/sh"), shlex.quote(str(launcher))))

        args = [
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            str(max(20, int(request.cols or 120))),
            "-y",
            str(max(5, int(request.rows or 30))),
            "-c",
            str(request.cwd),
            command,
        ]
        tmux_env_keys = (
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
            "TERM",
            "TMPDIR",
        )
        tmux_env = {key: env[key] for key in tmux_env_keys if env.get(key)}
        result = await asyncio.to_thread(self._run, args, env=tmux_env, timeout=10.0)
        if result.returncode != 0:
            launcher.unlink(missing_ok=True)
            detail = (result.stderr or result.stdout or "tmux new-session failed").strip()
            raise RuntimeBackendError(detail)

        pid = self.pane_pid(name)
        return RuntimeRecord(
            runtime_id=request.runtime_id,
            title=request.title,
            profile=request.profile,
            cwd=str(request.cwd),
            state="idle",
            source=request.source,
            backend=self.name,
            tmux_name=name,
            hermes_pid=pid,
            last_seen_at=utc_ts(),
            metadata={"attached": False},
        )

    async def stop(self, runtime: RuntimeRecord) -> None:
        name = runtime.tmux_name or self.tmux_name_for(runtime.runtime_id)
        await asyncio.to_thread(self._run, ["kill-session", "-t", name], timeout=5.0)

    async def status(self, runtime: RuntimeRecord) -> RuntimeStatus:
        name = runtime.tmux_name or self.tmux_name_for(runtime.runtime_id)
        exists = await asyncio.to_thread(self.has_session, name)
        if not exists:
            return RuntimeStatus(exists=False, state="stopped", hermes_pid=None)
        pid = await asyncio.to_thread(self.pane_pid, name)
        session_id = await asyncio.to_thread(_session_id_for_process_tree, pid)
        return RuntimeStatus(
            exists=True,
            state="idle",
            hermes_pid=pid,
            active_hermes_session_id=session_id,
        )

    def attach_process(self, runtime: RuntimeRecord, *, cols: int = 120, rows: int = 30) -> PtyProcess:
        name = runtime.tmux_name or self.tmux_name_for(runtime.runtime_id)
        if not self.has_session(name):
            raise RuntimeBackendError(f"tmux session not found: {name}")
        # attach-session runs as a short-lived browser attachment. Killing this
        # PTY wrapper detaches the browser only; the tmux session and Hermes stay alive.
        return PtyProcess.spawn(
            [self.tmux_bin, "attach-session", "-t", name],
            env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
            cols=cols,
            rows=rows,
        )


def select_runtime_backend(mode: str, *, tmux_prefix: str = "hermelin", which=shutil.which) -> RuntimeBackend:
    normalized = str(mode or "auto").strip().lower()
    if normalized not in {"auto", "legacy", "tmux", "off"}:
        normalized = "auto"
    if normalized == "off":
        raise RuntimeBackendError("runtime backend is disabled")
    if normalized == "legacy":
        return LegacyRuntimeBackend()
    if normalized == "tmux":
        backend = TmuxRuntimeBackend(prefix=tmux_prefix)
        if which("tmux") is None:
            raise RuntimeBackendError("tmux is not installed")
        return backend
    if which("tmux") is not None:
        return TmuxRuntimeBackend(prefix=tmux_prefix)
    return LegacyRuntimeBackend()
