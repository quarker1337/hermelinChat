from __future__ import annotations

import asyncio
import hmac
import json
import os
import shlex
import signal
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .auth import (
    create_session_token,
    extract_cookie_value,
    generate_secret_bytes,
    verify_session_token,
)
from .config import HermelinConfig
from .meta_db import ensure_meta_db, get_random_whisper, get_titles_map
from .pty_handler import PtyProcess
from .security import extract_client_ip, ip_allowed
from .state_reader import get_message_context, list_sessions, search_messages


def create_app(config: HermelinConfig | None = None) -> FastAPI:
    config = config or HermelinConfig()

    # Ensure meta DB exists (titles, etc.)
    try:
        ensure_meta_db(config.meta_db_path)
    except Exception:
        # Non-fatal; UI will just fall back to first message titles.
        pass

    app = FastAPI(title="hermelinChat", version="0.1.0", docs_url="/api/docs", redoc_url=None)

    # Dev-friendly; production should lock this down.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---------------------------------------------------------------------
    # Security: IP allowlist + password session cookie
    # ---------------------------------------------------------------------
    allowed_spec = (config.allowed_ips or "").strip()
    trust_xff = bool(config.trust_x_forwarded_for)

    auth_password = (config.auth_password or "").strip()
    auth_enabled = bool(auth_password)

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
        }

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

    def _read_model_list_options() -> tuple[list[dict], str]:
        env_path = (os.getenv("HERMELIN_MODEL_LIST_PATH") or "").strip()

        if env_path:
            candidates = [Path(env_path).expanduser()]
        else:
            candidates = [
                config.spawn_cwd / "hermes-agent-modellist.txt",
                Path(__file__).resolve().parent.parent / "hermes-agent-modellist.txt",
            ]

        for p in candidates:
            try:
                text = p.read_text(encoding="utf-8")
            except Exception:
                continue

            models = _parse_model_list_text(text)
            if models:
                return models, str(p)

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
    async def auth_login(payload: dict = Body(...)):
        if not auth_enabled:
            return {"ok": True, "auth_enabled": False}

        password = str(payload.get("password") or "")
        if not hmac.compare_digest(password, auth_password):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)

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
        if resume:
            argv += ["--resume", resume]
        elif cont:
            argv += ["--continue"]

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        env.setdefault("PYTHONUNBUFFERED", "1")
        env.setdefault("HERMES_HOME", str(config.hermes_home))

        p = PtyProcess.spawn(argv, cwd=config.spawn_cwd, env=env, cols=cols, rows=rows)

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
                    if msg.get("type") == "websocket.disconnect":
                        break

                    b = msg.get("bytes")
                    if b is not None:
                        if b:
                            p.write(b)
                        continue

                    t = msg.get("text")
                    if t is None:
                        continue

                    # Control frames are JSON over text.
                    # Terminal keystrokes are sent as bytes frames.
                    try:
                        payload = json.loads(t)
                    except json.JSONDecodeError:
                        p.write(t.encode("utf-8", errors="ignore"))
                        continue

                    if payload.get("type") == "resize":
                        c = int(payload.get("cols") or 0)
                        r = int(payload.get("rows") or 0)
                        if c > 0 and r > 0:
                            p.resize(cols=c, rows=r)
                        continue

                    if payload.get("type") == "signal":
                        sig = str(payload.get("sig") or "").upper()
                        if sig in {"INT", "TERM", "HUP", "QUIT"}:
                            try:
                                os.killpg(p.proc.pid, getattr(signal, f"SIG{sig}"))
                            except Exception:
                                pass
                        elif sig == "KILL":
                            p.kill()
                        continue
            except Exception:
                pass

        t1 = asyncio.create_task(pump_pty_to_ws())
        t2 = asyncio.create_task(pump_ws_to_pty())

        done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()

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
