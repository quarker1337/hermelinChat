#!/usr/bin/env python3
"""Example iframe runner (stdlib-only) for hermilinChat Runner Gateway.

Why this exists
- Hermes often starts iframe runners bound to 127.0.0.1.
- If the operator browser is remote, direct iframe src=http://127.0.0.1:PORT
  will not work.
- hermilinChat fixes this by proxying runners under:
    /r/{tab_id}/_t/{token}/...
  where token is minted by the authenticated UI.

This runner demonstrates:
- Binding to 127.0.0.1 on a random free port
- Writing a runner manifest so hermilinChat can discover the port:
    $HERMES_ARTIFACT_PROJECT_DIR/runner.json
- Serving:
  - GET /        : minimal HTML UI (uses ONLY relative URLs)
  - GET /events  : Server-Sent Events (SSE) stream
  - WS  /ws      : Minimal WebSocket echo + broadcast (implemented in stdlib)

Notes for runner authors (and for the model generating runners)
- Avoid absolute URLs like src="/assets/app.js". Use relative URLs so the app
  continues working behind /r/.../_t/... path prefixes.
- For WebSockets, construct URLs from location:
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProto}//${location.host}${location.pathname.replace(/\/$/, '')}/ws`

Runner manifest vs artifact JSON (common source of model mistakes)
- runner.json is ONLY for runner discovery (gateway needs the port):
    $HERMES_ARTIFACT_PROJECT_DIR/runner.json
  Minimal shape:
    {"scheme":"http","host":"127.0.0.1","port":1234,"tab_id":"...","started_at":...}
- Live artifact updates are DIFFERENT: if a runner writes artifacts directly, it must write the FULL
  artifact envelope to:
    $HERMES_ARTIFACTS_HOME/session/{tab_id}.json
  (payload goes under top-level "data"; do NOT write only the payload object).
  See: examples/artifacts/live_logs_runner_template.py

Environment variables (set by Hermes artifact_tool.start_runner)
- HERMES_ARTIFACT_TAB_ID
- HERMES_ARTIFACT_PROJECT_DIR
- HERMES_ARTIFACTS_HOME

This file is an example; Hermes can inline it into start_runner(runner_code=...).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import socket
import time
from pathlib import Path
from typing import Any


TAB_ID = (os.getenv("HERMES_ARTIFACT_TAB_ID") or "runner").strip() or "runner"
PROJECT_DIR = Path(os.getenv("HERMES_ARTIFACT_PROJECT_DIR") or ".").expanduser().resolve()
MANIFEST_PATH = PROJECT_DIR / "runner.json"


def _write_manifest(host: str, port: int) -> None:
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "scheme": "http",
        "host": host,
        "port": int(port),
        "tab_id": TAB_ID,
        "started_at": time.time(),
    }
    MANIFEST_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _http_response(status: str, headers: list[tuple[str, str]], body: bytes) -> bytes:
    lines = [f"HTTP/1.1 {status}"]
    for k, v in headers:
        lines.append(f"{k}: {v}")
    lines.append("")
    head = "\r\n".join(lines).encode("utf-8") + b"\r\n"
    return head + body


async def _read_http_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str], bytes]:
    # Very small / naive HTTP parser (good enough for demo runner).
    line = await reader.readline()
    if not line:
        raise EOFError

    try:
        request_line = line.decode("utf-8", "replace").strip()
        method, path, _proto = request_line.split(" ", 2)
    except Exception:
        raise ValueError("bad request line")

    headers: dict[str, str] = {}
    while True:
        h = await reader.readline()
        if not h:
            raise EOFError
        if h in {b"\r\n", b"\n"}:
            break
        s = h.decode("utf-8", "replace")
        if ":" not in s:
            continue
        k, v = s.split(":", 1)
        headers[k.strip().lower()] = v.strip()

    # Body (only if Content-Length; demo runner does not support chunked uploads)
    body = b""
    try:
        clen = int(headers.get("content-length") or "0")
    except ValueError:
        clen = 0
    if clen > 0:
        body = await reader.readexactly(clen)

    return method.upper(), path, headers, body


def _ws_accept_key(sec_websocket_key: str) -> str:
    magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    sha1 = hashlib.sha1((sec_websocket_key + magic).encode("utf-8")).digest()
    return base64.b64encode(sha1).decode("ascii")


async def _ws_recv_frame(reader: asyncio.StreamReader) -> bytes | None:
    # Minimal frame reader: supports single-frame text/binary from client.
    hdr = await reader.readexactly(2)
    b1, b2 = hdr[0], hdr[1]
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F

    if opcode == 0x8:  # close
        return None

    if not fin:
        # Ignore fragmentation in this demo.
        return None

    if length == 126:
        length = int.from_bytes(await reader.readexactly(2), "big")
    elif length == 127:
        length = int.from_bytes(await reader.readexactly(8), "big")

    mask_key = b""
    if masked:
        mask_key = await reader.readexactly(4)

    payload = await reader.readexactly(length) if length else b""
    if masked and payload:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

    return payload


def _ws_send_frame(payload: bytes, *, opcode: int = 0x1) -> bytes:
    # Server frames are NOT masked.
    fin_opcode = 0x80 | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        head = bytes([fin_opcode, n])
    elif n <= 0xFFFF:
        head = bytes([fin_opcode, 126]) + n.to_bytes(2, "big")
    else:
        head = bytes([fin_opcode, 127]) + n.to_bytes(8, "big")
    return head + payload


HTML = """<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />
  <title>hermilinChat runner demo</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 18px; }
    code { background: #f3f3f6; padding: 2px 6px; border-radius: 6px; }
    .box { border: 1px solid #ddd; border-radius: 10px; padding: 12px; margin: 12px 0; }
    .row { display: flex; gap: 10px; align-items: center; }
    button { padding: 6px 10px; }
    pre { background: #0f1222; color: #eaeaf3; padding: 10px; border-radius: 10px; overflow: auto; }
  </style>
</head>
<body>
  <h3>Runner demo (tab_id: <code id=\"tab\"></code>)</h3>
  <div class=\"box\">
    <div class=\"row\">
      <button id=\"send\">Send WS ping</button>
      <span id=\"ws\">WS: connecting...</span>
    </div>
    <div style=\"margin-top:10px\">SSE events:</div>
    <pre id=\"log\"></pre>
  </div>

<script>
  const tabId = (window.location.pathname.split('/').filter(Boolean)[0] || 'runner')
  document.getElementById('tab').textContent = tabId

  const logEl = document.getElementById('log')
  const addLine = (s) => {
    logEl.textContent += s + "\n"
    logEl.scrollTop = logEl.scrollHeight
  }

  // SSE (relative URL keeps working behind /r/.../_t/... prefixes)
  try {
    const es = new EventSource('events')
    es.onmessage = (ev) => addLine(`[sse] ${ev.data}`)
    es.onerror = () => addLine('[sse] error (stream interrupted)')
  } catch (e) {
    addLine('[sse] EventSource not available')
  }

  // WebSocket (build URL from location so it keeps working behind proxy prefixes)
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${wsProto}//${location.host}${location.pathname.replace(/\/$/, '')}/ws`
  const wsStatus = document.getElementById('ws')

  let ws
  const connect = () => {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => { wsStatus.textContent = 'WS: open'; addLine('[ws] open') }
    ws.onclose = () => { wsStatus.textContent = 'WS: closed'; addLine('[ws] closed'); setTimeout(connect, 1000) }
    ws.onerror = () => addLine('[ws] error')
    ws.onmessage = (ev) => addLine(`[ws] ${ev.data}`)
  }
  connect()

  document.getElementById('send').addEventListener('click', () => {
    try { ws.send('ping ' + new Date().toISOString()) } catch {}
  })
</script>
</body>
</html>
""".encode("utf-8")


class Broadcast:
    def __init__(self) -> None:
        self._sse_writers: set[asyncio.StreamWriter] = set()
        self._ws_writers: set[asyncio.StreamWriter] = set()
        self._lock = asyncio.Lock()

    async def add_sse(self, writer: asyncio.StreamWriter) -> None:
        async with self._lock:
            self._sse_writers.add(writer)

    async def add_ws(self, writer: asyncio.StreamWriter) -> None:
        async with self._lock:
            self._ws_writers.add(writer)

    async def remove(self, writer: asyncio.StreamWriter) -> None:
        async with self._lock:
            self._sse_writers.discard(writer)
            self._ws_writers.discard(writer)

    async def publish(self, msg: str) -> None:
        data = msg.encode("utf-8")

        # SSE format
        sse = b"data: " + data + b"\n\n"

        # WS text frame
        ws = _ws_send_frame(data, opcode=0x1)

        async with self._lock:
            sse_targets = list(self._sse_writers)
            ws_targets = list(self._ws_writers)

        for w in sse_targets:
            try:
                w.write(sse)
                await w.drain()
            except Exception:
                await self.remove(w)

        for w in ws_targets:
            try:
                w.write(ws)
                await w.drain()
            except Exception:
                await self.remove(w)


broadcast = Broadcast()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        method, path, headers, _body = await _read_http_request(reader)
    except Exception:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        return

    # Strip query for routing
    raw_path = path.split("?", 1)[0]

    # WebSocket upgrade
    if headers.get("upgrade", "").lower() == "websocket" and raw_path.rstrip("/") == "/ws":
        key = headers.get("sec-websocket-key")
        if not key:
            writer.write(_http_response("400 Bad Request", [("Content-Type", "text/plain")], b"missing key"))
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            return

        accept = _ws_accept_key(key)
        resp = _http_response(
            "101 Switching Protocols",
            [
                ("Upgrade", "websocket"),
                ("Connection", "Upgrade"),
                ("Sec-WebSocket-Accept", accept),
            ],
            b"",
        )
        writer.write(resp)
        await writer.drain()

        await broadcast.add_ws(writer)
        try:
            while True:
                payload = await _ws_recv_frame(reader)
                if payload is None:
                    break
                # Echo received message to everyone.
                await broadcast.publish(payload.decode("utf-8", "replace"))
        except Exception:
            pass
        finally:
            await broadcast.remove(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
        return

    # SSE stream
    if method == "GET" and raw_path.rstrip("/") == "/events":
        headers_out = [
            ("Content-Type", "text/event-stream"),
            ("Cache-Control", "no-cache"),
            ("Connection", "keep-alive"),
            ("X-Accel-Buffering", "no"),
        ]
        writer.write(_http_response("200 OK", headers_out, b""))
        await writer.drain()

        await broadcast.add_sse(writer)
        try:
            # Keep alive until client disconnects.
            while not reader.at_eof():
                await asyncio.sleep(10)
                # Comment line as heartbeat.
                writer.write(b": ping\n\n")
                await writer.drain()
        except Exception:
            pass
        finally:
            await broadcast.remove(writer)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
        return

    # HTML root
    if method == "GET" and raw_path.rstrip("/") in {"", "/"}:
        body = HTML
        headers_out = [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Cache-Control", "no-store"),
        ]
        writer.write(_http_response("200 OK", headers_out, body))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    # 404
    writer.write(_http_response("404 Not Found", [("Content-Type", "text/plain")], b"not found"))
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def main() -> None:
    host = "127.0.0.1"

    # Bind an ephemeral port.
    srv = await asyncio.start_server(handle_client, host=host, port=0)
    sock = srv.sockets[0]
    port = int(sock.getsockname()[1])

    _write_manifest(host, port)
    print(f"[runner] started tab_id={TAB_ID} on http://{host}:{port} (manifest: {MANIFEST_PATH})", flush=True)

    async def ticker() -> None:
        i = 0
        while True:
            i += 1
            await broadcast.publish(f"tick {i} @ {time.strftime('%H:%M:%S')}")
            await asyncio.sleep(2)

    async with srv:
        await asyncio.gather(srv.serve_forever(), ticker())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
