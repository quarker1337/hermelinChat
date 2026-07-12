from __future__ import annotations

import asyncio
from dataclasses import dataclass
import ipaddress
import json
import os
from pathlib import Path
import stat
from typing import Any
from urllib.parse import quote, urlparse
import warnings

import httpx
from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse


FLEET_API_PREFIX = "/api/v1"
DEFAULT_LOCAL_FLEET_URL = "http://127.0.0.1:8080"
FLEET_DISABLED_PAYLOAD = {
    "code": "fleet_disabled",
    "detail": "fleet integration is disabled",
}
FLEET_UNAVAILABLE_PAYLOAD = {
    "code": "fleet_unavailable",
    "detail": "fleet integration is not available",
}
_VALID_FLEET_MODES = {"off", "external", "local"}


@dataclass(frozen=True)
class FleetSettings:
    mode: str
    enabled: bool
    configured: bool
    available: bool
    base_url: str
    admin_token_configured: bool


def _read_protected_service_token(path_value: object) -> str:
    path_text = str(path_value or "").strip()
    if not path_text:
        return ""
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(str(Path(path_text).expanduser()), flags)
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid()
                or info.st_mode & 0o077
                or info.st_size > 8192
            ):
                return ""
            payload = os.read(descriptor, 8193)
        finally:
            os.close(descriptor)
    except OSError:
        return ""
    if len(payload) > 8192:
        return ""
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return ""
    tokens = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if len(tokens) != 1 or any(character.isspace() for character in tokens[0]):
        return ""
    return tokens[0]


def fleet_bridge_token(config: object) -> str:
    """Return the reloadable scoped bridge credential; never fall back to administrator identity."""
    token_file = getattr(config, "fleet_service_token_file", None)
    if token_file is not None:
        return _read_protected_service_token(token_file)
    return str(getattr(config, "fleet_service_token", "") or "").strip()


def _is_loopback_host(hostname: str) -> bool:
    host = str(hostname or "").strip().rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_fleet_bridge_url(raw: object, *, allow_insecure_public: bool = False) -> str:
    """Return a safe Fleet bridge base URL without a trailing slash.

    HTTPS is accepted for any host. Plain HTTP is restricted to loopback unless
    the explicit development override is on. Validation performs no DNS lookup.
    """
    text = str(raw or "").strip().rstrip("/")
    if not text:
        return ""
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return ""
    try:
        hostname = parsed.hostname or ""
        _ = parsed.port
    except ValueError:
        return ""
    if not hostname:
        return ""
    if parsed.scheme == "http" and not allow_insecure_public:
        if not _is_loopback_host(hostname):
            return ""
    return text


def resolve_fleet_settings(config: object, *, warn_legacy: bool = False) -> FleetSettings:
    raw_mode = str(getattr(config, "fleet_mode", "") or "").strip().lower()
    allow_insecure_public = bool(getattr(config, "fleet_allow_insecure_http", False))
    raw_url = str(getattr(config, "fleet_bridge_url", "") or "").strip()

    if raw_mode and raw_mode not in _VALID_FLEET_MODES:
        mode = "off"
    elif raw_mode:
        mode = raw_mode
    else:
        legacy_url = normalize_fleet_bridge_url(raw_url, allow_insecure_public=allow_insecure_public)
        mode = "external" if legacy_url else "off"
        if mode == "external" and warn_legacy:
            warnings.warn(
                "A Fleet URL without HERMELIN_FLEET_MODE is deprecated; set HERMELIN_FLEET_MODE=external.",
                DeprecationWarning,
                stacklevel=3,
            )

    candidate_url = raw_url
    if mode == "local" and not candidate_url:
        candidate_url = DEFAULT_LOCAL_FLEET_URL
    base_url = normalize_fleet_bridge_url(candidate_url, allow_insecure_public=allow_insecure_public)
    if mode == "local" and base_url and not _is_loopback_host(urlparse(base_url).hostname or ""):
        base_url = ""
    enabled = mode in {"external", "local"}
    configured = bool(base_url)
    admin_token = fleet_bridge_token(config)
    return FleetSettings(
        mode=mode,
        enabled=enabled,
        configured=configured,
        available=enabled and configured,
        base_url=base_url,
        admin_token_configured=bool(admin_token),
    )


def public_fleet_config(
    config: object,
    *,
    settings: FleetSettings | None = None,
) -> dict[str, Any]:
    resolved = settings or resolve_fleet_settings(config)
    return {
        "mode": resolved.mode,
        "enabled": resolved.enabled,
        "configured": resolved.configured,
        "available": resolved.available,
        "admin_token_configured": resolved.admin_token_configured,
    }


def _safe_skin_name(value: object) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 64:
        return ""
    if not all(ch.isalnum() or ch in {"-", "_"} for ch in text):
        return ""
    return text


def _local_skin_yaml(config: object, skin: str) -> str:
    skin = _safe_skin_name(skin)
    if not skin:
        return ""
    hermes_home = Path(getattr(config, "hermes_home", "") or "").expanduser()
    if not hermes_home:
        return ""
    path = hermes_home / "skins" / f"{skin}.yaml"
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return ""
    if len(text.encode("utf-8")) > 64 * 1024:
        return ""
    return text


def _enrich_runtime_skin_payload(config: object, payload: dict[str, Any]) -> dict[str, Any]:
    body = dict(payload)
    skin = _safe_skin_name(body.get("skin"))
    if not skin:
        return body
    if body.get("skin_yaml"):
        return body
    skin_yaml = _local_skin_yaml(config, skin)
    if skin_yaml:
        body["skin_yaml"] = skin_yaml
    return body


def _json_response(content: Any, status_code: int = 200) -> JSONResponse:
    if content is None:
        content = {"ok": True}
    return JSONResponse(content, status_code=status_code)


def _upstream_error_response(response: httpx.Response, *, admin: bool) -> JSONResponse:
    try:
        data: Any = response.json()
    except Exception:
        data = {"detail": (response.text or "fleet bridge request failed")[:2000]}

    if response.status_code == 401:
        detail = "fleet bridge rejected the configured service credential" if admin else "fleet bridge returned unauthorized"
        return JSONResponse({"detail": detail, "upstream_status": 401}, status_code=502)

    return _json_response(data, status_code=response.status_code)


def fleet_route_unavailable_response(settings: FleetSettings) -> JSONResponse | None:
    if not settings.enabled:
        return JSONResponse(dict(FLEET_DISABLED_PAYLOAD), status_code=503)
    if not settings.available:
        return JSONResponse(dict(FLEET_UNAVAILABLE_PAYLOAD), status_code=503)
    return None


async def _fleet_proxy_json(
    request: Request,
    config: object,
    settings: FleetSettings,
    method: str,
    upstream_path: str,
    *,
    admin: bool = False,
    json_body: Any | None = None,
    query_params: dict[str, Any] | None = None,
) -> JSONResponse:
    unavailable = fleet_route_unavailable_response(settings)
    if unavailable is not None:
        return unavailable
    base_url = settings.base_url

    path = str(upstream_path or "").strip()
    if not path.startswith(f"{FLEET_API_PREFIX}/") and path != FLEET_API_PREFIX:
        return JSONResponse({"detail": "invalid fleet bridge path"}, status_code=400)

    headers = {"Accept": "application/json"}
    if admin:
        token = fleet_bridge_token(config)
        if not token:
            return JSONResponse({"detail": "fleet service credential is not configured"}, status_code=503)
        headers["Authorization"] = f"Bearer {token}"

    params = {k: v for k, v in (query_params or {}).items() if v is not None and str(v) != ""}
    url = f"{base_url}{path}"

    client = getattr(request.app.state, "fleet_http_client", None)
    if client is None:
        return JSONResponse(dict(FLEET_UNAVAILABLE_PAYLOAD), status_code=503)

    try:
        response = await client.request(
            method.upper(),
            url,
            headers=headers,
            json=json_body,
            params=params or None,
        )
    except httpx.RequestError:
        return JSONResponse(
            {"detail": "fleet bridge unavailable"},
            status_code=502,
        )

    if response.status_code >= 400:
        return _upstream_error_response(response, admin=admin)

    if response.status_code == 204:
        return JSONResponse({"ok": True}, status_code=200)

    try:
        data = response.json()
    except Exception:
        data = {"detail": (response.text or "")[:2000]}
    return _json_response(data, status_code=response.status_code)


def _agent_path(agent_id: str, suffix: str = "") -> str:
    safe_id = quote(str(agent_id or "").strip(), safe="")
    if not safe_id:
        return ""
    return f"{FLEET_API_PREFIX}/agents/{safe_id}{suffix}"


def _node_path(node: str, suffix: str = "") -> str:
    safe_node = quote(str(node or "").strip(), safe="")
    if not safe_node:
        return ""
    return f"{FLEET_API_PREFIX}/nodes/{safe_node}{suffix}"


def register_fleet_routes(
    app: FastAPI,
    *,
    config: object,
    settings: FleetSettings | None = None,
) -> None:
    """Register authenticated HermelinChat -> HermelinFleet bridge proxy routes."""
    resolved = settings or resolve_fleet_settings(config)

    def _unavailable() -> JSONResponse | None:
        return fleet_route_unavailable_response(resolved)

    @app.middleware("http")
    async def _fleet_mode_gate(request: Request, call_next):
        path = request.url.path.rstrip("/") or "/"
        if path.startswith("/api/fleet/") and path != "/api/fleet/config":
            unavailable = _unavailable()
            if unavailable is not None:
                return unavailable
        return await call_next(request)

    @app.get("/api/fleet/config")
    async def api_fleet_config():
        return public_fleet_config(config, settings=resolved)

    @app.get("/api/fleet/snapshot")
    async def api_fleet_snapshot(request: Request):
        specs = (
            ("status", f"{FLEET_API_PREFIX}/status"),
            ("nodes", f"{FLEET_API_PREFIX}/nodes"),
            ("agents", f"{FLEET_API_PREFIX}/agents"),
            ("runtimes", f"{FLEET_API_PREFIX}/runtimes"),
            ("sessions", f"{FLEET_API_PREFIX}/sessions"),
            ("capabilities", f"{FLEET_API_PREFIX}/capabilities"),
        )
        responses = await asyncio.gather(
            *(
                _fleet_proxy_json(request, config, resolved, "GET", path, admin=True)
                for _, path in specs
            )
        )
        payload: dict[str, Any] = {"config": public_fleet_config(config, settings=resolved)}
        for (key, _), response in zip(specs, responses, strict=True):
            # Remote runtimes are an additive v1 extension. Older supported
            # centrals still provide cockpit data and must downgrade cleanly.
            if key == "runtimes" and response.status_code == 404:
                payload[key] = {"runtimes": []}
                continue
            if response.status_code >= 400:
                return response
            try:
                payload[key] = json.loads(bytes(response.body).decode("utf-8"))
            except Exception:
                return JSONResponse(
                    {"code": "fleet_invalid_response", "detail": f"Fleet {key} response was not JSON"},
                    status_code=502,
                )
        return payload

    @app.get("/api/fleet/status")
    async def api_fleet_status(request: Request):
        return await _fleet_proxy_json(request, config, resolved, "GET", f"{FLEET_API_PREFIX}/status", admin=True)

    @app.get("/api/fleet/nodes")
    async def api_fleet_nodes(request: Request):
        return await _fleet_proxy_json(request, config, resolved, "GET", f"{FLEET_API_PREFIX}/nodes", admin=True)

    @app.get("/api/fleet/agents")
    async def api_fleet_agents(request: Request):
        return await _fleet_proxy_json(request, config, resolved, "GET", f"{FLEET_API_PREFIX}/agents", admin=True)

    @app.get("/api/fleet/agents/{agent_id}")
    async def api_fleet_agent(request: Request, agent_id: str):
        path = _agent_path(agent_id)
        if not path:
            return JSONResponse({"detail": "invalid agent id"}, status_code=400)
        return await _fleet_proxy_json(request, config, resolved, "GET", path, admin=True)

    @app.get("/api/fleet/agents/{agent_id}/logs")
    async def api_fleet_agent_logs(request: Request, agent_id: str, limit: int = 200):
        path = _agent_path(agent_id, "/logs")
        if not path:
            return JSONResponse({"detail": "invalid agent id"}, status_code=400)
        safe_limit = max(1, min(int(limit or 200), 2000))
        return await _fleet_proxy_json(request, config, resolved, "GET", path, admin=True, query_params={"limit": safe_limit})

    @app.post("/api/fleet/agents/{agent_id}/inject")
    async def api_fleet_agent_inject(request: Request, agent_id: str, payload: dict = Body(default={})):  # type: ignore[assignment]
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "payload must be an object"}, status_code=400)
        message = str(payload.get("message") or "").strip()
        if not message:
            return JSONResponse({"detail": "message is required"}, status_code=400)

        body: dict[str, Any] = {"message": message}
        session_id = str(payload.get("session_id") or "").strip()
        if session_id:
            body["session_id"] = session_id
        op = str(payload.get("op") or "").strip()
        if op:
            body["op"] = op

        path = _agent_path(agent_id, "/inject")
        if not path:
            return JSONResponse({"detail": "invalid agent id"}, status_code=400)
        return await _fleet_proxy_json(request, config, resolved, "POST", path, admin=True, json_body=body)

    @app.get("/api/fleet/sessions")
    async def api_fleet_sessions(request: Request):
        return await _fleet_proxy_json(request, config, resolved, "GET", f"{FLEET_API_PREFIX}/sessions", admin=True)

    @app.get("/api/fleet/runtimes")
    async def api_fleet_runtimes(request: Request):
        return await _fleet_proxy_json(request, config, resolved, "GET", f"{FLEET_API_PREFIX}/runtimes", admin=True)

    @app.get("/api/fleet/nodes/{node}/runtimes")
    async def api_fleet_node_runtimes(request: Request, node: str):
        path = _node_path(node, "/runtimes")
        if not path:
            return JSONResponse({"detail": "invalid node"}, status_code=400)
        return await _fleet_proxy_json(request, config, resolved, "GET", path, admin=True)

    @app.post("/api/fleet/nodes/{node}/runtimes")
    async def api_fleet_node_runtime_create(request: Request, node: str, payload: dict = Body(default={})):  # type: ignore[assignment]
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "payload must be an object"}, status_code=400)
        path = _node_path(node, "/runtimes")
        if not path:
            return JSONResponse({"detail": "invalid node"}, status_code=400)
        body = _enrich_runtime_skin_payload(config, payload)
        return await _fleet_proxy_json(request, config, resolved, "POST", path, admin=True, json_body=body)

    @app.post("/api/fleet/nodes/{node}/runtimes/{runtime_id}/stop")
    async def api_fleet_node_runtime_stop(request: Request, node: str, runtime_id: str):
        safe_runtime = quote(str(runtime_id or "").strip(), safe="")
        if not safe_runtime:
            return JSONResponse({"detail": "invalid runtime id"}, status_code=400)
        path = _node_path(node, f"/runtimes/{safe_runtime}/stop")
        if not path:
            return JSONResponse({"detail": "invalid node"}, status_code=400)
        return await _fleet_proxy_json(request, config, resolved, "POST", path, admin=True, json_body={})

    @app.get("/api/fleet/capabilities")
    async def api_fleet_capabilities(request: Request):
        return await _fleet_proxy_json(request, config, resolved, "GET", f"{FLEET_API_PREFIX}/capabilities", admin=True)
