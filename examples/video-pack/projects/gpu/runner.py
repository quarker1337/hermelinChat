#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


DEFAULT_PORTS = {
    "gpu": 43111,
    "builder": 43112,
    "strudel": 43113,
    "money": 43114,
}


class _Server(ThreadingHTTPServer):
    allow_reuse_address = True


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        # Keep runner.log clean for video.
        return


def main() -> int:
    p = argparse.ArgumentParser(description="hermelinChat video-pack runner (static http server)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=0, help="Port to bind (0 = auto).")
    args = p.parse_args()

    tab_id = (os.getenv("HERMES_ARTIFACT_TAB_ID") or "").strip().lower()
    if not tab_id:
        tab_id = Path.cwd().name.strip().lower()

    preferred = DEFAULT_PORTS.get(tab_id, 0)

    project_dir = Path(os.getenv("HERMES_ARTIFACT_PROJECT_DIR") or Path.cwd()).expanduser().resolve()

    # Serve the project directory regardless of current working dir.
    def _handler(*h_args, **h_kwargs):
        return _QuietHandler(*h_args, directory=str(project_dir), **h_kwargs)

    host = str(args.host)
    port = int(args.port)

    # Prefer stable ports for nicer demo URLs, but fall back if busy.
    bind_ports = []
    if port:
        bind_ports.append(port)
    elif preferred:
        bind_ports.append(preferred)
    bind_ports.append(0)

    last_err: Exception | None = None
    httpd: _Server | None = None
    for cand in bind_ports:
        try:
            httpd = _Server((host, int(cand)), _handler)
            break
        except OSError as exc:
            last_err = exc
            httpd = None

    if httpd is None:
        print(f"[video-pack] ERROR: failed to bind {host} on any candidate port: {last_err}", file=sys.stderr)
        return 2

    actual_port = int(httpd.server_address[1])

    manifest = {
        "scheme": "http",
        "host": host,
        "port": actual_port,
    }

    try:
        (project_dir / "runner.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"[video-pack] WARNING: failed to write runner.json: {exc}", file=sys.stderr)

    print(f"[video-pack] {tab_id or 'runner'} listening on {host}:{actual_port} (dir={project_dir})")

    def _shutdown(*_a):
        try:
            threading.Thread(target=httpd.shutdown, daemon=True).start()
        except Exception:
            pass

    try:
        signal.signal(signal.SIGTERM, _shutdown)
        signal.signal(signal.SIGINT, _shutdown)
    except Exception:
        pass

    try:
        httpd.serve_forever(poll_interval=0.2)
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
