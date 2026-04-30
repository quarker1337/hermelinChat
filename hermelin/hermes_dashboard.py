from __future__ import annotations

import asyncio
import os
import re
import shlex
import socket
import subprocess
import time
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx


DASHBOARD_RUNNER_ID = "hermes-dashboard"
DEFAULT_DASHBOARD_BASE_PATH = f"/api/runners/{DASHBOARD_RUNNER_ID}"
LOCALHOST_HOSTS = {"127.0.0.1", "localhost", "0.0.0.0", "::1"}


def normalize_base_path(value: str | None) -> str:
    raw = str(value or DEFAULT_DASHBOARD_BASE_PATH).strip()
    if not raw:
        raw = DEFAULT_DASHBOARD_BASE_PATH
    if not raw.startswith("/"):
        raw = f"/{raw}"
    return raw.rstrip("/") or DEFAULT_DASHBOARD_BASE_PATH


def rewrite_prefixed_location(value: str, *, base_path: str, upstream_port: int) -> str:
    """Rewrite upstream redirects so they stay inside the dashboard proxy prefix."""

    loc = (value or "").strip()
    if not loc:
        return value

    prefix = normalize_base_path(base_path)
    if loc == prefix or loc.startswith(f"{prefix}/"):
        return loc

    if loc.startswith("/"):
        return f"{prefix}{loc}"

    try:
        parsed = urlparse(loc)
    except Exception:
        return loc

    host = (parsed.hostname or "").strip().lower()
    if host in LOCALHOST_HOSTS and parsed.port == int(upstream_port):
        path = parsed.path or "/"
        out = f"{prefix}{path}"
        if parsed.query:
            out += f"?{parsed.query}"
        if parsed.fragment:
            out += f"#{parsed.fragment}"
        return out

    return loc


_JS_MIME_MARKERS = (
    "javascript",
    "ecmascript",
    "text/js",
)


def should_rewrite_dashboard_body(path: str, content_type: str) -> bool:
    """Return true for dashboard SPA payloads that contain root-relative URLs."""

    path_l = str(path or "").lower().split("?", 1)[0]
    ctype = str(content_type or "").lower()
    if "text/html" in ctype:
        return True
    if path_l.endswith(".js") or any(marker in ctype for marker in _JS_MIME_MARKERS):
        return True
    return False


def _rewrite_dashboard_html(text: str, base_path: str) -> str:
    prefix = normalize_base_path(base_path)
    script = f'<script>window.__HERMES_BASE_PATH__={json.dumps(prefix)};</script>'
    if "window.__HERMES_BASE_PATH__" not in text:
        if "</head>" in text:
            text = text.replace("</head>", f"{script}</head>", 1)
        else:
            text = f"{script}{text}"

    # Vite emits root-relative assets because the upstream dashboard normally
    # runs at /. When proxied below /api/runners/hermes-dashboard, scope those
    # references so the browser returns to this proxy instead of hermelinChat's
    # own root/assets/API namespace.
    text = re.sub(
        r'(?P<prefix>\b(?:src|href)=(["\']))/(?P<target>(?:assets/|favicon\.ico)[^"\']*)',
        lambda m: f"{m.group('prefix')}{prefix}/{m.group('target')}",
        text,
    )
    return text


def _rewrite_dashboard_js(text: str, base_path: str) -> str:
    # Current dashboard bundles compile api.ts's `const BASE = ""` into a tiny
    # minified const (for example `const bk=""`). Restrict the regex to the
    # nearby session-token/header symbols so we do not rewrite unrelated empty
    # constants in vendor code.
    rewritten = re.sub(
        r'const ([A-Za-z_$][\w$]*)="";(let [A-Za-z_$][\w$]*=null;const [A-Za-z_$][\w$]*="X-Hermes-Session-Token")',
        r'const \1=window.__HERMES_BASE_PATH__||"";\2',
        text,
        count=1,
    )
    if rewritten == text:
        rewritten = re.sub(
            r'const ([A-Za-z_$][\w$]*)="";',
            r'const \1=window.__HERMES_BASE_PATH__||"";',
            text,
            count=1,
        )
    text = rewritten

    # BrowserRouter needs a basename or it will see the proxied URL as an
    # unknown route and redirect the iframe to hermelinChat's own root page.
    text = re.sub(
        r'(\.createRoot\(document\.getElementById\((["\'])root\2\)\)\.render\((?:[A-Za-z_$][\w$]*\.)?jsx\([A-Za-z_$][\w$]*,\{)children:',
        r'\1basename:window.__HERMES_BASE_PATH__||"",children:',
        text,
        count=1,
    )

    ws_prefix = '${window.__HERMES_BASE_PATH__||""}'
    for host_expr in ("${window.location.host}", "${location.host}"):
        text = text.replace(f"{host_expr}/api/ws?", f"{host_expr}{ws_prefix}/api/ws?")
        text = text.replace(f"{host_expr}/api/events?", f"{host_expr}{ws_prefix}/api/events?")
        text = text.replace(f"{host_expr}/api/pty?", f"{host_expr}{ws_prefix}/api/pty?")
    return text


def rewrite_dashboard_body(body: bytes, *, content_type: str, base_path: str) -> bytes:
    """Patch dashboard HTML/JS so an older root-mounted Hermes dashboard can
    run safely below hermelinChat's authenticated proxy prefix.
    """

    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return body

    ctype = str(content_type or "").lower()
    if "text/html" in ctype:
        return _rewrite_dashboard_html(text, base_path).encode("utf-8")
    if any(marker in ctype for marker in _JS_MIME_MARKERS) or text.lstrip().startswith(("import", "const", "var", "let", "function", "(")):
        return _rewrite_dashboard_js(text, base_path).encode("utf-8")
    return body


def _find_free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class HermesDashboardManager:
    """Owns a localhost-only `hermes dashboard` process for hermelinChat.

    The dashboard itself exposes config, credentials, logs, cron jobs, and
    optional PTY/WebSocket chat.  This manager deliberately binds it to
    127.0.0.1 and expects hermelinChat to provide the external auth boundary.
    """

    def __init__(
        self,
        *,
        hermes_command: str = "hermes",
        hermes_home: Path,
        cwd: Path,
        enabled: bool = True,
        host: str = "127.0.0.1",
        port: int = 0,
        base_path: str = DEFAULT_DASHBOARD_BASE_PATH,
        tui: bool = False,
        startup_timeout_seconds: float = 20.0,
        require_base_path: bool = False,
    ) -> None:
        self.hermes_command = str(hermes_command or "hermes").strip() or "hermes"
        self.hermes_home = Path(hermes_home).expanduser()
        self.cwd = Path(cwd).expanduser()
        self.enabled = bool(enabled)
        self.host = "127.0.0.1" if str(host or "").strip() not in {"127.0.0.1", "localhost"} else str(host).strip()
        self.configured_port = int(port or 0)
        self.base_path = normalize_base_path(base_path)
        self.tui = bool(tui)
        self.startup_timeout_seconds = float(startup_timeout_seconds or 20.0)
        self.require_base_path = bool(require_base_path)

        self._proc: subprocess.Popen | None = None
        self._port: int | None = None
        self._last_error = ""
        self._started_at: float | None = None
        self._lock = asyncio.Lock()
        self._log_handle: Any = None
        self._base_path_supported: bool | None = None

    def _base_argv(self) -> list[str]:
        try:
            argv = shlex.split(self.hermes_command)
        except Exception:
            argv = [self.hermes_command]
        argv = [part for part in argv if part]
        if not argv:
            argv = ["hermes"]
        if len(argv) < 2 or argv[-1] != "dashboard":
            argv = [*argv, "dashboard"]
        return argv

    def build_command(self, port: int | None = None) -> list[str]:
        actual_port = int(port or self.configured_port or self._port or 0)
        if actual_port < 1 or actual_port > 65535:
            actual_port = _find_free_loopback_port()

        cmd = [
            *self._base_argv(),
            "--host",
            "127.0.0.1",
            "--port",
            str(actual_port),
            "--no-open",
        ]
        if self._base_path_supported is True:
            cmd.extend(["--base-path", self.base_path])
        if self.tui:
            cmd.append("--tui")
        return cmd

    def _base_path_support_sync(self) -> bool:
        if self._base_path_supported is not None:
            return self._base_path_supported
        try:
            self.cwd.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(
                [*self._base_argv(), "--help"],
                cwd=str(self.cwd),
                env=self._build_env(),
                capture_output=True,
                text=True,
                timeout=10,
            )
            text = f"{result.stdout or ''}\n{result.stderr or ''}"
            self._base_path_supported = "--base-path" in text
        except Exception as exc:
            self._last_error = f"could not inspect hermes dashboard help: {exc}"
            self._base_path_supported = False
        return bool(self._base_path_supported)

    async def base_path_supported(self) -> bool:
        return await asyncio.to_thread(self._base_path_support_sync)

    def _build_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(self.hermes_home)
        env["HERMES_DASHBOARD_BASE_PATH"] = self.base_path
        return env

    def _running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def upstream(self) -> tuple[str, str, int] | None:
        if not self._running() or not self._port:
            return None
        return "http", "127.0.0.1", int(self._port)

    def status(self) -> dict[str, Any]:
        if self._proc is not None and self._proc.poll() is not None:
            code = self._proc.returncode
            if not self._last_error:
                self._last_error = f"dashboard exited with code {code}"
            self._proc = None
            self._close_log_handle()

        return {
            "ok": True,
            "enabled": self.enabled,
            "running": self._running(),
            "host": "127.0.0.1",
            "port": self._port,
            "pid": self._proc.pid if self._running() and self._proc is not None else None,
            "base_path": self.base_path,
            "proxy_path": f"{self.base_path}/",
            "tui": self.tui,
            "base_path_supported": self._base_path_supported,
            "last_error": self._last_error,
            "started_at": self._started_at,
        }

    async def ensure_started(self) -> dict[str, Any]:
        if self._running():
            return self.status()
        return await self.start()

    async def start(self) -> dict[str, Any]:
        async with self._lock:
            if self._running():
                return self.status()
            self._last_error = ""

            if not self.enabled:
                self._last_error = "Hermes dashboard integration is disabled"
                return self.status()

            base_path_supported = await self.base_path_supported()
            if self.require_base_path and not base_path_supported:
                if not self._last_error:
                    self._last_error = (
                        "installed Hermes dashboard does not support --base-path; "
                        "update Hermes Agent or disable the strict base-path requirement"
                    )
                return self.status()

            port = self.configured_port or _find_free_loopback_port()
            self._port = port
            cmd = self.build_command(port)

            try:
                self.cwd.mkdir(parents=True, exist_ok=True)
                logs_dir = self.hermes_home / "logs"
                logs_dir.mkdir(parents=True, exist_ok=True)
                self._close_log_handle()
                self._log_handle = (logs_dir / "hermelin-dashboard.log").open("ab")
                self._proc = subprocess.Popen(
                    cmd,
                    cwd=str(self.cwd),
                    env=self._build_env(),
                    stdin=subprocess.DEVNULL,
                    stdout=self._log_handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                self._started_at = time.time()
            except FileNotFoundError:
                self._last_error = f"executable not found: {cmd[0]}"
                self._proc = None
                self._close_log_handle()
                return self.status()
            except Exception as exc:
                self._last_error = str(exc)
                self._proc = None
                self._close_log_handle()
                return self.status()

            await self._wait_until_ready()
            return self.status()

    async def restart(self) -> dict[str, Any]:
        await self.stop()
        return await self.start()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            proc = self._proc
            self._proc = None
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    await asyncio.to_thread(proc.wait, 5)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                        await asyncio.to_thread(proc.wait, 5)
                    except Exception:
                        pass
                except Exception:
                    pass
            self._close_log_handle()
            self._started_at = None
            return self.status()

    async def aclose(self) -> None:
        await self.stop()

    def _close_log_handle(self) -> None:
        handle = self._log_handle
        self._log_handle = None
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass

    async def _wait_until_ready(self) -> None:
        if not self._proc or not self._port:
            return
        deadline = time.monotonic() + max(1.0, self.startup_timeout_seconds)
        url = f"http://127.0.0.1:{self._port}/api/status"
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=1.0, read=1.0, write=1.0, pool=1.0)) as client:
            while time.monotonic() < deadline:
                if self._proc.poll() is not None:
                    self._last_error = f"dashboard exited with code {self._proc.returncode}"
                    return
                try:
                    response = await client.get(url)
                    if response.status_code < 500:
                        return
                except Exception:
                    pass
                await asyncio.sleep(0.2)
        self._last_error = "dashboard did not become ready before timeout"
