from __future__ import annotations

import asyncio
import hmac
import json
import os
import time
from collections import defaultdict, deque
import shlex
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Optional

import yaml

import httpx
import websockets
from urllib.parse import urlparse

from fastapi import Body, FastAPI, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from .artifacts import (
    artifact_bridge_commands_dir,
    artifact_bridge_response_path,
    artifact_bridge_state_path,
    cleanup_session_artifacts,
    delete_artifact,
    is_valid_artifact_id,
    latest_artifact,
    list_artifacts,
)
from .auth import (
    create_runner_token,
    create_session_token,
    extract_cookie_value,
    generate_secret_bytes,
    verify_login_password,
    verify_runner_token,
    verify_session_token,
)
from .config import HermelinConfig
from .meta_db import ensure_meta_db, get_random_whisper, get_titles_map
from .pty_handler import PtyProcess
from .security import extract_client_ip, ip_allowed
from .state_reader import get_message_context, list_sessions, search_messages
from .runners import discover_runner_upstream


def create_app(config: HermelinConfig | None = None) -> FastAPI:
    config = config or HermelinConfig()

    # Ensure meta DB exists (titles, etc.)
    try:
        ensure_meta_db(config.meta_db_path)
    except Exception:
        # Non-fatal; UI will just fall back to first message titles.
        pass

    app = FastAPI(title="hermelinChat", version="0.12", docs_url="/api/docs", redoc_url=None)
    # CORS: disabled by default (same-origin UI does not need it).
    # To enable (e.g. behind a separate UI origin), set HERMELIN_CORS_ORIGINS to a
    # comma-separated list of origins. Wildcard '*' is intentionally not supported.
    cors_origins = [o.strip() for o in (getattr(config, 'cors_origins', '') or '').split(',') if o.strip() and o.strip() != '*']
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=['*'],
            allow_headers=['*'],
        )

    # ---------------------------------------------------------------------
    # Security: IP allowlist + password session cookie
    # ---------------------------------------------------------------------
    allowed_spec = (config.allowed_ips or "").strip()
    trust_xff = bool(config.trust_x_forwarded_for)

    auth_password_hash = (config.auth_password_hash or "").strip()
    auth_enabled = bool(auth_password_hash)

    # Basic brute-force protection (per-IP failed login rate limit)
    try:
        auth_max_fails = int(os.getenv("HERMELIN_AUTH_MAX_FAILS", "8"))
    except ValueError:
        auth_max_fails = 8
    try:
        auth_fail_window_seconds = int(os.getenv("HERMELIN_AUTH_FAIL_WINDOW_SECONDS", "60"))
    except ValueError:
        auth_fail_window_seconds = 60

    _auth_failures: dict[str, deque[float]] = defaultdict(deque)

    def _auth_prune(dq: deque[float], now: float) -> None:
        if auth_fail_window_seconds <= 0:
            dq.clear()
            return
        while dq and (now - dq[0]) > auth_fail_window_seconds:
            dq.popleft()

    def _auth_retry_after(ip: str) -> int:
        if auth_max_fails <= 0 or auth_fail_window_seconds <= 0:
            return 0
        now = time.monotonic()
        dq = _auth_failures[ip]
        _auth_prune(dq, now)
        if len(dq) < auth_max_fails:
            return 0
        retry_after = int(auth_fail_window_seconds - (now - dq[0]))
        if retry_after < 1:
            retry_after = 1
        return retry_after

    def _auth_record_failure(ip: str) -> None:
        if auth_max_fails <= 0 or auth_fail_window_seconds <= 0:
            return
        now = time.monotonic()
        dq = _auth_failures[ip]
        _auth_prune(dq, now)
        dq.append(now)
        max_keep = max(auth_max_fails * 2, 32)
        while len(dq) > max_keep:
            dq.popleft()

    def _auth_clear_failures(ip: str) -> None:
        _auth_failures.pop(ip, None)

    cookie_name = (config.cookie_name or "hermelin_session").strip() or "hermelin_session"
    ttl_seconds = int(config.session_ttl_seconds or 0) or 43200
    cookie_secure = bool(config.cookie_secure)

    cookie_secret_raw = (config.cookie_secret or "").strip()
    cookie_secret = cookie_secret_raw.encode("utf-8") if cookie_secret_raw else generate_secret_bytes()

    def _check_allowed(client_ip: str) -> bool:
        return ip_allowed(client_ip, allowed_spec)

    def _is_authenticated(token: str | None) -> bool:
        if not auth_enabled:
            return True
        if not token:
            return False
        return verify_session_token(token=token, secret=cookie_secret)

    def _is_public_path(path: str) -> bool:
        # SPA + static: public. Guard /api (except /api/auth/*).
        if not path.startswith("/api"):
            return True
        if path.startswith("/api/auth/"):
            return True
        return False

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        client_ip = extract_client_ip(
            client_host=request.client.host if request.client else "",
            headers=request.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )
        if not _check_allowed(client_ip):
            return JSONResponse({"detail": "forbidden"}, status_code=403)

        if auth_enabled and not _is_public_path(request.url.path):
            token = request.cookies.get(cookie_name)
            if not _is_authenticated(token):
                return JSONResponse({"detail": "unauthorized"}, status_code=401)

        return await call_next(request)

    def _read_default_model_from_config_file() -> Optional[str]:
        cfg_path = config.hermes_home / "config.yaml"
        try:
            text = cfg_path.read_text(encoding="utf-8")
        except Exception:
            return None

        for line in text.splitlines():
            # Only accept a top-level key (no indentation) to avoid matching nested
            # keys like: stt.model / tts.openai.model / etc.
            if not line:
                continue
            if line[:1].isspace():
                continue
            if line.startswith("#"):
                continue
            if line.startswith("model:"):
                return line.split(":", 1)[1].strip() or None
        return None

    @app.get("/api/health")
    async def health():
        return {
            "ok": True,
            "hermes_home": str(config.hermes_home),
            "db_path": str(config.db_path),
            "db_exists": config.db_path.exists(),
            "allowed_ips": allowed_spec,
            "trust_x_forwarded_for": trust_xff,
            "auth_enabled": auth_enabled,
            "cookie_name": cookie_name,
            "session_ttl_seconds": ttl_seconds,
            "cookie_secure": cookie_secure,
        }

    @app.get("/api/info")
    async def api_info():
        return {
            "default_model": _read_default_model(),
            "spawn_cwd": str(config.spawn_cwd),
            "hermes_cmd": config.hermes_cmd,
            "hermes_home": str(config.hermes_home),
            "artifact_dir": str(config.artifact_dir),
        }

    @app.get("/api/artifacts")
    async def api_artifacts():
        return list_artifacts(config.artifact_dir)

    @app.get("/api/artifacts/latest")
    async def api_artifacts_latest():
        return latest_artifact(config.artifact_dir)

    def _artifact_bridge_safe(value: str, fallback: str = "") -> str:
        raw = str(value or "").strip()
        if not raw:
            return fallback
        return raw if is_valid_artifact_id(raw) else fallback

    def _artifact_bridge_write_state(artifact_id: str, channel: str, event_name: str, request_id: str, payload: dict) -> None:
        now = time.time()
        path = artifact_bridge_state_path(config.artifact_dir, artifact_id, channel)
        path.parent.mkdir(parents=True, exist_ok=True)

        previous: dict = {}
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(previous, dict):
                previous = {}
        except Exception:
            previous = {}

        next_state = dict(previous)
        next_state.update(
            {
                "artifact_id": artifact_id,
                "channel": channel,
                "event": event_name,
                "request_id": request_id or None,
                "payload": payload,
                "updated_at": now,
            }
        )
        if isinstance(payload, dict):
            if "code" in payload:
                next_state["code"] = payload.get("code")
            if "position" in payload:
                next_state["position"] = payload.get("position")
            if "playing" in payload:
                next_state["playing"] = payload.get("playing")
            if event_name == "ready":
                next_state["ready"] = True

        tmp_path = path.with_name(f".{path.name}.{int(now * 1000)}.tmp")
        tmp_path.write_text(json.dumps(next_state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, path)

    @app.post("/api/artifacts/bridge/event")
    async def api_artifact_bridge_event(payload: dict = Body(default={})):  # type: ignore[assignment]
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "payload must be an object"}, status_code=400)

        artifact_id = _artifact_bridge_safe(payload.get("artifact_id") or payload.get("artifactId") or payload.get("id"), "")
        if not artifact_id:
            return JSONResponse({"detail": "invalid artifact_id"}, status_code=400)

        channel = _artifact_bridge_safe(payload.get("channel"), "")
        if not channel:
            return JSONResponse({"detail": "invalid channel"}, status_code=400)

        event_name = str(payload.get("event") or "").strip()
        if not event_name:
            return JSONResponse({"detail": "event is required"}, status_code=400)

        request_id = _artifact_bridge_safe(payload.get("request_id") or payload.get("requestId"), "")
        event_payload = payload.get("payload")
        if not isinstance(event_payload, dict):
            event_payload = {"value": event_payload}

        try:
            _artifact_bridge_write_state(artifact_id, channel, event_name, request_id, event_payload)
            if request_id:
                response_path = artifact_bridge_response_path(config.artifact_dir, request_id)
                response_path.parent.mkdir(parents=True, exist_ok=True)
                response_obj = {
                    "artifact_id": artifact_id,
                    "channel": channel,
                    "event": event_name,
                    "request_id": request_id,
                    "payload": event_payload,
                    "updated_at": time.time(),
                }
                tmp_path = response_path.with_name(f".{response_path.name}.{int(time.time() * 1000)}.tmp")
                tmp_path.write_text(json.dumps(response_obj, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(tmp_path, response_path)
        except Exception as exc:
            return JSONResponse({"detail": f"failed to store bridge event: {exc}"}, status_code=500)

        return {"ok": True, "artifact_id": artifact_id, "channel": channel, "event": event_name, "request_id": request_id or None}

    # ---------------------------------------------------------------------
    # Runner gateway (iframe runners)
    # ---------------------------------------------------------------------

    @app.post("/api/runners/{tab_id}/token")
    async def api_runner_token(request: Request, tab_id: str):
        """Mint a short-lived runner token for a sandboxed iframe.

        This endpoint is protected by the normal /api guard (IP allowlist +
        session cookie auth when enabled).

        The token is embedded into the runner proxy URL path so the iframe can
        authenticate without cookies.
        """

        if not is_valid_artifact_id(tab_id):
            return JSONResponse({"detail": "invalid tab id"}, status_code=400)

        ttl = int(getattr(config, "runner_token_ttl_seconds", 1800) or 1800)
        if ttl < 30:
            ttl = 30

        client_ip = extract_client_ip(
            client_host=request.client.host if request.client else "",
            headers=request.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )

        bind_ip = bool(getattr(config, "runner_token_bind_ip", True))

        token = create_runner_token(
            secret=cookie_secret,
            tab_id=tab_id,
            ttl_seconds=ttl,
            client_ip=client_ip if bind_ip else None,
        )

        expires_at = int(time.time()) + ttl
        base_path = f"/r/{tab_id}/_t/{token}"
        return {
            "ok": True,
            "tab_id": tab_id,
            "token": token,
            "expires_at": expires_at,
            "base_path": base_path,
        }

    _RUNNER_HOP_BY_HOP_HEADERS = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }

    _RUNNER_STRIP_REQUEST_HEADERS = {
        # Never forward hermilinChat session material to runners.
        "cookie",
        "authorization",
    }

    _RUNNER_STRIP_RESPONSE_HEADERS = {
        # Runner must never be able to set cookies on hermilinChat origin.
        "set-cookie",
    }

    def _runner_proxy_prefix(tab_id: str, token: str) -> str:
        return f"/r/{tab_id}/_t/{token}"

    def _runner_rewrite_location(value: str, *, tab_id: str, token: str, upstream_port: int) -> str:
        """Rewrite Location headers so redirects stay inside the runner proxy."""

        loc = (value or "").strip()
        if not loc:
            return value

        prefix = _runner_proxy_prefix(tab_id, token)

        # Already rewritten.
        if loc.startswith(prefix):
            return loc

        # Absolute path redirect (common): /login
        if loc.startswith("/"):
            return f"{prefix}{loc}"

        # Full URL redirect: http://127.0.0.1:1234/login
        try:
            parsed = urlparse(loc)
        except Exception:
            return loc

        host = (parsed.hostname or "").strip().lower()
        port = parsed.port
        if host in {"127.0.0.1", "localhost", "0.0.0.0", "::1"} and port == upstream_port:
            path = parsed.path or "/"
            out = f"{prefix}{path}"
            if parsed.query:
                out += f"?{parsed.query}"
            if parsed.fragment:
                out += f"#{parsed.fragment}"
            return out

        return loc

    def _runner_filter_request_headers(request: Request) -> dict[str, str]:
        out: dict[str, str] = {}
        for k, v in request.headers.items():
            lk = k.lower()
            if lk in _RUNNER_HOP_BY_HOP_HEADERS:
                continue
            if lk in _RUNNER_STRIP_REQUEST_HEADERS:
                continue
            if lk == "host":
                continue
            out[k] = v
        return out

    def _runner_filter_response_headers(
        headers: httpx.Headers,
        *,
        tab_id: str,
        token: str,
        upstream_port: int,
    ) -> dict[str, str]:
        out: dict[str, str] = {}
        for k, v in headers.items():
            lk = k.lower()
            if lk in _RUNNER_HOP_BY_HOP_HEADERS:
                continue
            if lk in _RUNNER_STRIP_RESPONSE_HEADERS:
                continue
            if lk == "content-length":
                # Avoid mismatches when streaming.
                continue
            if lk == "location":
                v = _runner_rewrite_location(v, tab_id=tab_id, token=token, upstream_port=upstream_port)
            out[k] = v
        return out

    _RUNNER_PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

    @app.api_route("/r/{tab_id}/_t/{token}", methods=_RUNNER_PROXY_METHODS)
    @app.api_route("/r/{tab_id}/_t/{token}/{path:path}", methods=_RUNNER_PROXY_METHODS)
    async def runner_proxy(request: Request, tab_id: str, token: str, path: str = ""):
        if not is_valid_artifact_id(tab_id):
            return JSONResponse({"detail": "invalid tab id"}, status_code=400)

        client_ip = extract_client_ip(
            client_host=request.client.host if request.client else "",
            headers=request.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )
        bind_ip = bool(getattr(config, "runner_token_bind_ip", True))
        if not verify_runner_token(
            token=token,
            secret=cookie_secret,
            tab_id=tab_id,
            client_ip=client_ip if bind_ip else None,
        ):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)

        upstream = discover_runner_upstream(config.artifact_dir, tab_id)
        if not upstream:
            return JSONResponse({"detail": "runner_not_found"}, status_code=404)

        scheme, host, port = upstream
        upstream_path = f"/{path}" if path else "/"
        upstream_url = f"{scheme}://{host}:{port}{upstream_path}"
        if request.url.query:
            upstream_url += f"?{request.url.query}"

        if request.method == "OPTIONS":
            # Same-origin by default; keep this simple.
            return Response(status_code=204)

        req_headers = _runner_filter_request_headers(request)
        body = b""
        try:
            body = await request.body()
        except Exception:
            body = b""

        timeout = httpx.Timeout(connect=5.0, read=None, write=60.0, pool=5.0)
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=False)

        try:
            req = client.build_request(
                method=request.method,
                url=upstream_url,
                headers=req_headers,
                content=body,
            )
            upstream_resp = await client.send(req, stream=True)
        except Exception as exc:
            try:
                await client.aclose()
            except Exception:
                pass
            return JSONResponse({"detail": f"runner_proxy_error: {exc}"}, status_code=502)

        resp_headers = _runner_filter_response_headers(
            upstream_resp.headers,
            tab_id=tab_id,
            token=token,
            upstream_port=port,
        )

        async def _iter_bytes():
            try:
                async for chunk in upstream_resp.aiter_bytes():
                    yield chunk
            finally:
                try:
                    await upstream_resp.aclose()
                except Exception:
                    pass
                try:
                    await client.aclose()
                except Exception:
                    pass

        return StreamingResponse(
            _iter_bytes(),
            status_code=upstream_resp.status_code,
            headers=resp_headers,
        )

    @app.websocket("/r/{tab_id}/_t/{token}")
    @app.websocket("/r/{tab_id}/_t/{token}/{path:path}")
    async def ws_runner_proxy(websocket: WebSocket, tab_id: str, token: str, path: str = ""):
        client_ip = extract_client_ip(
            client_host=websocket.client.host if websocket.client else "",
            headers=websocket.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )

        # Accept first so we can send close frames consistently.
        await websocket.accept()

        if not _check_allowed(client_ip):
            await websocket.close(code=1008)
            return

        if not is_valid_artifact_id(tab_id):
            await websocket.close(code=1008)
            return

        bind_ip = bool(getattr(config, "runner_token_bind_ip", True))
        if not verify_runner_token(
            token=token,
            secret=cookie_secret,
            tab_id=tab_id,
            client_ip=client_ip if bind_ip else None,
        ):
            await websocket.close(code=1008)
            return

        upstream = discover_runner_upstream(config.artifact_dir, tab_id)
        if not upstream:
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

        try:
            async with websockets.connect(upstream_url, subprotocols=subprotocols) as upstream_ws:

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
                for t in pending:
                    t.cancel()
        except Exception:
            try:
                await websocket.close(code=1011)
            except Exception:
                pass
            return

        try:
            await websocket.close()
        except Exception:
            pass

    @app.delete("/api/artifacts/{artifact_id}")
    async def api_delete_artifact(artifact_id: str):
        if not is_valid_artifact_id(artifact_id):
            return JSONResponse({"detail": "invalid artifact id"}, status_code=400)
        try:
            removed = delete_artifact(config.artifact_dir, artifact_id)
        except ValueError:
            return JSONResponse({"detail": "invalid artifact id"}, status_code=400)
        except FileNotFoundError:
            removed = False
        except Exception as exc:
            return JSONResponse({"detail": f"failed to delete artifact: {exc}"}, status_code=500)
        return {"ok": True, "artifact_id": artifact_id, "removed": removed}

    def _hermes_bin() -> str:
        try:
            argv = shlex.split(config.hermes_cmd)
            if argv:
                return argv[0]
        except Exception:
            pass
        return "hermes"

    def _parse_model_from_config_show(text: str) -> Optional[str]:
        # hermes config show output contains multiple "Model:" lines (e.g. context compression).
        # Prefer the one in the "◆ Model" section.
        in_model_section = False
        for line in (text or "").splitlines():
            s = line.strip()
            if not s:
                continue

            if s.lower() == "◆ model":
                in_model_section = True
                continue

            if in_model_section and s.startswith("◆"):
                # next section
                break

            if in_model_section and s.startswith("Model:"):
                return s.split(":", 1)[1].strip() or None

        # Fallback: first Model: line in output
        for line in (text or "").splitlines():
            s = line.strip()
            if s.startswith("Model:"):
                return s.split(":", 1)[1].strip() or None

        return None

    def _read_default_model_from_hermes_show() -> Optional[str]:
        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        cmd = [_hermes_bin(), "config", "show"]
        try:
            r = subprocess.run(
                cmd,
                cwd=str(config.spawn_cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except Exception:
            return None

        if r.returncode != 0:
            return None

        return _parse_model_from_config_show(r.stdout or "")

    def _read_default_model() -> Optional[str]:
        # Prefer Hermes' own resolver (config show) so the UI matches what Hermes reports.
        m = _read_default_model_from_hermes_show()
        if m:
            return m
        return _read_default_model_from_config_file()

    def _save_dotenv_value(key: str, value: str) -> None:
        env_path = config.hermes_home / ".env"

        lines: list[str] = []
        try:
            if env_path.exists():
                lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
        except Exception:
            lines = []

        found = False
        out: list[str] = []

        for line in lines:
            s = line.lstrip()
            if s.startswith("#"):
                out.append(line)
                continue

            if s.startswith(f"{key}="):
                out.append(f"{key}={value}\n")
                found = True
            else:
                out.append(line)

        if not found:
            if out and not out[-1].endswith("\n"):
                out[-1] = out[-1] + "\n"
            out.append(f"{key}={value}\n")

        try:
            config.hermes_home.mkdir(parents=True, exist_ok=True)
            env_path.write_text("".join(out), encoding="utf-8")
        except Exception:
            # Best effort — model is still stored in config.yaml.
            pass

    def _hermes_config_set_model(model: str) -> tuple[bool, str]:
        m = (model or "").strip()
        if not m:
            return False, "model is empty"
        if len(m) > 200:
            return False, "model too long"

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        try:
            config.hermes_home.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        cmd = [_hermes_bin(), "config", "set", "model", m]
        try:
            r = subprocess.run(
                cmd,
                cwd=str(config.spawn_cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except FileNotFoundError:
            return False, f"executable not found: {cmd[0]}"
        except subprocess.TimeoutExpired:
            return False, "timed out"
        except Exception as e:
            return False, str(e)

        if r.returncode != 0:
            msg = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            out = "\n".join([x for x in [msg, err] if x])
            if not out:
                out = f"hermes config set failed (code {r.returncode})"
            if len(out) > 800:
                out = out[:800] + "…"
            return False, out

        # IMPORTANT: hermes' runtime CLI reads LLM_MODEL from ~/.hermes/.env (loaded via dotenv)
        # and prioritizes it over config.yaml. Keep them in sync.
        _save_dotenv_value("LLM_MODEL", m)

        return True, ""

    def _strip_leading_index(s: str) -> str:
        # Remove leading numbering like "1) ..." or "1. ...".
        i = 0
        while i < len(s) and s[i].isdigit():
            i += 1
        if i and i < len(s) and s[i] in {".", ")", ":"}:
            j = i + 1
            while j < len(s) and s[j].isspace():
                j += 1
            return s[j:]
        return s

    def _parse_model_list_text(text: str) -> list[dict]:
        out: list[dict] = []
        seen: set[str] = set()

        for line in (text or "").splitlines():
            s = (line or "").strip()
            if not s:
                continue

            low = s.lower()
            if low.startswith("select default model"):
                continue

            # separators
            if s and set(s) <= {"-"}:
                continue

            # bullets
            while s and s[0] in {"-", "*", "•"}:
                s = s[1:].strip()

            s = _strip_leading_index(s)
            if not s:
                continue

            low = s.lower()
            if low in {"custom model", "custom"}:
                value = "__custom__"
                label = "Custom model"
            else:
                value = s.split()[0].strip()
                label = s

            if not value or value in seen:
                continue

            seen.add(value)
            out.append({"value": value, "label": label})

        if "__custom__" not in seen:
            out.append({"value": "__custom__", "label": "Custom model"})

        return out

    _model_list_cache: dict = {"models": None, "source": None}

    def _read_model_list_from_hermes_cli() -> tuple[Optional[list[dict]], str]:
        """
        Best-effort: read Hermes Agent's canonical OpenRouter model menu (the one used by `hermes model`).

        We run inside Hermes' own venv (as referenced by the hermes launcher shebang),
        so hermilinChat doesn't need hermes_cli installed in its own venv.
        """

        hermes_bin = _hermes_bin()
        hermes_path = hermes_bin
        if not os.path.isabs(hermes_path):
            hermes_path = shutil.which(hermes_bin) or hermes_path

        try:
            first = Path(hermes_path).read_text(encoding="utf-8").splitlines()[0].strip()
        except Exception:
            return None, "no_shebang"

        if not first.startswith("#!"):
            return None, "no_shebang"

        shebang = first[2:].strip()
        try:
            argv = shlex.split(shebang)
        except Exception:
            argv = shebang.split()

        if not argv:
            return None, "no_shebang"

        # Handle: #!/usr/bin/env python3
        if Path(argv[0]).name == "env" and len(argv) >= 2:
            py = shutil.which(argv[1]) or argv[1]
            py_argv = [py] + argv[2:]
        else:
            py_argv = argv

        py = py_argv[0]
        extra = py_argv[1:]

        code = (
            "import json\n"
            "from hermes_cli.models import OPENROUTER_MODELS\n"
            "out=[]\n"
            "for mid, desc in OPENROUTER_MODELS:\n"
            "  label = f\"{mid} ({desc})\" if desc else mid\n"
            "  out.append({'value': mid, 'label': label})\n"
            "print(json.dumps(out))\n"
        )

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        cmd = [py] + extra + ["-c", code]
        try:
            r = subprocess.run(
                cmd,
                cwd=str(config.spawn_cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except Exception:
            return None, "hermes_cli_error"

        if r.returncode != 0:
            return None, "hermes_cli_error"

        try:
            data = json.loads((r.stdout or "").strip())
        except Exception:
            return None, "hermes_cli_parse_error"

        if not isinstance(data, list) or not data:
            return None, "hermes_cli_empty"

        models: list[dict] = []
        seen: set[str] = set()
        for m in data:
            if not isinstance(m, dict):
                continue
            value = str(m.get("value") or "").strip()
            label = str(m.get("label") or value).strip()
            if not value or value in seen:
                continue
            seen.add(value)
            models.append({"value": value, "label": label})

        if "__custom__" not in seen:
            models.append({"value": "__custom__", "label": "Custom model"})

        return models, "hermes_cli"

    def _read_model_list_options() -> tuple[list[dict], str]:
        env_path = (os.getenv("HERMELIN_MODEL_LIST_PATH") or "").strip()
        if env_path:
            try:
                p = Path(env_path).expanduser()
                text = p.read_text(encoding="utf-8")
                models = _parse_model_list_text(text)
                if models:
                    return models, str(p)
            except Exception:
                pass

        cached = _model_list_cache.get("models")
        if cached:
            return cached, str(_model_list_cache.get("source") or "cache")

        models, source = _read_model_list_from_hermes_cli()
        if models:
            _model_list_cache["models"] = models
            _model_list_cache["source"] = source
            return models, source

        fallback = [
            {"value": "openai/gpt-5.2", "label": "openai/gpt-5.2"},
            {"value": "anthropic/claude-sonnet-4", "label": "anthropic/claude-sonnet-4"},
            {"value": "google/gemini-2.5-pro", "label": "google/gemini-2.5-pro"},
            {"value": "google/gemini-3-flash-preview", "label": "google/gemini-3-flash-preview"},
            {"value": "__custom__", "label": "Custom model"},
        ]
        return fallback, "fallback"

    @app.get("/api/settings/models")
    async def api_settings_models():
        models, source = _read_model_list_options()
        return {
            "models": models,
            "source": source,
        }

    @app.get("/api/settings/model")
    async def api_settings_model():
        return {
            "model": _read_default_model(),
        }

    @app.post("/api/settings/model")
    async def api_settings_model_set(payload: dict = Body(...)):
        model = str(payload.get("model") or "").strip()
        if not model:
            return JSONResponse({"detail": "model required"}, status_code=400)
        if len(model) > 200:
            return JSONResponse({"detail": "model too long"}, status_code=400)

        ok, err = await asyncio.to_thread(_hermes_config_set_model, model)
        if not ok:
            return JSONResponse(
                {
                    "detail": "failed to set model",
                    "error": err,
                },
                status_code=500,
            )

        return {
            "ok": True,
            "model": _read_default_model() or model,
        }

    def _read_dotenv_vars() -> dict[str, str]:
        env_path = config.hermes_home / ".env"
        out: dict[str, str] = {}
        try:
            if not env_path.exists():
                return out
            for raw in env_path.read_text(encoding="utf-8").splitlines():
                line = (raw or "").strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"\'')
                if k:
                    out[k] = v
        except Exception:
            return out
        return out

    _SUPPORTED_API_KEYS = {
        # Model provider
        "OPENROUTER_API_KEY",
        # Tools
        "FIRECRAWL_API_KEY",
        "BROWSERBASE_API_KEY",
        "BROWSERBASE_PROJECT_ID",
        "GITHUB_TOKEN",
    }

    def _hermes_config_set_env_key(key: str, value: str) -> tuple[bool, str]:
        k = (key or "").strip().upper()
        v = (value or "").strip()
        if not k:
            return False, "key is required"
        if k not in _SUPPORTED_API_KEYS:
            return False, "unsupported key"
        if not v:
            return False, "value is required"
        if len(v) > 2000:
            return False, "value too long"

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        cmd = [_hermes_bin(), "config", "set", k, v]
        try:
            r = subprocess.run(
                cmd,
                cwd=str(config.spawn_cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except FileNotFoundError:
            return False, f"executable not found: {cmd[0]}"
        except subprocess.TimeoutExpired:
            return False, "timed out"
        except Exception as e:
            return False, str(e)

        if r.returncode != 0:
            msg = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            out = "\n".join([x for x in [msg, err] if x])
            if not out:
                out = f"hermes config set failed (code {r.returncode})"
            if len(out) > 800:
                out = out[:800] + "…"
            return False, out

        return True, ""

    @app.get("/api/settings/keys")
    async def api_settings_keys():
        env_vars = _read_dotenv_vars()

        def _is_set(name: str) -> bool:
            v = env_vars.get(name)
            return bool(v and str(v).strip())

        keys = {k: {"set": _is_set(k)} for k in sorted(_SUPPORTED_API_KEYS)}
        return {"keys": keys}

    @app.post("/api/settings/keys")
    async def api_settings_keys_set(payload: dict = Body(...)):
        key = str(payload.get("key") or "").strip().upper()
        value = str(payload.get("value") or "").strip()
        if not key:
            return JSONResponse({"detail": "key required"}, status_code=400)
        if key not in _SUPPORTED_API_KEYS:
            return JSONResponse({"detail": "unsupported key"}, status_code=400)
        if not value:
            return JSONResponse({"detail": "value required"}, status_code=400)

        ok, err = await asyncio.to_thread(_hermes_config_set_env_key, key, value)
        if not ok:
            return JSONResponse(
                {
                    "detail": "failed to set key",
                    "error": err,
                },
                status_code=500,
            )

        return {"ok": True, "key": key}

    # -----------------------------------------------------------------
    # Hermes-Agent settings (config.yaml)
    # -----------------------------------------------------------------

    _SUPPORTED_AGENT_CONFIG_KEYS = {
        # Agent loop
        "agent.max_turns",
        "agent.verbose",
        "agent.reasoning_effort",
        # Root-level legacy (kept in sync so `hermes config show` isn't misleading)
        "max_turns",
        # Display
        "display.compact",
        "display.tool_progress",
        # Memory
        "memory.memory_enabled",
        "memory.user_profile_enabled",
        # Context compression
        "compression.enabled",
        "compression.threshold",
        "compression.summary_model",
        # Terminal tool
        "terminal.cwd",
        "terminal.timeout",
    }

    def _read_config_yaml() -> dict:
        cfg_path = config.hermes_home / "config.yaml"
        try:
            if not cfg_path.exists():
                return {}
            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _set_display_skin(skin: str) -> bool:
        """Best-effort: set display.skin in Hermes' config.yaml.

        Hermes reads the skin at startup; hermilinChat uses this to auto-sync the
        CLI skin with the UI theme.
        """

        skin = str(skin or "").strip()
        if not skin:
            return False

        cfg_path = config.hermes_home / "config.yaml"
        data = _read_config_yaml()

        display = data.get("display") if isinstance(data.get("display"), dict) else {}
        if not isinstance(display, dict):
            display = {}

        if str(display.get("skin") or "").strip() == skin:
            return False

        display["skin"] = skin
        data["display"] = display

        try:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            cfg_path.write_text(
                yaml.safe_dump(
                    data,
                    sort_keys=False,
                    default_flow_style=False,
                    allow_unicode=True,
                ),
                encoding="utf-8",
            )
            return True
        except Exception:
            return False

    def _as_bool(v, default: bool = False) -> bool:
        if v is None:
            return default
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return bool(v)
        s = str(v).strip().lower()
        if s in {"1", "true", "yes", "y", "on"}:
            return True
        if s in {"0", "false", "no", "n", "off"}:
            return False
        return default

    def _as_int(v, default: int) -> int:
        try:
            return int(v)
        except Exception:
            return default

    def _as_float(v, default: float) -> float:
        try:
            return float(v)
        except Exception:
            return default

    def _get_cfg() -> dict:
        raw = _read_config_yaml()

        # Defaults (best-effort; these mirror cli.py defaults, not necessarily hermes_cli/config.py)
        agent = raw.get("agent") if isinstance(raw.get("agent"), dict) else {}
        terminal = raw.get("terminal") if isinstance(raw.get("terminal"), dict) else {}
        compression = raw.get("compression") if isinstance(raw.get("compression"), dict) else {}
        display = raw.get("display") if isinstance(raw.get("display"), dict) else {}
        memory = raw.get("memory") if isinstance(raw.get("memory"), dict) else {}

        max_turns = agent.get("max_turns")
        if max_turns is None:
            max_turns = raw.get("max_turns")

        threshold = _as_float(compression.get("threshold"), 0.85)
        threshold_pct = int(round(threshold * 100))
        threshold_pct = max(50, min(99, threshold_pct))

        return {
            "agent": {
                "max_turns": max(1, min(500, _as_int(max_turns, 60))),
                "verbose": _as_bool(agent.get("verbose"), False),
                "reasoning_effort": str(agent.get("reasoning_effort") or "xhigh").strip() or "xhigh",
            },
            "display": {
                "compact": _as_bool(display.get("compact"), False),
                "tool_progress": str(display.get("tool_progress") or "all").strip() or "all",
            },
            "memory": {
                "memory_enabled": _as_bool(memory.get("memory_enabled"), True),
                "user_profile_enabled": _as_bool(memory.get("user_profile_enabled"), True),
            },
            "compression": {
                "enabled": _as_bool(compression.get("enabled"), True),
                "threshold_pct": threshold_pct,
                "summary_model": str(compression.get("summary_model") or "google/gemini-3-flash-preview").strip()
                or "google/gemini-3-flash-preview",
            },
            "terminal": {
                "backend": str(terminal.get("backend") or terminal.get("env_type") or "local").strip() or "local",
                "cwd": str(terminal.get("cwd") or ".").strip() or ".",
                "timeout": max(1, min(3600, _as_int(terminal.get("timeout"), 60))),
            },
            "config_path": str(config.hermes_home / "config.yaml"),
        }

    def _hermes_config_set_value(key: str, value: str) -> tuple[bool, str]:
        k = (key or "").strip()
        v = (value or "").strip()

        if not k:
            return False, "key is required"
        if k not in _SUPPORTED_AGENT_CONFIG_KEYS:
            return False, "unsupported key"
        if not v:
            return False, "value is required"
        if len(v) > 8000:
            return False, "value too long"

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        cmd = [_hermes_bin(), "config", "set", k, v]
        try:
            r = subprocess.run(
                cmd,
                cwd=str(config.spawn_cwd),
                env=env,
                capture_output=True,
                text=True,
                timeout=25,
            )
        except FileNotFoundError:
            return False, f"executable not found: {cmd[0]}"
        except subprocess.TimeoutExpired:
            return False, "timed out"
        except Exception as e:
            return False, str(e)

        if r.returncode != 0:
            msg = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            out = "\n".join([x for x in [msg, err] if x])
            if not out:
                out = f"hermes config set failed (code {r.returncode})"
            if len(out) > 800:
                out = out[:800] + "…"
            return False, out

        return True, ""

    @app.get("/api/settings/agent")
    async def api_settings_agent():
        return _get_cfg()

    @app.post("/api/settings/agent")
    async def api_settings_agent_set(payload: dict = Body(...)):
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "invalid payload"}, status_code=400)

        cur = _get_cfg()

        agent_in = payload.get("agent") if isinstance(payload.get("agent"), dict) else {}
        display_in = payload.get("display") if isinstance(payload.get("display"), dict) else {}
        memory_in = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
        compression_in = payload.get("compression") if isinstance(payload.get("compression"), dict) else {}
        terminal_in = payload.get("terminal") if isinstance(payload.get("terminal"), dict) else {}

        # Build normalized draft
        draft = {
            "agent": {
                "max_turns": max(1, min(500, _as_int(agent_in.get("max_turns"), cur["agent"]["max_turns"]))),
                "verbose": _as_bool(agent_in.get("verbose"), cur["agent"]["verbose"]),
                "reasoning_effort": str(agent_in.get("reasoning_effort") or cur["agent"]["reasoning_effort"]).strip()
                or cur["agent"]["reasoning_effort"],
            },
            "display": {
                "compact": _as_bool(display_in.get("compact"), cur["display"]["compact"]),
                "tool_progress": str(display_in.get("tool_progress") or cur["display"]["tool_progress"]).strip()
                or cur["display"]["tool_progress"],
            },
            "memory": {
                "memory_enabled": _as_bool(memory_in.get("memory_enabled"), cur["memory"]["memory_enabled"]),
                "user_profile_enabled": _as_bool(
                    memory_in.get("user_profile_enabled"),
                    cur["memory"]["user_profile_enabled"],
                ),
            },
            "compression": {
                "enabled": _as_bool(compression_in.get("enabled"), cur["compression"]["enabled"]),
                "threshold_pct": max(50, min(99, _as_int(compression_in.get("threshold_pct"), cur["compression"]["threshold_pct"]))),
                "summary_model": str(compression_in.get("summary_model") or cur["compression"]["summary_model"]).strip()
                or cur["compression"]["summary_model"],
            },
            "terminal": {
                "cwd": str(terminal_in.get("cwd") or cur["terminal"]["cwd"]).strip() or cur["terminal"]["cwd"],
                "timeout": max(1, min(3600, _as_int(terminal_in.get("timeout"), cur["terminal"]["timeout"]))),
            },
        }

        # Validate enums
        reff = draft["agent"]["reasoning_effort"].lower()
        if reff not in {"xhigh", "high", "medium", "low", "minimal", "none"}:
            return JSONResponse({"detail": "invalid reasoning_effort"}, status_code=400)

        tp = draft["display"]["tool_progress"].lower()
        if tp not in {"off", "new", "all", "verbose"}:
            return JSONResponse({"detail": "invalid tool_progress"}, status_code=400)

        if len(draft["compression"]["summary_model"]) > 200:
            return JSONResponse({"detail": "summary_model too long"}, status_code=400)

        if len(draft["terminal"]["cwd"]) > 500:
            return JSONResponse({"detail": "cwd too long"}, status_code=400)

        # Apply via hermes config set
        threshold = draft["compression"]["threshold_pct"] / 100.0

        pairs = [
            ("agent.max_turns", str(draft["agent"]["max_turns"])),
            ("max_turns", str(draft["agent"]["max_turns"])),
            ("agent.verbose", "true" if draft["agent"]["verbose"] else "false"),
            ("agent.reasoning_effort", reff),
            ("display.compact", "true" if draft["display"]["compact"] else "false"),
            ("display.tool_progress", tp),
            ("memory.memory_enabled", "true" if draft["memory"]["memory_enabled"] else "false"),
            ("memory.user_profile_enabled", "true" if draft["memory"]["user_profile_enabled"] else "false"),
            ("compression.enabled", "true" if draft["compression"]["enabled"] else "false"),
            ("compression.threshold", f"{threshold:.4f}"),
            ("compression.summary_model", draft["compression"]["summary_model"]),
            ("terminal.cwd", draft["terminal"]["cwd"]),
            ("terminal.timeout", str(draft["terminal"]["timeout"])),
        ]

        def _apply_all() -> tuple[bool, str]:
            for k, v in pairs:
                ok, err = _hermes_config_set_value(k, v)
                if not ok:
                    return False, f"{k}: {err}"
            return True, ""

        ok, err = await asyncio.to_thread(_apply_all)
        if not ok:
            return JSONResponse({"detail": "failed to save", "error": err}, status_code=500)

        # Return fresh values
        return {"ok": True, **_get_cfg()}

    @app.get("/api/whisper")
    async def api_whisper():
        # Return a very short UI "whisper" string (randomly sampled).
        try:
            raw = get_random_whisper(config.meta_db_path)
        except Exception:
            raw = None

        text = (raw or "aligned to you…").strip()

        # Template substitutions
        display_name = (
            os.getenv("HERMELIN_DISPLAY_NAME")
            or os.getenv("USER")
            or os.getenv("LOGNAME")
            or "you"
        ).strip() or "you"

        text = (
            text.replace("{user}", display_name)
            .replace("$Username", display_name)
            .replace("$USER", display_name)
        )

        # Ensure single-line + sane max length
        text = " ".join(str(text).splitlines()).strip()
        if len(text) > 80:
            text = text[:79] + "…"

        return {"text": text}

    # -----------------------------------------------------------------
    # Auth (password -> signed session cookie)
    # -----------------------------------------------------------------

    @app.get("/api/auth/me")
    async def auth_me(request: Request):
        token = request.cookies.get(cookie_name)
        return {
            "auth_enabled": auth_enabled,
            "authenticated": _is_authenticated(token),
        }

    @app.post("/api/auth/login")
    async def auth_login(request: Request, payload: dict = Body(...)):
        if not auth_enabled:
            return {"ok": True, "auth_enabled": False}

        client_ip = extract_client_ip(
            client_host=request.client.host if request.client else "",
            headers=request.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )

        retry_after = _auth_retry_after(client_ip)
        if retry_after:
            return JSONResponse(
                {"detail": "rate_limited"},
                status_code=429,
                headers={"Retry-After": str(retry_after)},
            )

        password = str(payload.get("password") or "")
        if not verify_login_password(password, auth_password_hash):
            _auth_record_failure(client_ip)
            return JSONResponse({"detail": "unauthorized"}, status_code=401)

        _auth_clear_failures(client_ip)

        token = create_session_token(secret=cookie_secret, ttl_seconds=ttl_seconds)
        resp = JSONResponse({"ok": True, "auth_enabled": True})
        resp.set_cookie(
            key=cookie_name,
            value=token,
            max_age=ttl_seconds,
            httponly=True,
            secure=cookie_secure,
            samesite="strict",
            path="/",
        )
        return resp

    @app.post("/api/auth/logout")
    async def auth_logout():
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(cookie_name, path="/")
        return resp

    @app.get("/api/sessions")
    async def api_sessions(
        limit: int = 50,
        offset: int = 0,
        source: Optional[str] = None,
    ):
        sessions = list_sessions(config.db_path, limit=limit, offset=offset, source=source)

        # Overlay custom titles from meta DB, if present.
        try:
            titles = get_titles_map(config.meta_db_path, [s.get("id") for s in sessions])
        except Exception:
            titles = {}

        for s in sessions:
            sid = s.get("id")
            t = titles.get(sid)
            if t:
                s["title"] = t
                s["title_source"] = "meta"
            else:
                s["title_source"] = "first_message"

        return {
            "sessions": sessions,
        }

    @app.get("/api/search")
    async def api_search(
        q: str,
        limit: int = 20,
        offset: int = 0,
        session_id: Optional[str] = None,
    ):
        results = search_messages(
            config.db_path,
            query=q,
            limit=limit,
            offset=offset,
            session_id=session_id,
        )

        # Overlay session titles in search results.
        try:
            titles = get_titles_map(config.meta_db_path, {r.get("session_id") for r in results})
        except Exception:
            titles = {}

        for r in results:
            sid = r.get("session_id")
            t = titles.get(sid)
            if t:
                r["session_title"] = t

        return {
            "results": results,
        }

    @app.get("/api/messages/context")
    async def api_message_context(
        message_id: int,
        before: int = 3,
        after: int = 3,
    ):
        ctx = get_message_context(config.db_path, message_id=message_id, before=before, after=after)
        if ctx is None:
            return JSONResponse({"detail": "not found"}, status_code=404)

        # Overlay custom title if available.
        try:
            sid = ctx.get("session_id")
            t = get_titles_map(config.meta_db_path, [sid]).get(sid) if sid else None
            if t:
                ctx["session_title"] = t
        except Exception:
            pass

        return ctx

    @app.websocket("/ws/pty")
    async def ws_pty(
        websocket: WebSocket,
        resume: Optional[str] = None,
        cont: bool = Query(False, alias="continue"),
        cols: int = 120,
        rows: int = 30,
    ):
        client_ip = extract_client_ip(
            client_host=websocket.client.host if websocket.client else "",
            headers=websocket.headers,
            trust_xff=trust_xff,
            trusted_proxy_spec=config.trusted_proxy_ips,
        )

        await websocket.accept()
        if not _check_allowed(client_ip):
            await websocket.close(code=1008)
            return

        if auth_enabled:
            token = extract_cookie_value(websocket.headers.get("cookie", ""), cookie_name)
            if not _is_authenticated(token):
                await websocket.close(code=1008)
                return

        argv = shlex.split(config.hermes_cmd)

        # -------------------------------------------------------------
        # hermilinChat UI theme -> Hermes CLI skin (upstream skin system)
        # -------------------------------------------------------------
        # Hermes reads the active skin from ~/.hermes/config.yaml (display.skin).
        # There is no per-launch CLI flag, so we sync the skin before spawning Hermes.
        ui_theme = ""
        try:
            ui_theme = (websocket.query_params.get("ui_theme") or "").strip()
        except Exception:
            ui_theme = ""

        skin_name: str | None = None
        if ui_theme == "hermilin":
            skin_name = "hermilin"
        elif ui_theme == "matrix":
            skin_name = "matrix"
        elif ui_theme == "nous":
            skin_name = "nous"
        elif ui_theme == "samaritan":
            skin_name = "samaritan"

        try:
            exe_name = Path(argv[0]).name.lower() if argv else ""
        except Exception:
            exe_name = ""

        if skin_name and "hermes" in exe_name:
            try:
                _set_display_skin(skin_name)
            except Exception:
                pass

        if resume:
            argv += ["--resume", resume]
        elif cont:
            argv += ["--continue"]

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        env.setdefault("PYTHONUNBUFFERED", "1")
        env.setdefault("HERMES_HOME", str(config.hermes_home))

        # Avoid surprising overrides: hermes' runtime CLI prioritizes env vars
        # (and loads ~/.hermes/.env via dotenv). We want config.yaml/.env to be
        # the source of truth, not the environment hermilinChat was launched with.
        for k in (
            "LLM_MODEL",
            "OPENAI_MODEL",
            "HERMES_MODEL",
            "HERMES_INFERENCE_PROVIDER",
            "OPENROUTER_API_KEY",
            "FIRECRAWL_API_KEY",
            "BROWSERBASE_API_KEY",
            "BROWSERBASE_PROJECT_ID",
            "GITHUB_TOKEN",
            # IMPORTANT: Rich will prefer these env vars over the actual PTY
            # TIOCGWINSZ width/height. If hermilinChat was started from a wide
            # local terminal (e.g. 160 cols) and the shell exported COLUMNS,
            # Hermes/Rich will render as if it had that width regardless of the
            # real xterm.js viewport. We must drop them so Rich reads from the
            # PTY.
            "COLUMNS",
            "LINES",
        ):
            env.pop(k, None)

        # -------------------------------------------------------------
        # New session: cleanup session-scoped artifacts
        # -------------------------------------------------------------
        if not resume and not cont:
            try:
                info = cleanup_session_artifacts(config.artifact_dir)
                did_remove = bool(
                    (info or {}).get("removed_artifacts")
                    or (info or {}).get("pid_files_removed")
                    or (info or {}).get("runner_scripts_removed")
                )

                # If we wiped out all artifacts, explicitly tell the UI to hide the
                # panel (otherwise it can remain open in an empty-state).
                if did_remove:
                    try:
                        if not list_artifacts(config.artifact_dir):
                            await websocket.send_text(
                                json.dumps(
                                    {
                                        "type": "artifact_close",
                                        "payload": {
                                            "action": "close_all",
                                            "scope": "session",
                                        },
                                    },
                                    ensure_ascii=False,
                                )
                            )
                    except Exception:
                        pass
            except Exception:
                # Best-effort cleanup only.
                pass

        # -------------------------------------------------------------
        # PTY sizing
        # -------------------------------------------------------------
        # In theory FastAPI should inject ?cols= / ?rows= into the handler
        # parameters. In practice, different WS stacks / proxies can behave
        # unexpectedly, and the first banner render is extremely sensitive to
        # the *initial* PTY size (Rich reads it once and formats accordingly).
        #
        # We therefore:
        #   1) Re-parse query params directly from the websocket URL.
        #   2) Wait briefly for the first "resize" control frame from the UI
        #      before spawning the subprocess, so the banner uses the correct
        #      width from the very first byte.

        try:
            qp = websocket.query_params
            cq = qp.get("cols")
            rq = qp.get("rows")
            if cq:
                cols = int(cq)
            if rq:
                rows = int(rq)
        except Exception:
            pass

        cols = int(cols or 0) or 120
        rows = int(rows or 0) or 30
        if cols < 10:
            cols = 10
        if rows < 5:
            rows = 5

        init_cols = cols
        init_rows = rows

        prefetched: list[dict] = []
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 0.6
            while loop.time() < deadline:
                msg = await asyncio.wait_for(websocket.receive(), timeout=deadline - loop.time())
                if msg.get("type") == "websocket.disconnect":
                    return

                t = msg.get("text")
                if t:
                    try:
                        payload = json.loads(t)
                    except json.JSONDecodeError:
                        prefetched.append(msg)
                        continue

                    if payload.get("type") == "resize":
                        c = int(payload.get("cols") or 0)
                        r = int(payload.get("rows") or 0)
                        if c > 0 and r > 0:
                            init_cols = c
                            init_rows = r
                            break

                prefetched.append(msg)
        except asyncio.TimeoutError:
            pass
        except Exception:
            # Non-fatal; fall back to query/default cols/rows.
            prefetched = []

        print(f"[hermelin] spawning PTY cols={init_cols} rows={init_rows} (query cols={cols} rows={rows})")

        # Ensure the spawn cwd exists (default is ~/.hermes/artifacts/runners/projects).
        try:
            config.spawn_cwd.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        p = PtyProcess.spawn(argv, cwd=config.spawn_cwd, env=env, cols=init_cols, rows=init_rows)

        def _artifact_snapshot() -> dict[str, dict]:
            items = list_artifacts(config.artifact_dir)
            out: dict[str, dict] = {}
            for item in items:
                if not isinstance(item, dict):
                    continue
                artifact_id = item.get("id")
                if not artifact_id:
                    continue
                out[str(artifact_id)] = item
            return out

        def _artifact_changed(prev: dict | None, curr: dict) -> bool:
            if not isinstance(prev, dict):
                return True
            prev_ts = float(prev.get("timestamp") or 0.0)
            curr_ts = float(curr.get("timestamp") or 0.0)
            if prev_ts != curr_ts:
                return True
            prev_updated = float(prev.get("updated_at") or 0.0)
            curr_updated = float(curr.get("updated_at") or 0.0)
            return prev_updated != curr_updated

        def _artifact_list_payload(snapshot: dict[str, dict]) -> str:
            payload = sorted(snapshot.values(), key=lambda item: float(item.get("timestamp") or 0.0), reverse=True)
            return json.dumps({"type": "artifact_list", "payload": payload}, ensure_ascii=False)

        def _artifact_payload(item: dict) -> str:
            return json.dumps({"type": "artifact", "payload": item}, ensure_ascii=False)

        def _artifact_close_payload(artifact_id: str) -> str:
            return json.dumps({"type": "artifact_close", "payload": {"id": artifact_id}}, ensure_ascii=False)

        def _handle_ws_message(msg: dict) -> bool:
            """Return False to stop reading (disconnect)."""
            if msg.get("type") == "websocket.disconnect":
                return False

            b = msg.get("bytes")
            if b is not None:
                if b:
                    p.write(b)
                return True

            t = msg.get("text")
            if t is None:
                return True

            # Control frames are JSON over text.
            # Terminal keystrokes are sent as bytes frames.
            try:
                payload = json.loads(t)
            except json.JSONDecodeError:
                p.write(t.encode("utf-8", errors="ignore"))
                return True

            if payload.get("type") == "resize":
                c = int(payload.get("cols") or 0)
                r = int(payload.get("rows") or 0)
                if c > 0 and r > 0:
                    p.resize(cols=c, rows=r)
                return True

            if payload.get("type") == "signal":
                sig = str(payload.get("sig") or "").upper()
                if sig in {"INT", "TERM", "HUP", "QUIT"}:
                    try:
                        os.killpg(p.proc.pid, getattr(signal, f"SIG{sig}"))
                    except Exception:
                        pass
                elif sig == "KILL":
                    p.kill()
                return True

            # Unknown JSON payload: ignore.
            return True

        # Replay any messages we received while waiting for the first resize.
        for msg in prefetched:
            try:
                if not _handle_ws_message(msg):
                    break
            except Exception:
                pass

        async def pump_pty_to_ws() -> None:
            try:
                while True:
                    data = await asyncio.to_thread(os.read, p.master_fd, 8192)
                    if not data:
                        break
                    await websocket.send_bytes(data)
            except Exception:
                # WebSocket closed, PTY died, etc.
                pass

        async def pump_ws_to_pty() -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if not _handle_ws_message(msg):
                        break
            except Exception:
                pass

        async def pump_artifacts_to_ws() -> None:
            try:
                previous = _artifact_snapshot()
                if previous:
                    await websocket.send_text(_artifact_list_payload(previous))

                # Optional control signal written by Hermes' close_panel tool.
                close_signal_path = config.artifact_dir / "_close_signal.json"
                close_signal_seen_ns = 0
                try:
                    close_signal_seen_ns = close_signal_path.stat().st_mtime_ns
                except Exception:
                    close_signal_seen_ns = 0

                # Optional focus signal written by Hermes' focus_artifact tool.
                focus_signal_path = config.artifact_dir / "_focus.json"
                focus_signal_seen_ns = 0

                # One-shot bridge commands written by Hermes-side artifact tools.
                bridge_commands_dir = artifact_bridge_commands_dir(config.artifact_dir)

                while True:
                    await asyncio.sleep(0.75)
                    current = _artifact_snapshot()

                    # If close_panel() wrote a close_all signal, forward it so the UI can
                    # actually hide the panel (not just remove tabs).
                    try:
                        ns = close_signal_path.stat().st_mtime_ns
                        if ns and ns != close_signal_seen_ns:
                            close_signal_seen_ns = ns
                            try:
                                sig = json.loads(close_signal_path.read_text(encoding="utf-8"))
                            except Exception:
                                sig = None
                            if isinstance(sig, dict) and sig.get("action") == "close_all":
                                await websocket.send_text(json.dumps({"type": "artifact_close", "payload": sig}, ensure_ascii=False))
                    except FileNotFoundError:
                        pass
                    except Exception:
                        pass

                    # If focus_artifact() wrote a focus signal, forward it so the UI can
                    # switch the active tab and open the panel.
                    try:
                        ns = focus_signal_path.stat().st_mtime_ns
                        if ns and ns != focus_signal_seen_ns:
                            focus_signal_seen_ns = ns
                            try:
                                sig = json.loads(focus_signal_path.read_text(encoding="utf-8"))
                            except Exception:
                                sig = None

                            if isinstance(sig, dict) and sig.get("action") == "focus":
                                tab_id = sig.get("tab_id")
                                if tab_id:
                                    await websocket.send_text(
                                        json.dumps({"type": "artifact_focus", "payload": sig}, ensure_ascii=False)
                                    )
                                    # Delete the one-shot signal after processing.
                                    try:
                                        focus_signal_path.unlink()
                                        # Reset so a new focus signal written within the
                                        # same filesystem timestamp resolution still fires.
                                        focus_signal_seen_ns = 0
                                    except Exception:
                                        pass
                    except FileNotFoundError:
                        focus_signal_seen_ns = 0
                        pass
                    except Exception:
                        pass

                    # Forward queued artifact bridge commands (editor collaboration, play/stop, etc.).
                    try:
                        for cmd_path in sorted(bridge_commands_dir.glob("*.json"), key=lambda p: p.name):
                            if not cmd_path.is_file():
                                continue
                            try:
                                cmd = json.loads(cmd_path.read_text(encoding="utf-8"))
                            except Exception:
                                cmd = None
                            if isinstance(cmd, dict):
                                await websocket.send_text(
                                    json.dumps({"type": "artifact_bridge_command", "payload": cmd}, ensure_ascii=False)
                                )
                            try:
                                cmd_path.unlink()
                            except Exception:
                                pass
                    except Exception:
                        pass

                    for artifact_id in sorted(previous.keys() - current.keys()):
                        await websocket.send_text(_artifact_close_payload(artifact_id))

                    changed_ids = [
                        artifact_id
                        for artifact_id, item in current.items()
                        if artifact_id not in previous or _artifact_changed(previous.get(artifact_id), item)
                    ]
                    changed_ids.sort(key=lambda artifact_id: float(current[artifact_id].get("timestamp") or 0.0))

                    for artifact_id in changed_ids:
                        await websocket.send_text(_artifact_payload(current[artifact_id]))

                    previous = current
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

        t1 = asyncio.create_task(pump_pty_to_ws())
        t2 = asyncio.create_task(pump_ws_to_pty())
        t3 = asyncio.create_task(pump_artifacts_to_ws())

        done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        t3.cancel()
        for task in pending:
            task.cancel()
        try:
            await t3
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

        # Ensure subprocess is gone and fds are closed
        p.terminate()
        p.close_fds()
        try:
            await websocket.close()
        except Exception:
            pass

    # Serve built frontend if present
    static_dir = config.static_dir
    index_html = static_dir / "index.html"
    if index_html.exists():

        @app.get("/")
        async def _spa_root():
            return FileResponse(index_html)

        @app.get("/{path:path}")
        async def _spa_any(path: str):
            candidate = static_dir / path
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index_html)

    return app
