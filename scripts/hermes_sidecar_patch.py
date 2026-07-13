from __future__ import annotations

import re
from pathlib import Path


SIDECAR_RECONNECT_PATCH_MARKER = (
    "    # hermelinChat restart-safe sidecar reconnect patch"
)


def _replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f"could not find unique Hermes sidecar patch anchor: {label}")
    return text.replace(old, new, 1)


def _line_suffix(text: str, expression: str, label: str) -> str:
    match = re.search(
        rf"(?m)^\s*{re.escape(expression)}(?P<suffix>[^\r\n]*)$",
        text,
    )
    if match is None:
        raise RuntimeError(f"could not find Hermes sidecar patch line: {label}")
    return match.group("suffix")


def _with_original_newlines(original: str, normalized: str) -> str:
    return normalized.replace("\n", "\r\n") if "\r\n" in original else normalized


def patch_event_publisher_text(source: str) -> tuple[bool, str]:
    if SIDECAR_RECONNECT_PATCH_MARKER.strip() in source:
        return False, source
    if (
        "def _connect(self) -> bool:" in source
        and "self._disconnect(ws)" in source
        and "if self._dead or self._worker is None:" in source
    ):
        return False, source

    original = source
    text = source.replace("\r\n", "\n")
    send_suffix = _line_suffix(text, "self._ws.send(item)", "publisher send")
    close_suffix = _line_suffix(text, "self._ws.close()", "publisher close")

    text = _replace_once(
        text,
        '''class WsPublisherTransport:
    __slots__ = ("_url", "_lock", "_ws", "_dead", "_q", "_worker")
''',
        f'''class WsPublisherTransport:
{SIDECAR_RECONNECT_PATCH_MARKER}
    __slots__ = (
        "_url",
        "_connect_timeout",
        "_lock",
        "_ws",
        "_dead",
        "_q",
        "_worker",
    )
''',
        "publisher class slots",
    )
    text = _replace_once(
        text,
        '''        self._url = url
        self._lock = threading.Lock()
''',
        '''        self._url = url
        self._connect_timeout = connect_timeout
        self._lock = threading.Lock()
''',
        "publisher connect timeout",
    )
    text = _replace_once(
        text,
        '''        try:
            self._ws = ws_connect(url, open_timeout=connect_timeout, max_size=None)
        except Exception as exc:
            _log.debug("event publisher connect failed: %s", exc)
            self._dead = True
            self._ws = None

            return
''',
        '''        self._connect()
''',
        "publisher initial connect",
    )

    old_drain = f'''            if self._ws is None:
                continue
            try:
                with self._lock:
                    if self._ws is not None:
                        self._ws.send(item){send_suffix}
            except Exception as exc:
                _log.debug("event publisher write failed: %s", exc)
                self._dead = True
                self._ws = None
'''
    new_drain = f'''            # hermelinChat: reconnect after dashboard/service restarts.
            for _attempt in range(2):
                if self._ws is None and not self._connect():
                    break
                ws = self._ws
                if ws is None:
                    break
                try:
                    with self._lock:
                        if self._ws is not ws:
                            continue
                        ws.send(item){send_suffix}
                    break
                except Exception as exc:
                    _log.debug("event publisher write failed: %s", exc)
                    self._disconnect(ws)

    def _connect(self) -> bool:
        if self._dead or ws_connect is None:
            return False
        try:
            ws = ws_connect(
                self._url,
                open_timeout=self._connect_timeout,
                max_size=None,
            )
        except Exception as exc:
            _log.debug("event publisher connect failed: %s", exc)
            return False
        with self._lock:
            if self._dead:
                try:
                    ws.close()
                except Exception:
                    pass
                return False
            self._ws = ws
        return True

    def _disconnect(self, ws: object) -> None:
        with self._lock:
            if self._ws is ws:
                self._ws = None
        try:
            ws.close(){close_suffix}
        except Exception:
            pass
'''
    text = _replace_once(text, old_drain, new_drain, "publisher drain loop")
    text = _replace_once(
        text,
        "        if self._dead or self._ws is None or self._worker is None:\n",
        "        if self._dead or self._worker is None:\n",
        "publisher write availability",
    )

    old_close = f'''        if self._ws is None:
            return

        try:
            with self._lock:
                if self._ws is not None:
                    self._ws.close(){close_suffix}
        except Exception:
            pass

        self._ws = None
'''
    new_close = '''        ws = self._ws
        if ws is None:
            return
        self._disconnect(ws)
'''
    text = _replace_once(text, old_close, new_close, "publisher close")
    return True, _with_original_newlines(original, text)


def unpatch_event_publisher_text(source: str) -> tuple[bool, str]:
    if SIDECAR_RECONNECT_PATCH_MARKER.strip() not in source:
        return False, source

    original = source
    text = source.replace("\r\n", "\n")
    send_suffix = _line_suffix(text, "ws.send(item)", "patched publisher send")
    disconnect_start = text.index("    def _disconnect(self, ws: object) -> None:")
    close_suffix = _line_suffix(
        text[disconnect_start:],
        "ws.close()",
        "patched publisher disconnect close",
    )

    text = _replace_once(
        text,
        f'''class WsPublisherTransport:
{SIDECAR_RECONNECT_PATCH_MARKER}
    __slots__ = (
        "_url",
        "_connect_timeout",
        "_lock",
        "_ws",
        "_dead",
        "_q",
        "_worker",
    )
''',
        '''class WsPublisherTransport:
    __slots__ = ("_url", "_lock", "_ws", "_dead", "_q", "_worker")
''',
        "patched publisher class slots",
    )
    text = _replace_once(
        text,
        '''        self._url = url
        self._connect_timeout = connect_timeout
        self._lock = threading.Lock()
''',
        '''        self._url = url
        self._lock = threading.Lock()
''',
        "patched publisher connect timeout",
    )
    text = _replace_once(
        text,
        '''        self._connect()
''',
        '''        try:
            self._ws = ws_connect(url, open_timeout=connect_timeout, max_size=None)
        except Exception as exc:
            _log.debug("event publisher connect failed: %s", exc)
            self._dead = True
            self._ws = None

            return
''',
        "patched publisher initial connect",
    )

    patched_drain = f'''            # hermelinChat: reconnect after dashboard/service restarts.
            for _attempt in range(2):
                if self._ws is None and not self._connect():
                    break
                ws = self._ws
                if ws is None:
                    break
                try:
                    with self._lock:
                        if self._ws is not ws:
                            continue
                        ws.send(item){send_suffix}
                    break
                except Exception as exc:
                    _log.debug("event publisher write failed: %s", exc)
                    self._disconnect(ws)

    def _connect(self) -> bool:
        if self._dead or ws_connect is None:
            return False
        try:
            ws = ws_connect(
                self._url,
                open_timeout=self._connect_timeout,
                max_size=None,
            )
        except Exception as exc:
            _log.debug("event publisher connect failed: %s", exc)
            return False
        with self._lock:
            if self._dead:
                try:
                    ws.close()
                except Exception:
                    pass
                return False
            self._ws = ws
        return True

    def _disconnect(self, ws: object) -> None:
        with self._lock:
            if self._ws is ws:
                self._ws = None
        try:
            ws.close(){close_suffix}
        except Exception:
            pass
'''
    original_drain = f'''            if self._ws is None:
                continue
            try:
                with self._lock:
                    if self._ws is not None:
                        self._ws.send(item){send_suffix}
            except Exception as exc:
                _log.debug("event publisher write failed: %s", exc)
                self._dead = True
                self._ws = None
'''
    text = _replace_once(
        text,
        patched_drain,
        original_drain,
        "patched publisher drain loop",
    )
    text = _replace_once(
        text,
        "        if self._dead or self._worker is None:\n",
        "        if self._dead or self._ws is None or self._worker is None:\n",
        "patched publisher write availability",
    )
    text = _replace_once(
        text,
        '''        ws = self._ws
        if ws is None:
            return
        self._disconnect(ws)
''',
        f'''        if self._ws is None:
            return

        try:
            with self._lock:
                if self._ws is not None:
                    self._ws.close(){close_suffix}
        except Exception:
            pass

        self._ws = None
''',
        "patched publisher close",
    )
    return True, _with_original_newlines(original, text)


def patch_event_publisher(path: Path) -> tuple[bool, str]:
    source = Path(path).read_text(encoding="utf-8")
    changed, patched = patch_event_publisher_text(source)
    if not changed:
        return False, "event_publisher.py already supports restart-safe sidecar reconnect"
    compile(patched, str(path), "exec")
    Path(path).write_text(patched, encoding="utf-8")
    return True, "Patched event_publisher.py: restart-safe HermelinChat activity events"


def unpatch_event_publisher(path: Path) -> tuple[bool, str]:
    source = Path(path).read_text(encoding="utf-8")
    changed, patched = unpatch_event_publisher_text(source)
    if not changed:
        return False, "event_publisher.py has no hermelinChat sidecar reconnect patch"
    compile(patched, str(path), "exec")
    Path(path).write_text(patched, encoding="utf-8")
    return True, "Removed hermelinChat sidecar reconnect patch"
