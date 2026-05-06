from __future__ import annotations

import asyncio
import inspect
import logging
import re
from collections.abc import Callable
from typing import Any

import httpx
import websockets
from fastapi import Body, FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .auth import extract_cookie_value
from .config import HermelinConfig
from .dashboard_themes import sync_dashboard_theme_for_ui_theme
from .hermes_dashboard import (
    DEFAULT_DASHBOARD_BASE_PATH,
    HermesDashboardManager,
    normalize_base_path,
    rewrite_dashboard_body,
    rewrite_prefixed_location,
    should_rewrite_dashboard_body,
)
from .security import extract_client_ip

logger = logging.getLogger("hermelin")

_DASHBOARD_BASE_PATH_RE = re.compile(r"^/[A-Za-z0-9._~/-]+$")
_DASHBOARD_PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

_DASHBOARD_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

_DASHBOARD_STRIP_REQUEST_HEADERS = {
    # Keep hermelinChat auth material scoped to hermelinChat.
    "cookie",
    "authorization",
    # Treat hermelinChat as the only CORS authority for the embedded dashboard.
    # The loopback dashboard's localhost CORS policy must not bleed through the
    # authenticated proxy boundary.
    "origin",
    # Do not let a browser/client spoof proxy context into the loopback
    # dashboard. hermelinChat sets canonical forwarded headers below.
    "forwarded",
    "x-real-ip",
}

_DASHBOARD_STRIP_RESPONSE_HEADERS = {
    # Dashboard must never be able to set cookies on hermelinChat origin.
    "set-cookie",
}

_DASHBOARD_PUBLIC_ERROR = "Hermes dashboard unavailable. Check hermelinChat server logs for details."
_DASHBOARD_PUBLIC_ERROR_MESSAGES = {
    "base_path_unsupported": "Installed Hermes dashboard does not support secure proxy base paths. Update Hermes Agent or disable strict dashboard base-path mode.",
    "disabled": "Hermes dashboard integration is disabled.",
    "executable_not_found": "Hermes dashboard executable was not found. Check HERMELIN_HERMES_DASHBOARD_CMD.",
    "frontend_not_built": "Native Hermes dashboard frontend is not built. Run `hermes update` or build the Hermes dashboard web UI with npm, then restart hermelinChat.",
    "port_in_use": "The configured Hermes dashboard port is already in use by another process. Stop the stale dashboard process or choose a different dashboard port.",
    "port_still_in_use": "Hermes dashboard is stopped, but the configured dashboard port is still in use by another process.",
    "process_exited": "Hermes dashboard exited during startup. Check hermelinChat server logs for details.",
    "startup_timeout": "Hermes dashboard did not become ready before timeout. Check hermelinChat server logs for details.",
}
_DASHBOARD_THEME_SYNC_ERROR = "failed to sync dashboard theme"


def _path_is_or_under(path: str, prefix: str) -> bool:
    normalized_path = str(path or "").rstrip("/") or "/"
    normalized_prefix = str(prefix or "").rstrip("/") or "/"
    return normalized_path == normalized_prefix or normalized_path.startswith(f"{normalized_prefix}/")


def dashboard_base_path_is_safe(path: str) -> bool:
    candidate = str(path or "")
    if not candidate.startswith("/api/"):
        return False

    # Keep custom dashboard mount points as plain, unambiguous URL paths.
    # Percent-encoded slashes/dots and literal dot-segments can be normalized
    # differently by proxies, ASGI routing, and browsers, so reject them rather
    # than trying to canonicalize a security boundary.
    if not _DASHBOARD_BASE_PATH_RE.fullmatch(candidate):
        return False
    segments = candidate.split("/")[1:]
    if any(segment in {"", ".", ".."} for segment in segments):
        return False

    public_or_reserved_prefixes = (
        "/api/auth",
        "/api/default-artifacts",
        "/api/hermes-dashboard",
    )
    return not any(_path_is_or_under(candidate, prefix) for prefix in public_or_reserved_prefixes)


def resolve_dashboard_base_path(config: HermelinConfig) -> str:
    base_path = normalize_base_path(getattr(config, "hermes_dashboard_base_path", DEFAULT_DASHBOARD_BASE_PATH))
    if dashboard_base_path_is_safe(base_path):
        return base_path

    logger.warning("ignoring unsafe Hermes dashboard base path: %s", base_path)
    return DEFAULT_DASHBOARD_BASE_PATH


def create_dashboard_manager(
    config: HermelinConfig,
    *,
    hermes_command: str,
    manager_cls: Callable[..., Any] = HermesDashboardManager,
) -> tuple[Any, str]:
    dashboard_base_path = resolve_dashboard_base_path(config)
    dashboard_command = str(getattr(config, "hermes_dashboard_cmd", "") or "").strip() or hermes_command
    manager = manager_cls(
        hermes_command=dashboard_command,
        hermes_home=config.hermes_home,
        cwd=config.spawn_cwd,
        enabled=bool(getattr(config, "hermes_dashboard_enabled", True)),
        port=int(getattr(config, "hermes_dashboard_port", 0) or 0),
        base_path=dashboard_base_path,
        tui=bool(getattr(config, "hermes_dashboard_tui", False)),
        startup_timeout_seconds=float(getattr(config, "hermes_dashboard_startup_timeout_seconds", 20.0) or 20.0),
    )
    return manager, dashboard_base_path


def websockets_connect_kwargs(
    *,
    subprotocols: list[str] | None,
    extra_headers: dict[str, str],
) -> dict[str, object]:
    """Build websockets.connect kwargs across websockets 12+ header API names."""

    kwargs: dict[str, object] = {"subprotocols": subprotocols}
    try:
        params = inspect.signature(websockets.connect).parameters
    except Exception:
        params = {}
    header_kw = "additional_headers" if "additional_headers" in params else "extra_headers"
    kwargs[header_kw] = extra_headers
    return kwargs


def _dashboard_filter_request_headers(
    request: Request,
    *,
    dashboard_base_path: str,
    request_external_scheme: Callable[[Request], str],
) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in request.headers.items():
        lk = k.lower()
        if lk in _DASHBOARD_HOP_BY_HOP_HEADERS:
            continue
        if lk in _DASHBOARD_STRIP_REQUEST_HEADERS or lk.startswith("x-forwarded-"):
            continue
        if lk.startswith("access-control-request-"):
            continue
        if lk == "host":
            continue
        out[k] = v
    out["X-Forwarded-Host"] = request.headers.get("host", "")
    out["X-Forwarded-Proto"] = request_external_scheme(request)
    out["X-Forwarded-Prefix"] = dashboard_base_path
    return out


def _dashboard_filter_response_headers(
    headers: httpx.Headers,
    *,
    dashboard_base_path: str,
    upstream_port: int,
) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in headers.items():
        lk = k.lower()
        if lk in _DASHBOARD_HOP_BY_HOP_HEADERS:
            continue
        if lk in _DASHBOARD_STRIP_RESPONSE_HEADERS:
            continue
        if lk.startswith("access-control-") or lk == "timing-allow-origin":
            continue
        if lk == "content-length":
            continue
        if lk == "location":
            v = rewrite_prefixed_location(v, base_path=dashboard_base_path, upstream_port=upstream_port)
        out[k] = v
    return out


def _dashboard_public_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    return None


def _dashboard_public_status(status: object, *, dashboard_base_path: str) -> dict[str, object]:
    """Return dashboard status without exposing internal exception text.

    The dashboard manager keeps detailed startup failures in `last_error` for
    server-side diagnosis. Those values can include exception messages or local
    paths, so public API responses only expose a generic error marker and
    otherwise rebuild the response from controlled fields.
    """

    raw = status if isinstance(status, dict) else {}
    raw_error_code = str(raw.get("last_error_code") or "").strip()
    public_error_code = raw_error_code if raw_error_code in _DASHBOARD_PUBLIC_ERROR_MESSAGES else ""
    public_error = ""
    if raw.get("last_error"):
        public_error = _DASHBOARD_PUBLIC_ERROR_MESSAGES.get(raw_error_code, _DASHBOARD_PUBLIC_ERROR)
        public_error_code = public_error_code or "unavailable"
    return {
        "ok": bool(raw.get("ok", True)),
        "enabled": bool(raw.get("enabled", False)),
        "running": bool(raw.get("running", False)),
        "base_path": dashboard_base_path,
        "proxy_path": f"{dashboard_base_path}/",
        "tui": bool(raw.get("tui", False)),
        "base_path_supported": raw.get("base_path_supported") if isinstance(raw.get("base_path_supported"), bool) else None,
        "stopped_by_user": bool(raw.get("stopped_by_user", False)),
        "last_error": public_error,
        "last_error_code": public_error_code,
        "started_at": _dashboard_public_float(raw.get("started_at")),
    }


def _dashboard_public_theme_sync(theme_sync: object) -> dict[str, object]:
    raw = theme_sync if isinstance(theme_sync, dict) else {}
    return {
        "ok": bool(raw.get("ok", False)),
        "ui_theme": str(raw.get("ui_theme") or ""),
        "dashboard_theme": str(raw.get("dashboard_theme") or ""),
        "config_changed": bool(raw.get("config_changed", False)),
        "theme_files_changed": bool(raw.get("theme_files_changed", False)),
        "changed": bool(raw.get("changed", False)),
    }


def _dashboard_proxy_error(status_code: int = 503) -> JSONResponse:
    return JSONResponse({"detail": _DASHBOARD_PUBLIC_ERROR}, status_code=status_code)


async def _sync_dashboard_theme_from_payload(config: HermelinConfig, payload: dict | None) -> dict:
    ui_theme = ""
    if isinstance(payload, dict):
        ui_theme = str(payload.get("ui_theme") or payload.get("theme") or "").strip()
    return await asyncio.to_thread(sync_dashboard_theme_for_ui_theme, config.hermes_home, ui_theme)


async def _sync_dashboard_theme_response(config: HermelinConfig, payload: dict | None) -> dict[str, object] | JSONResponse:
    try:
        return _dashboard_public_theme_sync(await _sync_dashboard_theme_from_payload(config, payload))
    except Exception:
        logger.warning("failed to sync Hermes dashboard theme", exc_info=True)
        return JSONResponse({"detail": _DASHBOARD_THEME_SYNC_ERROR}, status_code=500)


def register_hermes_dashboard_routes(
    app: FastAPI,
    *,
    config: HermelinConfig,
    dashboard_manager: Any,
    dashboard_base_path: str,
    request_origin_forbidden_response: Callable[[Request], JSONResponse | None],
    request_external_scheme: Callable[[Request], str],
    websocket_origin_allowed: Callable[[WebSocket], bool],
    websocket_external_scheme: Callable[[WebSocket], str],
    check_allowed: Callable[[str], bool],
    auth_enabled: bool,
    is_authenticated: Callable[[str | None], bool],
    cookie_name: str,
    trust_xff: bool,
) -> None:
    @app.get("/api/hermes-dashboard/status")
    async def api_hermes_dashboard_status(request: Request):
        blocked = request_origin_forbidden_response(request)
        if blocked is not None:
            return blocked
        return _dashboard_public_status(dashboard_manager.status(), dashboard_base_path=dashboard_base_path)

    @app.post("/api/hermes-dashboard/theme")
    async def api_hermes_dashboard_theme(request: Request, payload: dict | None = Body(None)):
        blocked = request_origin_forbidden_response(request)
        if blocked is not None:
            return blocked
        return await _sync_dashboard_theme_response(config, payload)

    @app.post("/api/hermes-dashboard/start")
    async def api_hermes_dashboard_start(request: Request, payload: dict | None = Body(None)):
        blocked = request_origin_forbidden_response(request)
        if blocked is not None:
            return blocked
        theme_sync = await _sync_dashboard_theme_response(config, payload)
        if isinstance(theme_sync, JSONResponse):
            return theme_sync
        status = _dashboard_public_status(await dashboard_manager.start(), dashboard_base_path=dashboard_base_path)
        return {**status, "dashboard_theme": theme_sync.get("dashboard_theme"), "theme_sync": theme_sync}

    @app.post("/api/hermes-dashboard/restart")
    async def api_hermes_dashboard_restart(request: Request, payload: dict | None = Body(None)):
        blocked = request_origin_forbidden_response(request)
        if blocked is not None:
            return blocked
        theme_sync = await _sync_dashboard_theme_response(config, payload)
        if isinstance(theme_sync, JSONResponse):
            return theme_sync
        status = _dashboard_public_status(await dashboard_manager.restart(), dashboard_base_path=dashboard_base_path)
        return {**status, "dashboard_theme": theme_sync.get("dashboard_theme"), "theme_sync": theme_sync}

    @app.post("/api/hermes-dashboard/stop")
    async def api_hermes_dashboard_stop(request: Request):
        blocked = request_origin_forbidden_response(request)
        if blocked is not None:
            return blocked
        return _dashboard_public_status(await dashboard_manager.stop(), dashboard_base_path=dashboard_base_path)

    @app.api_route(dashboard_base_path, methods=_DASHBOARD_PROXY_METHODS)
    @app.api_route(f"{dashboard_base_path}/{{path:path}}", methods=_DASHBOARD_PROXY_METHODS)
    async def hermes_dashboard_proxy(request: Request, path: str = ""):
        blocked = request_origin_forbidden_response(request)
        if blocked is not None:
            return blocked
        if request.method == "OPTIONS":
            return Response(status_code=204)

        await dashboard_manager.ensure_started()
        upstream = dashboard_manager.upstream()
        if not upstream:
            return _dashboard_proxy_error(status_code=503)

        scheme, host, port = upstream
        upstream_path = f"/{path}" if path else "/"
        upstream_url = f"{scheme}://{host}:{port}{upstream_path}"
        if request.url.query:
            upstream_url += f"?{request.url.query}"

        try:
            body = await request.body()
        except Exception:
            body = b""

        client = getattr(request.app.state, "httpx_client", None)
        close_client = False
        if client is None:
            client = httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=None, write=60.0, pool=5.0),
                follow_redirects=False,
            )
            close_client = True

        try:
            req = client.build_request(
                method=request.method,
                url=upstream_url,
                headers=_dashboard_filter_request_headers(
                    request,
                    dashboard_base_path=dashboard_base_path,
                    request_external_scheme=request_external_scheme,
                ),
                content=body,
            )
            upstream_resp = await client.send(req, stream=True)
        except Exception:
            logger.exception("Hermes dashboard proxy error")
            if close_client:
                await client.aclose()
            return _dashboard_proxy_error(status_code=502)

        resp_headers = _dashboard_filter_response_headers(
            upstream_resp.headers,
            dashboard_base_path=dashboard_base_path,
            upstream_port=port,
        )

        if should_rewrite_dashboard_body(upstream_path, upstream_resp.headers.get("content-type", "")):
            try:
                raw_body = await upstream_resp.aread()
                body = rewrite_dashboard_body(
                    raw_body,
                    content_type=upstream_resp.headers.get("content-type", ""),
                    base_path=dashboard_base_path,
                )
                for header_name in list(resp_headers):
                    if header_name.lower() in {"content-encoding", "content-length"}:
                        resp_headers.pop(header_name, None)
            finally:
                try:
                    await upstream_resp.aclose()
                except Exception:
                    pass
                if close_client:
                    try:
                        await client.aclose()
                    except Exception:
                        pass
            return Response(
                content=body,
                status_code=upstream_resp.status_code,
                headers=resp_headers,
            )

        async def _iter_bytes():
            try:
                async for chunk in upstream_resp.aiter_raw():
                    yield chunk
            finally:
                try:
                    await upstream_resp.aclose()
                except Exception:
                    pass
                if close_client:
                    try:
                        await client.aclose()
                    except Exception:
                        pass

        return StreamingResponse(
            _iter_bytes(),
            status_code=upstream_resp.status_code,
            headers=resp_headers,
        )

    @app.websocket(dashboard_base_path)
    @app.websocket(f"{dashboard_base_path}/{{path:path}}")
    async def ws_hermes_dashboard_proxy(websocket: WebSocket, path: str = ""):
        client_ip = extract_client_ip(
            client_host=websocket.client.host if websocket.client else "",
            headers=websocket.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )

        await websocket.accept()
        if not check_allowed(client_ip):
            await websocket.close(code=1008)
            return

        if auth_enabled:
            token = extract_cookie_value(websocket.headers.get("cookie", ""), cookie_name)
            if not is_authenticated(token):
                await websocket.close(code=1008)
                return

        if not websocket_origin_allowed(websocket):
            await websocket.close(code=1008)
            return

        status = await dashboard_manager.ensure_started()
        upstream = dashboard_manager.upstream()
        if not upstream:
            logger.warning("Hermes dashboard websocket unavailable: %s", status.get("last_error"))
            await websocket.close(code=1011)
            return

        scheme, host, port = upstream
        ws_scheme = "wss" if scheme == "https" else "ws"
        upstream_path = f"/{path}" if path else "/"
        qs = websocket.scope.get("query_string", b"")
        try:
            qs_s = qs.decode("utf-8") if isinstance(qs, (bytes, bytearray)) else str(qs)
        except Exception:
            qs_s = ""
        upstream_url = f"{ws_scheme}://{host}:{port}{upstream_path}"
        if qs_s:
            upstream_url += f"?{qs_s}"

        subp_header = websocket.headers.get("sec-websocket-protocol")
        subprotocols = [p.strip() for p in subp_header.split(",") if p.strip()] if subp_header else None
        extra_headers = {
            "X-Forwarded-Host": websocket.headers.get("host", ""),
            "X-Forwarded-Proto": websocket_external_scheme(websocket),
            "X-Forwarded-Prefix": dashboard_base_path,
        }

        try:
            async with websockets.connect(
                upstream_url,
                **websockets_connect_kwargs(subprotocols=subprotocols, extra_headers=extra_headers),
            ) as upstream_ws:

                async def _client_to_upstream():
                    while True:
                        msg = await websocket.receive()
                        mt = msg.get("type")
                        if mt == "websocket.disconnect":
                            try:
                                await upstream_ws.close()
                            except Exception:
                                pass
                            break
                        if mt != "websocket.receive":
                            continue
                        if msg.get("text") is not None:
                            await upstream_ws.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await upstream_ws.send(msg["bytes"])

                async def _upstream_to_client():
                    async for message in upstream_ws:
                        if isinstance(message, (bytes, bytearray)):
                            await websocket.send_bytes(bytes(message))
                        else:
                            await websocket.send_text(str(message))

                t1 = asyncio.create_task(_client_to_upstream())
                t2 = asyncio.create_task(_upstream_to_client())
                done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
        except Exception:
            logger.warning("Hermes dashboard WebSocket proxy connection failed", exc_info=True)
            try:
                await websocket.close(code=1011)
            except Exception:
                pass
            return

        try:
            await websocket.close()
        except Exception:
            pass
