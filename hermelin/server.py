from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import hmac
import hashlib
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
import shlex
import shutil
import signal
import ssl
import stat
import subprocess
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.parse import parse_qs, urlparse

import logging
import yaml

logger = logging.getLogger("hermelin")

_FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES = 64 << 10
_FLEET_CA_MAX_BYTES = 64 << 10
_PET_SIDECAR_SECRET_MAX_BYTES = 512
_PET_SIDECAR_ENVIRON_MAX_BYTES = 256 << 10
_PET_SIDECAR_CHANNEL_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_PET_SIDECAR_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,512}$")


def _load_or_create_pet_sidecar_secret(path: Path) -> str:
    """Load the restart-stable capability used by managed Hermes publishers."""

    secret_path = Path(path).expanduser()
    secret_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    read_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)

    def _read_existing() -> str:
        fd = os.open(secret_path, read_flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("pet sidecar secret must be a regular file")
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise PermissionError("pet sidecar secret must be owner-only")
            payload = os.read(fd, _PET_SIDECAR_SECRET_MAX_BYTES + 1)
        finally:
            os.close(fd)
        if not payload or len(payload) > _PET_SIDECAR_SECRET_MAX_BYTES:
            raise ValueError("pet sidecar secret has an invalid size")
        secret = payload.decode("ascii").strip()
        if not _PET_SIDECAR_TOKEN_RE.fullmatch(secret):
            raise ValueError("pet sidecar secret has an invalid format")
        return secret

    try:
        return _read_existing()
    except FileNotFoundError:
        pass

    secret = secrets.token_urlsafe(32)
    write_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        fd = os.open(secret_path, write_flags, 0o600)
    except FileExistsError:
        return _read_existing()
    try:
        os.write(fd, (secret + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return secret


def _pet_sidecar_token_from_process(
    pid: int | None,
    expected_channel: str,
    *,
    proc_root: Path = Path("/proc"),
) -> str | None:
    """Recover a pre-restart sidecar capability from a live managed process."""

    try:
        process_id = int(pid or 0)
    except (TypeError, ValueError):
        return None
    channel = str(expected_channel or "")
    if process_id <= 1 or not _PET_SIDECAR_CHANNEL_RE.fullmatch(channel):
        return None
    environ_path = Path(proc_root) / str(process_id) / "environ"
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(environ_path, flags)
        try:
            payload = os.read(fd, _PET_SIDECAR_ENVIRON_MAX_BYTES + 1)
        finally:
            os.close(fd)
    except (OSError, ValueError):
        return None
    if len(payload) > _PET_SIDECAR_ENVIRON_MAX_BYTES:
        return None
    prefix = b"HERMES_TUI_SIDECAR_URL="
    raw_url = next((item[len(prefix) :] for item in payload.split(b"\0") if item.startswith(prefix)), b"")
    try:
        parsed = urlparse(raw_url.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if parsed.scheme not in {"ws", "wss"} or parsed.path != "/ws/pet-events-pub":
        return None
    query = parse_qs(parsed.query, keep_blank_values=True)
    tokens = query.get("token") or []
    channels = query.get("channel") or []
    if len(tokens) != 1 or len(channels) != 1 or channels[0] != channel:
        return None
    token = str(tokens[0])
    return token if _PET_SIDECAR_TOKEN_RE.fullmatch(token) else None


def _fleet_ssl_context(ca_file: Path | None) -> ssl.SSLContext:
    if ca_file is None:
        return ssl.create_default_context()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(Path(ca_file).expanduser(), flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > _FLEET_CA_MAX_BYTES:
            raise ValueError("Fleet CA certificate must be a bounded regular file")
        if info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022:
            raise PermissionError("Fleet CA certificate must be owner-controlled and not group/world-writable")
        chunks: list[bytes] = []
        remaining = _FLEET_CA_MAX_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(4096, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    payload = b"".join(chunks)
    if not payload or len(payload) > _FLEET_CA_MAX_BYTES:
        raise ValueError("Fleet CA certificate has an invalid size")
    return ssl.create_default_context(cadata=payload.decode("ascii"))


def _fleet_runtime_attach_frame_size(message: bytes | str) -> int:
    if isinstance(message, bytes):
        return len(message)
    return len(str(message).encode("utf-8", errors="replace"))


_RELEASE_TAG_RE = re.compile(r"^(\d+(?:\.\d+)*)(.*)$")
_RELEASE_SUFFIX_RE = re.compile(r"^(?:[.\-_]?)(dev|a|alpha|b|beta|rc|c|post)(\d*)", re.IGNORECASE)
_RELEASE_SUFFIX_ORDER = {
    "dev": -1,
    "a": 0,
    "alpha": 0,
    "b": 1,
    "beta": 1,
    "rc": 2,
    "c": 2,
    "post": 4,
}
_GITHUB_COMPARE_VERSION_RE = re.compile(
    r"^\d+(?:\.\d+)*(?:[.\-_]?(?:dev|a|alpha|b|beta|rc|c|post)\d*)?$",
    re.IGNORECASE,
)
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


def _normalize_release_tag(raw: str | None) -> str:
    return (raw or "").strip().lstrip("v")


def _github_release_tag_for_version(raw: str | None) -> str | None:
    """Return the likely GitHub release tag for a package version."""
    text = _normalize_release_tag(raw).split("+", 1)[0].strip()
    if not text or not _GITHUB_COMPARE_VERSION_RE.fullmatch(text):
        return None
    return f"v{text}"


def _source_checkout_head(repo_root: Path | None = None) -> str | None:
    """Return the current git HEAD SHA when hermelinChat runs from a checkout."""
    root = repo_root or Path(__file__).resolve().parents[1]
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--verify", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    sha = (result.stdout or "").strip().splitlines()[0:1]
    if not sha:
        return None
    head = sha[0].strip().lower()
    return head if _GIT_SHA_RE.fullmatch(head) else None


def _release_sort_key(raw: str | None) -> tuple[tuple[int, ...], int, int] | None:
    text = _normalize_release_tag(raw)
    if not text:
        return None

    base = text.split("+", 1)[0].strip()
    match = _RELEASE_TAG_RE.match(base)
    if not match:
        return None

    release = tuple(int(part) for part in match.group(1).split("."))
    suffix = (match.group(2) or "").strip()
    if not suffix:
        return release, 3, 0

    suffix_match = _RELEASE_SUFFIX_RE.match(suffix)
    if not suffix_match:
        return release, 3, 0

    phase = _RELEASE_SUFFIX_ORDER.get(suffix_match.group(1).lower(), 3)
    phase_number = int(suffix_match.group(2) or 0)
    return release, phase, phase_number


def _is_update_available(current_version: str | None, latest_version: str | None) -> bool:
    current_key = _release_sort_key(current_version)
    latest_key = _release_sort_key(latest_version)
    if current_key is None or latest_key is None:
        return _normalize_release_tag(latest_version) != _normalize_release_tag(current_version)
    return latest_key > current_key

import httpx
import websockets
from urllib.parse import quote, urlparse

from fastapi import Body, FastAPI, Query, Request, WebSocket, WebSocketDisconnect
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
    rename_artifact_title,
)
from .auth import (
    create_runner_token,
    create_session_token,
    extract_cookie_value,
    extract_session_exp,
    extract_session_jti,
    generate_secret_bytes,
    verify_login_password,
    verify_runner_token,
    verify_session_token,
)
from .config import DEFAULT_HERMELIN_HERMES_CMD, HermelinConfig
from .default_artifacts import list_default_artifact_settings, resolve_default_artifact_path
from .hermes_dashboard import DASHBOARD_RUNNER_ID, HermesDashboardManager
from .dashboard_proxy import create_dashboard_manager, register_hermes_dashboard_routes
from .fleet_proxy import (
    FLEET_API_PREFIX,
    FLEET_DISABLED_PAYLOAD,
    FLEET_UNAVAILABLE_PAYLOAD,
    fleet_bridge_token,
    register_fleet_routes,
    resolve_fleet_settings,
)
from .meta_db import (
    delete_title,
    ensure_meta_db,
    get_random_whisper,
    get_titles_map,
    upsert_title,
)
from .pty_handler import PtyProcess
from . import __version__
from .security import extract_client_ip, ip_allowed, parse_allowlist
from .state_reader import (
    get_message_context,
    get_session_title,
    is_valid_session_id,
    list_sessions,
    resolve_resume_session_id,
    search_messages,
)
from .config_editor import (
    _yaml_inline_scalar,
    _update_display_skin_config_text,
    _update_nested_bool_flag_config_text,
    _update_default_artifact_flag_config_text,
    _update_hermelin_launch_mode_config_text,
    _update_platform_toolset_enabled_config_text,
    _set_command_toolset_enabled,
)
from .runners import discover_runner_upstream
from .runtime_backends import (
    LegacyRuntimeBackend,
    RuntimeBackendError,
    RuntimeCreateRequest,
    TmuxRuntimeBackend,
    select_runtime_backend,
)
from .runtime_registry import RuntimeRecord, RuntimeRegistry, new_runtime_id, utc_ts
from .ws_writer import WebSocketPriorityWriter


def _update_env_var_text(text: str, key: str, value: str) -> tuple[str, bool]:
    raw = text or ""
    key = str(key or "").strip()
    if not key:
        return raw, False

    newline = "\r\n" if "\r\n" in raw else "\n"
    had_trailing_newline = raw.endswith(("\n", "\r"))
    lines = raw.splitlines()
    rendered = json.dumps(str(value), ensure_ascii=False)
    key_re = re.escape(key)

    for idx, line in enumerate(lines):
        if not re.match(rf"^{key_re}=", line):
            continue
        updated = f"{key}={rendered}"
        if updated == line:
            return raw, False
        next_lines = list(lines)
        next_lines[idx] = updated
        out = newline.join(next_lines)
        if next_lines and had_trailing_newline:
            out += newline
        return out, True

    next_lines = list(lines)
    if next_lines and next_lines[-1].strip():
        next_lines.append("")
    next_lines.append(f"{key}={rendered}")
    out = newline.join(next_lines)
    if next_lines and (had_trailing_newline or not raw):
        out += newline
    return out, True


_DEFAULT_CLASSIC_HERMES_TOOLSETS = ("hermes-cli", "artifacts")
_DEFAULT_HERMELIN_HERMES_CMD = DEFAULT_HERMELIN_HERMES_CMD


def _normalize_hermes_launch_mode(value: object) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in {"chat", "tui"} else "chat"


def _build_hermes_command_for_launch_mode(
    mode: object,
    *,
    strudel_enabled: bool = False,
    hermes_executable: str = "hermes",
) -> str:
    normalized = _normalize_hermes_launch_mode(mode)
    executable = shlex.quote(str(hermes_executable or "hermes").strip() or "hermes")
    if normalized == "tui":
        return f"{executable} chat --tui"

    toolsets = list(_DEFAULT_CLASSIC_HERMES_TOOLSETS)
    if strudel_enabled and "strudel" not in toolsets:
        toolsets.append("strudel")
    return f'{executable} chat --toolsets "{", ".join(toolsets)}"'


def _managed_hermes_executable(command: str) -> str:
    if not _is_managed_hermes_command(command):
        return "hermes"
    try:
        argv = shlex.split(str(command or "").strip())
    except Exception:
        return "hermes"
    if argv and Path(argv[0]).name == "hermes":
        return argv[0]
    return "hermes"


_HERMES_PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def _safe_hermes_profile_name(value: object) -> str:
    text = str(value or "default").strip() or "default"
    if text == "default":
        return "default"
    if not _HERMES_PROFILE_NAME_RE.fullmatch(text):
        return ""
    if text in {".", ".."} or ".." in text:
        return ""
    return text


def _hermes_profile_config_path(hermes_home: Path, profile: str) -> Path:
    name = _safe_hermes_profile_name(profile) or "default"
    base = Path(hermes_home).expanduser()
    if name == "default":
        return base / "config.yaml"
    return base / "profiles" / name / "config.yaml"


def _hermes_profile_state_db_path(hermes_home: Path, profile: str) -> Path:
    name = _safe_hermes_profile_name(profile)
    if not name:
        raise ValueError("invalid Hermes profile")
    base = Path(hermes_home).expanduser()
    if name == "default":
        return base / "state.db"
    return base / "profiles" / name / "state.db"


def _hermes_profile_model(config_path: Path) -> str | None:
    try:
        raw = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    model_section = raw.get("model")
    if isinstance(model_section, dict):
        for key in ("default", "model"):
            value = model_section.get(key)
            if value:
                return str(value)
    for dotted in ("model.default", "model.model"):
        value = raw.get(dotted)
        if value:
            return str(value)
    return None


def _list_hermes_profiles(hermes_home: Path) -> list[dict[str, object]]:
    base = Path(hermes_home).expanduser()
    profiles: list[dict[str, object]] = []

    def add(name: str) -> None:
        safe = _safe_hermes_profile_name(name)
        if not safe or any(item.get("name") == safe for item in profiles):
            return
        config_path = _hermes_profile_config_path(base, safe)
        model = _hermes_profile_model(config_path)
        profiles.append(
            {
                "name": safe,
                "label": safe,
                "is_default": safe == "default",
                "configured": config_path.exists(),
                "model": model,
            }
        )

    add("default")
    profiles_dir = base / "profiles"
    try:
        entries = sorted(profiles_dir.iterdir(), key=lambda p: p.name.lower()) if profiles_dir.is_dir() else []
    except Exception:
        entries = []
    for entry in entries:
        if entry.is_dir() and not entry.is_symlink():
            add(entry.name)
    return profiles


def _with_hermes_profile_args(argv: list[str], profile: str) -> list[str]:
    safe = _safe_hermes_profile_name(profile)
    if not safe or safe == "default":
        return list(argv)
    if not argv:
        return list(argv)
    try:
        exe_name = Path(argv[0]).name.lower()
    except Exception:
        exe_name = ""
    if "hermes" not in exe_name:
        raise ValueError("profile selection requires a Hermes command")

    cleaned: list[str] = []
    skip_next = False
    for arg in argv:
        if skip_next:
            skip_next = False
            continue
        if arg in {"-p", "--profile"}:
            skip_next = True
            continue
        if arg.startswith("--profile="):
            continue
        cleaned.append(arg)
    return [*cleaned, "--profile", safe]


def _resolve_hermes_executable(executable: str, env: Mapping[str, str] | None = None) -> str:
    """Resolve the Hermes binary for subprocess launches.

    systemd/user services often start with a minimal PATH that omits
    ~/.local/bin, which is where the Hermes installer puts the `hermes` shim.
    Keep config display values readable (`hermes chat ...`) but resolve the
    executable at launch time so PTY sessions don't fail with FileNotFoundError.
    """
    raw = str(executable or "hermes").strip() or "hermes"
    expanded = os.path.expanduser(raw)
    if os.path.isabs(expanded) or os.sep in expanded:
        return expanded

    found = shutil.which(raw, path=(env or {}).get("PATH"))
    if found:
        return found

    for base in (Path.home() / ".local" / "bin", Path.home() / ".hermes" / "bin"):
        candidate = base / raw
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except Exception:
            pass

    return raw


def _is_managed_hermes_command(command: str) -> bool:
    """Return true for Hermelin-generated classic commands, not custom overrides."""
    cmd = str(command or "").strip()
    if not cmd:
        return False
    try:
        argv = shlex.split(cmd)
    except Exception:
        return False
    if len(argv) not in {3, 4}:
        return False
    if len(argv) < 2 or Path(argv[0]).name != "hermes" or argv[1] != "chat":
        return False

    toolsets_raw = None
    if len(argv) == 4 and argv[2] == "--toolsets":
        toolsets_raw = argv[3]
    elif len(argv) == 3 and argv[2].startswith("--toolsets="):
        toolsets_raw = argv[2].split("=", 1)[1]
    if toolsets_raw is None:
        return False

    items = [part.strip() for part in toolsets_raw.split(",") if part.strip()]
    return items in [
        list(_DEFAULT_CLASSIC_HERMES_TOOLSETS),
        [*_DEFAULT_CLASSIC_HERMES_TOOLSETS, "strudel"],
    ]


def _repair_malformed_managed_hermes_command(command: str) -> str:
    """Repair only Hermelin-managed Hermes command strings with broken quoting.

    Runtime creation uses ``shlex.split()`` on the effective Hermes command. A
    persisted/env-managed command with a missing quote should not be treated as a
    custom override and break `+ new runtime`; normalize that narrow shape to a
    quote-free ``--toolsets=...`` form. Leave real custom commands untouched.
    """
    cmd = str(command or "").strip()
    if not cmd:
        return cmd
    try:
        shlex.split(cmd)
        return cmd
    except ValueError:
        pass

    parts = cmd.split()
    if (
        len(parts) >= 3
        and Path(parts[0]).name == "hermes"
        and parts[1] == "chat"
        and (parts[2] == "--toolsets" or parts[2].startswith("--toolsets="))
    ):
        toolsets = "hermes-cli,artifacts,strudel" if "strudel" in cmd else "hermes-cli,artifacts"
        return f"{parts[0]} chat --toolsets={toolsets}"
    return cmd


_CONFIG_VALUE_MISSING = object()


def _get_config_value(raw: dict, path: tuple[str, ...], default: object = None) -> object:
    """Read nested config values while accepting Hermes-style dotted keys."""
    if not isinstance(raw, dict):
        return default

    node: object = raw
    for key in path:
        if not isinstance(node, dict) or key not in node:
            node = _CONFIG_VALUE_MISSING
            break
        node = node[key]
    if node is not _CONFIG_VALUE_MISSING:
        return node

    dotted = ".".join(path)
    return raw.get(dotted, default)


def _hermelin_toolset_enabled(raw: dict, toolset: str) -> bool:
    value = _get_config_value(raw, ("hermelin", "toolsets", toolset), None)
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_flag_default(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip()
    if raw == "":
        return default
    return raw.lower() in {"1", "true", "yes", "y", "on"}


def _path_is_or_under(path: str, prefix: str) -> bool:
    normalized_path = str(path or "").rstrip("/") or "/"
    normalized_prefix = str(prefix or "").rstrip("/") or "/"
    return normalized_path == normalized_prefix or normalized_path.startswith(f"{normalized_prefix}/")


_RUNNER_PROXY_FRAME_PATH_RE = re.compile(r"^/r/[A-Za-z0-9._-]+/_t/[^/]+(?:/.*)?$")


def _is_runner_proxy_frame_path(path: str) -> bool:
    """Return true only for token-bearing runner proxy paths that iframes load."""
    return bool(_RUNNER_PROXY_FRAME_PATH_RE.fullmatch(str(path or "")))


def _deep_merge_dict(base: dict, overlay: dict) -> dict:
    """Return a recursive merge where overlay wins at leaves."""
    out = dict(base or {})
    for key, value in (overlay or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge_dict(out[key], value)
        else:
            out[key] = value
    return out


def _safe_read_yaml(path: Path) -> dict:
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


_PET_STATE_ROWS = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
]


def _mime_for_pet_sheet(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".png":
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".gif":
        return "image/gif"
    return "image/webp"


def _resolve_installed_pet_dir(pets_dir: Path, configured_slug: str) -> Path | None:
    slug = str(configured_slug or "").strip()
    candidates: list[Path] = []
    if slug:
        candidates.append(pets_dir / slug)
    try:
        candidates.extend(sorted(p for p in pets_dir.iterdir() if p.is_dir()))
    except Exception:
        pass

    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            root = pets_dir.resolve()
        except Exception:
            continue
        if root != resolved and root not in resolved.parents:
            continue
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        if (resolved / "pet.json").is_file():
            return resolved
    return None


def _read_pet_meta(pet_dir: Path) -> dict:
    try:
        meta = json.loads((pet_dir / "pet.json").read_text(encoding="utf-8"))
        return meta if isinstance(meta, dict) else {}
    except Exception:
        return {}


def _installed_pet_summaries(pets_dir: Path) -> list[dict]:
    out: list[dict] = []
    try:
        dirs = sorted((p for p in pets_dir.iterdir() if p.is_dir()), key=lambda p: p.name.lower())
    except Exception:
        return out
    for pet_dir in dirs:
        meta = _read_pet_meta(pet_dir)
        if not meta and not (pet_dir / "pet.json").is_file():
            continue
        slug = str(meta.get("id") or pet_dir.name)
        out.append(
            {
                "slug": slug,
                "displayName": str(meta.get("displayName") or slug),
                "description": str(meta.get("description") or ""),
            }
        )
    return out


def _pet_overlay_info(config: HermelinConfig, slug_override: str | None = None) -> dict:
    """Return a browser-canvas-friendly payload for an installed pet.

    By default this follows Hermes' configured active pet. Passing slug_override
    lets the HermelinChat browser overlay choose a local pet without mutating the
    user's Hermes config.
    """
    cfg = _safe_read_yaml(config.hermes_home / "config.yaml")
    display = cfg.get("display", {}) if isinstance(cfg.get("display"), dict) else {}
    pet_cfg = display.get("pet", {}) if isinstance(display.get("pet"), dict) else {}
    terminal_enabled = bool(pet_cfg.get("enabled"))
    configured_slug = str(pet_cfg.get("slug", "") or "")
    requested_slug = str(slug_override or "").strip()
    source = "override" if requested_slug else "configured"
    try:
        scale = float(pet_cfg.get("scale", 0.33) or 0.33)
    except (TypeError, ValueError):
        scale = 0.33
    scale = max(0.1, min(3.0, scale))

    pets_dir = config.hermes_home / "pets"
    installed = _installed_pet_summaries(pets_dir)

    # `display.pet.enabled` controls Hermes' terminal-rendered pet. HermelinChat
    # draws its own browser/canvas overlay and has a separate browser-local
    # visibility toggle, so a configured slug should still resolve here even
    # when the terminal pet is disabled. This lets users keep terminal sessions
    # clean while preserving their HermelinChat companion.
    if not requested_slug and not configured_slug:
        return {
            "enabled": False,
            "terminalEnabled": False,
            "slug": configured_slug or None,
            "configuredSlug": configured_slug or None,
            "source": source,
            "installedPets": installed,
        }

    pet_dir = _resolve_installed_pet_dir(pets_dir, requested_slug or configured_slug)
    if pet_dir is None:
        return {
            "enabled": False,
            "terminalEnabled": terminal_enabled,
            "slug": (requested_slug or configured_slug) or None,
            "configuredSlug": configured_slug or None,
            "source": source,
            "installedPets": installed,
        }

    meta = _read_pet_meta(pet_dir)

    sheet_name = str(meta.get("spritesheetPath") or "spritesheet.webp")
    try:
        sheet = (pet_dir / sheet_name).resolve()
        root = pet_dir.resolve()
    except Exception:
        return {"enabled": False, "terminalEnabled": terminal_enabled, "slug": configured_slug or None, "configuredSlug": configured_slug or None, "source": source, "installedPets": installed}
    if root != sheet.parent and root not in sheet.parents:
        return {"enabled": False, "terminalEnabled": terminal_enabled, "slug": configured_slug or None, "configuredSlug": configured_slug or None, "source": source, "installedPets": installed}
    if not sheet.is_file():
        return {"enabled": False, "terminalEnabled": terminal_enabled, "slug": configured_slug or None, "configuredSlug": configured_slug or None, "source": source, "installedPets": installed}

    try:
        raw = sheet.read_bytes()
        stat = sheet.stat()
    except Exception:
        return {"enabled": False, "terminalEnabled": terminal_enabled, "slug": configured_slug or None, "configuredSlug": configured_slug or None, "source": source, "installedPets": installed}

    slug = str(meta.get("id") or pet_dir.name)
    return {
        "enabled": True,
        "terminalEnabled": terminal_enabled,
        "slug": slug,
        "configuredSlug": configured_slug or None,
        "source": source,
        "displayName": str(meta.get("displayName") or slug),
        "description": str(meta.get("description") or ""),
        "mime": _mime_for_pet_sheet(sheet),
        "spritesheetBase64": base64.standard_b64encode(raw).decode("ascii"),
        "spritesheetRevision": f"{int(stat.st_mtime_ns)}:{stat.st_size}",
        "frameW": 192,
        "frameH": 208,
        "framesPerState": 6,
        "loopMs": 1100,
        "scale": scale,
        "stateRows": list(_PET_STATE_ROWS),
        "installedPets": installed,
    }


def _prepare_pty_managed_scope(config: HermelinConfig, parent_env: dict[str, str]) -> Path | None:
    """Create a child-only Hermes managed-scope overlay that disables PTY pets.

    HermelinChat renders the pet as a real browser canvas. The Hermes subprocess
    running inside xterm should not also draw the Unicode half-block pet. Using
    HERMES_MANAGED_DIR is per-child and leaves the user's config.yaml untouched.
    If an existing managed scope is present, copy/merge it so deployment policy
    is preserved before adding the pet-disable leaf.
    """
    managed_dir = config.hermes_home / "hermelin" / "pty-managed-scope"
    try:
        managed_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        logger.warning("failed to create Hermelin managed scope at %s", managed_dir, exc_info=True)
        return None

    base_config: dict = {}
    inherited = str(parent_env.get("HERMES_MANAGED_DIR") or "").strip()
    inherited_dir = Path(inherited).expanduser() if inherited else None
    if inherited_dir and inherited_dir.is_dir():
        base_config = _safe_read_yaml(inherited_dir / "config.yaml")
        try:
            inherited_env = inherited_dir / ".env"
            if inherited_env.is_file():
                (managed_dir / ".env").write_text(inherited_env.read_text(encoding="utf-8"), encoding="utf-8")
        except Exception:
            logger.debug("failed to copy inherited Hermes managed .env", exc_info=True)

    next_config = _deep_merge_dict(base_config, {"display": {"pet": {"enabled": False}}})
    try:
        (managed_dir / "config.yaml").write_text(yaml.safe_dump(next_config, sort_keys=False), encoding="utf-8")
    except Exception:
        logger.warning("failed to write Hermelin managed scope config at %s", managed_dir, exc_info=True)
        return None
    return managed_dir


def create_app(config: HermelinConfig | None = None) -> FastAPI:
    config = config or HermelinConfig()
    fleet_settings = resolve_fleet_settings(config, warn_legacy=True)
    env_hermes_cmd = _repair_malformed_managed_hermes_command(os.getenv("HERMELIN_HERMES_CMD", ""))
    env_cmd_override = _env_flag("HERMELIN_HERMES_CMD_OVERRIDE")
    config_hermes_cmd = _repair_malformed_managed_hermes_command(str(config.hermes_cmd or ""))
    config_explicit_override = bool(getattr(config, "hermes_cmd_override", False))
    env_hermes_cmd_override = bool(env_hermes_cmd) and (env_cmd_override or not _is_managed_hermes_command(env_hermes_cmd))
    config_custom_override = bool(config_hermes_cmd) and not _is_managed_hermes_command(config_hermes_cmd)
    initial_hermes_cmd = config_hermes_cmd if config_explicit_override or not env_hermes_cmd_override else env_hermes_cmd
    hermes_cmd_runtime = [initial_hermes_cmd]
    hermes_cmd_override_runtime = [
        config_explicit_override or env_hermes_cmd_override or config_custom_override
    ]
    pet_sidecar_secret = _load_or_create_pet_sidecar_secret(
        config.hermes_home / "hermelin" / "pet-sidecar.secret"
    )
    pet_sidecar_channel_re = _PET_SIDECAR_CHANNEL_RE

    def _get_hermes_cmd() -> str:
        return str(hermes_cmd_runtime[0] or "").strip()

    def _set_hermes_cmd(value: str) -> None:
        hermes_cmd_runtime[0] = str(value or "").strip()

    def _has_hermes_cmd_override() -> bool:
        return bool(hermes_cmd_override_runtime[0])

    def _resolve_hermelin_env_file() -> Path | None:
        raw = os.getenv("HERMELIN_ENV_FILE", "").strip()
        if raw:
            return Path(raw).expanduser()

        cwd_candidate = Path.cwd() / ".hermelin.env"
        if cwd_candidate.exists():
            return cwd_candidate

        try:
            repo_candidate = Path(__file__).resolve().parents[1] / ".hermelin.env"
            if repo_candidate.exists():
                return repo_candidate
        except Exception:
            pass

        return None

    if hermes_cmd_runtime[0] == "":
        hermes_cmd_runtime[0] = config.hermes_cmd

    # Ensure meta DB exists (titles, etc.)
    try:
        ensure_meta_db(config.meta_db_path)
    except Exception:
        # Non-fatal; UI will just fall back to first message titles.
        logger.warning("failed to initialize meta DB at %s", config.meta_db_path, exc_info=True)
        pass

    dashboard_manager, dashboard_base_path = create_dashboard_manager(
        config,
        hermes_command=_managed_hermes_executable(_get_hermes_cmd()),
        manager_cls=HermesDashboardManager,
    )

    @asynccontextmanager
    async def _lifespan(app):
        app.state.httpx_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=60.0, pool=5.0),
            follow_redirects=False,
        )
        fleet_http_client = None
        fleet_ssl_context: ssl.SSLContext | None = None
        if fleet_settings.available:
            fleet_ca_file = getattr(config, "fleet_ca_file", None)
            if fleet_settings.base_url.startswith("https://") or fleet_ca_file is not None:
                fleet_ssl_context = _fleet_ssl_context(fleet_ca_file)
            fleet_verify: bool | ssl.SSLContext = fleet_ssl_context or True
            fleet_http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    max(1.0, min(float(getattr(config, "fleet_timeout_seconds", 10.0) or 10.0), 120.0))
                ),
                follow_redirects=False,
                trust_env=False,
                verify=fleet_verify,
            )
            app.state.fleet_http_client = fleet_http_client
        app.state.fleet_ssl_context = fleet_ssl_context
        app.state.fleet_settings = fleet_settings
        app.state.hermes_dashboard_manager = dashboard_manager
        app.state.pet_event_channels = {}
        app.state.pet_event_last_events = {}
        app.state.pet_event_activity = {}
        app.state.pet_event_lock = asyncio.Lock()
        try:
            yield
        finally:
            if fleet_http_client is not None:
                await fleet_http_client.aclose()
            await app.state.httpx_client.aclose()
            await dashboard_manager.aclose()

    app = FastAPI(title="hermelinChat", version=__version__, docs_url="/api/docs", redoc_url=None, lifespan=_lifespan)
    # CORS: disabled by default (same-origin UI does not need it).
    # To enable (e.g. behind a separate UI origin), set HERMELIN_CORS_ORIGINS to a
    # comma-separated list of origins. Wildcard '*' is intentionally not supported.
    cors_origins = [o.strip() for o in (getattr(config, 'cors_origins', '') or '').split(',') if o.strip() and o.strip() != '*']
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["Content-Type"],
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
    _revoked_jtis: dict[str, float] = {}
    _rotated_jtis: dict[str, tuple[str, float, float]] = {}
    _rotation_grace_seconds = 10.0

    cookie_name = (config.cookie_name or "hermelin_session").strip() or "hermelin_session"
    ttl_seconds = int(config.session_ttl_seconds or 0) or 43200
    cookie_secure = bool(config.cookie_secure)

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

    def _remember_revoked_jti(
        jti: str | None,
        *,
        token: str | None = None,
        expires_at: float | None = None,
        now: float | None = None,
    ) -> None:
        if not jti:
            return
        t = time.time() if now is None else now
        token_exp = extract_session_exp(token=token, secret=cookie_secret) if token else None
        deadline = max(float(token_exp or 0), float(expires_at or 0), t)
        if deadline <= t:
            deadline = t + max(ttl_seconds, 1)
        _revoked_jtis[jti] = deadline

    def _prune_revoked_jtis(now: float | None = None) -> None:
        t = time.time() if now is None else now
        expired = [jti for jti, deadline in _revoked_jtis.items() if deadline <= t]
        for jti in expired:
            _revoked_jtis.pop(jti, None)

    def _prune_rotated_jtis(now: float | None = None) -> None:
        t = time.monotonic() if now is None else now
        expired = [jti for jti, (_, deadline, _) in _rotated_jtis.items() if deadline <= t]
        for jti in expired:
            _, _, old_exp = _rotated_jtis[jti]
            _remember_revoked_jti(jti, expires_at=old_exp)
            _rotated_jtis.pop(jti, None)

    cookie_secret_raw = (config.cookie_secret or "").strip()
    cookie_secret = cookie_secret_raw.encode("utf-8") if cookie_secret_raw else generate_secret_bytes()

    _parsed_allowlist = parse_allowlist(allowed_spec)

    def _check_allowed(client_ip: str) -> bool:
        if allowed_spec == "*":
            return True
        return ip_allowed(client_ip, allowed_spec, _nets=_parsed_allowlist)

    def _is_authenticated(token: str | None) -> bool:
        if not auth_enabled:
            return True
        if not token:
            return False
        _prune_revoked_jtis()
        _prune_rotated_jtis()
        if not verify_session_token(token=token, secret=cookie_secret, revoked_jtis=_revoked_jtis):
            return False
        jti = extract_session_jti(token=token, secret=cookie_secret)
        if jti and jti in _rotated_jtis:
            return _rotated_jtis[jti][1] > time.monotonic()
        return True

    def _set_session_cookie(response: Response) -> str:
        token = create_session_token(secret=cookie_secret, ttl_seconds=ttl_seconds)
        response.set_cookie(
            key=cookie_name,
            value=token,
            max_age=ttl_seconds,
            httponly=True,
            secure=cookie_secure,
            samesite="strict",
            path="/",
        )
        return token

    def _renew_session_cookie(response: Response, token: str) -> None:
        old_jti = extract_session_jti(token=token, secret=cookie_secret)
        if not old_jti:
            return
        if old_jti in _rotated_jtis:
            return
        renewed_token = _set_session_cookie(response)
        new_jti = extract_session_jti(token=renewed_token, secret=cookie_secret)
        if new_jti:
            _prune_rotated_jtis()
            old_exp = float(extract_session_exp(token=token, secret=cookie_secret) or 0)
            _rotated_jtis[old_jti] = (new_jti, time.monotonic() + _rotation_grace_seconds, old_exp)

    def _revoke_session_jti(jti: str | None, *, token: str | None = None) -> None:
        if not jti:
            return
        to_revoke = [jti]
        while to_revoke:
            current = to_revoke.pop()
            if current in _revoked_jtis:
                continue
            _remember_revoked_jti(current, token=token if current == jti else None)
            linked = [
                (old_jti, new_jti, old_exp)
                for old_jti, (new_jti, _, old_exp) in _rotated_jtis.items()
                if old_jti == current or new_jti == current
            ]
            for old_jti, new_jti, old_exp in linked:
                _rotated_jtis.pop(old_jti, None)
                if old_jti == current:
                    _remember_revoked_jti(old_jti, expires_at=old_exp)
                if old_jti not in _revoked_jtis:
                    to_revoke.append(old_jti)
                if new_jti not in _revoked_jtis:
                    to_revoke.append(new_jti)

    def _delete_session_cookie(response: Response) -> None:
        response.set_cookie(
            key=cookie_name,
            value="",
            max_age=0,
            httponly=True,
            secure=cookie_secure,
            samesite="strict",
            path="/",
        )

    def _pet_event_state() -> tuple[dict[str, set[asyncio.Queue[str]]], dict[str, str], asyncio.Lock]:
        channels = getattr(app.state, "pet_event_channels", None)
        last_events = getattr(app.state, "pet_event_last_events", None)
        lock = getattr(app.state, "pet_event_lock", None)
        if channels is None:
            channels = {}
            app.state.pet_event_channels = channels
        if last_events is None:
            last_events = {}
            app.state.pet_event_last_events = last_events
        if lock is None:
            lock = asyncio.Lock()
            app.state.pet_event_lock = lock
        return channels, last_events, lock

    def _pet_activity_state() -> dict[str, str]:
        activity = getattr(app.state, "pet_event_activity", None)
        if not isinstance(activity, dict):
            activity = {}
            app.state.pet_event_activity = activity
        return activity

    def _pet_event_type(payload: str) -> str:
        try:
            obj = json.loads(payload)
        except Exception:
            return ""
        if not isinstance(obj, dict):
            return ""
        event = obj.get("payload")
        if isinstance(event, dict):
            return str(event.get("type") or "").strip()
        return ""

    def _cacheable_pet_event_type(event_type: str) -> bool:
        # Replay only steady states for a runtime/session. Terminal flash events
        # like `message.complete` and `error` are delivered to currently attached
        # browsers but should not make Pepe wave/fail when the user switches back
        # to an already-idle session later.
        return event_type not in {"message.complete", "error"}

    async def _broadcast_pet_event(channel: str, payload: str) -> None:
        channels, last_events, lock = _pet_event_state()
        activity = _pet_activity_state()
        event_type = _pet_event_type(payload)
        async with lock:
            if event_type in {"message.complete", "error"}:
                activity[channel] = "idle"
            elif event_type in {
                "message.start",
                "thinking.delta",
                "reasoning.delta",
                "reasoning.available",
                "tool.start",
                "tool.complete",
                "message.delta",
                "clarify.request",
                "approval.request",
                "sudo.request",
                "secret.request",
            }:
                activity[channel] = "working"
            while len(activity) > 256:
                try:
                    activity.pop(next(iter(activity)))
                except Exception:
                    break
            if _cacheable_pet_event_type(event_type):
                last_events[channel] = payload
                # Bound memory even if old runtimes never reconnect.
                while len(last_events) > 256:
                    try:
                        last_events.pop(next(iter(last_events)))
                    except Exception:
                        break
            else:
                last_events.pop(channel, None)
            queues = list(channels.get(channel, ()))
        for queue in queues:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    _ = queue.get_nowait()
                except Exception:
                    pass
                try:
                    queue.put_nowait(payload)
                except Exception:
                    pass

    async def _last_pet_event(channel: str) -> str | None:
        _, last_events, lock = _pet_event_state()
        async with lock:
            value = last_events.get(channel)
        return value if isinstance(value, str) and value else None

    def _pet_sidecar_tls_enabled() -> bool:
        return bool(str(config.ssl_certfile or "").strip() and str(config.ssl_keyfile or "").strip())

    def _configured_pet_sidecar_host() -> str | None:
        host = str(getattr(config, "pet_sidecar_host", "") or "").strip()
        return host.strip("[]") if host else None

    def _default_pet_sidecar_host() -> str:
        host = str(getattr(config, "host", "") or "").strip()
        if not host or host in {"0.0.0.0", "::", "[::]"}:
            return "127.0.0.1"
        return host.strip("[]")

    def _tls_cert_identities() -> list[tuple[str, str]]:
        if not _pet_sidecar_tls_enabled():
            return []
        cert_path = str(config.ssl_certfile or "").strip()
        if not cert_path:
            return []
        try:
            decoded = ssl._ssl._test_decode_cert(str(Path(cert_path).expanduser()))  # type: ignore[attr-defined]
        except Exception:
            return []

        identities: list[tuple[str, str]] = []
        subject_alt_names = decoded.get("subjectAltName", ()) or ()
        for kind, value in subject_alt_names:
            normalized_kind = str(kind or "").strip().lower()
            normalized_value = str(value or "").strip()
            if not normalized_value:
                continue
            if normalized_kind == "dns":
                identities.append(("dns", normalized_value))
            elif normalized_kind == "ip address":
                identities.append(("ip", normalized_value.strip("[]")))

        if subject_alt_names:
            return identities

        for rdn in decoded.get("subject", ()) or ():
            for key, value in rdn:
                if str(key).lower() == "commonname":
                    normalized_value = str(value or "").strip()
                    if normalized_value:
                        identities.append(("dns", normalized_value))
        return identities

    def _host_matches_cert_identity(host: str, identities: list[tuple[str, str]]) -> bool:
        normalized_host = str(host or "").strip().strip("[]")
        if not normalized_host:
            return False
        host_lower = normalized_host.lower()
        for kind, value in identities:
            normalized_value = value.strip().strip("[]")
            if kind == "ip" and normalized_host == normalized_value:
                return True
            if kind == "dns" and _dns_identity_matches_hostname(host_lower, normalized_value.lower()):
                return True
        return False

    def _dns_identity_matches_hostname(host: str, pattern: str) -> bool:
        host = str(host or "").strip().rstrip(".").lower()
        pattern = str(pattern or "").strip().rstrip(".").lower()
        if not host or not pattern:
            return False
        if "*" not in pattern:
            return host == pattern

        pattern_labels = pattern.split(".")
        host_labels = host.split(".")
        if pattern_labels[0] != "*" or len(pattern_labels) != len(host_labels):
            return False
        if len(pattern_labels) < 3:
            return False
        return host_labels[1:] == pattern_labels[1:]

    def _pet_sidecar_host_from_tls_cert() -> str | None:
        identities = _tls_cert_identities()
        if not identities:
            return None

        default_host = _default_pet_sidecar_host()
        if _host_matches_cert_identity(default_host, identities):
            return default_host

        for kind, value in identities:
            if kind == "ip" and value in {"127.0.0.1", "::1"}:
                return value
        for kind, value in identities:
            if kind == "dns" and value.lower() == "localhost":
                return value
        for kind, value in identities:
            if kind == "dns" and "*" not in value:
                return value
        for kind, value in identities:
            if kind == "ip":
                return value
        return None

    def _pet_sidecar_host() -> str:
        configured_host = _configured_pet_sidecar_host()
        if configured_host:
            return configured_host
        if _pet_sidecar_tls_enabled():
            tls_host = _pet_sidecar_host_from_tls_cert()
            if tls_host:
                return tls_host
        return _default_pet_sidecar_host()

    def _build_pet_sidecar_url(channel: str) -> str | None:
        if not pet_sidecar_channel_re.match(channel):
            return None
        port = int(getattr(config, "port", 0) or 0)
        if port <= 0:
            return None
        host = _pet_sidecar_host()
        netloc = f"[{host}]:{port}" if ":" in host and not host.startswith("[") else f"{host}:{port}"
        scheme = "wss" if _pet_sidecar_tls_enabled() else "ws"
        from urllib.parse import urlencode
        return f"{scheme}://{netloc}/ws/pet-events-pub?{urlencode({'token': pet_sidecar_secret, 'channel': channel})}"

    def _candidate_ca_files(env: Mapping[str, str]) -> list[Path]:
        candidates: list[Path] = []
        raw_env_ca = str(env.get("SSL_CERT_FILE") or "").strip()
        if raw_env_ca:
            candidates.append(Path(raw_env_ca).expanduser())
        try:
            import certifi  # type: ignore

            candidates.append(Path(certifi.where()).expanduser())
        except Exception:
            pass
        try:
            default_cafile = ssl.get_default_verify_paths().cafile
            if default_cafile:
                candidates.append(Path(default_cafile).expanduser())
        except Exception:
            pass
        return candidates

    def _prepare_pet_sidecar_tls_env(env: dict[str, str]) -> None:
        """Let the child TUI sidecar connect back to built-in HTTPS.

        HermelinChat can serve the browser over uvicorn's built-in TLS. In that
        mode the Hermes child process must publish pet events over `wss://`, but
        local installs usually use a self-signed certificate. Build a child-only
        CA bundle that preserves the normal trust roots and appends Hermelin's
        local cert; otherwise setting SSL_CERT_FILE to only the self-signed cert
        would break Hermes' outbound HTTPS calls.
        """
        if not _pet_sidecar_tls_enabled():
            return

        cert_path = Path(str(config.ssl_certfile)).expanduser()
        try:
            cert_text = cert_path.read_text(encoding="utf-8")
        except Exception:
            logger.debug("pet sidecar TLS cert is not readable: %s", cert_path, exc_info=True)
            return
        if "BEGIN CERTIFICATE" not in cert_text:
            return

        parts: list[str] = []
        seen: set[Path] = set()
        try:
            resolved_cert_path = cert_path.resolve()
        except Exception:
            resolved_cert_path = cert_path
        for ca_path in _candidate_ca_files(env):
            try:
                resolved = ca_path.resolve()
            except Exception:
                resolved = ca_path
            if resolved in seen or resolved == resolved_cert_path:
                continue
            seen.add(resolved)
            try:
                text = ca_path.read_text(encoding="utf-8")
            except Exception:
                continue
            if "BEGIN CERTIFICATE" in text:
                parts.append(text.rstrip())

        parts.append(cert_text.rstrip())
        bundle_path = config.hermes_home / "hermelin" / "pet-sidecar-ca-bundle.pem"
        try:
            bundle_path.parent.mkdir(parents=True, exist_ok=True)
            bundle_path.write_text("\n".join(parts) + "\n", encoding="utf-8")
            env["SSL_CERT_FILE"] = str(bundle_path)
        except Exception:
            logger.debug("failed to write pet sidecar CA bundle at %s", bundle_path, exc_info=True)

    def _command_supports_pet_sidecar(argv: list[str]) -> bool:
        return any(part == "--tui" for part in argv)

    def _new_pet_event_channel() -> str:
        return secrets.token_urlsafe(18)

    def _normalise_pet_event_frame(raw: str) -> str | None:
        try:
            obj = json.loads(raw)
        except Exception:
            return None
        params = obj.get("params") if isinstance(obj, dict) and obj.get("method") == "event" else obj
        if not isinstance(params, dict):
            return None
        event_type = params.get("type")
        if not event_type:
            return None
        return json.dumps({"type": "pet_event", "payload": params}, ensure_ascii=False)

    def _default_origin_port(scheme: str) -> int | None:
        if scheme == "https":
            return 443
        if scheme == "http":
            return 80
        return None

    def _host_port_for_origin(host_header: str, scheme: str) -> tuple[str, int | None] | None:
        raw = str(host_header or "").split(",", 1)[0].strip()
        if not raw:
            return None
        try:
            parsed = urlparse(f"//{raw}")
            hostname = (parsed.hostname or "").strip().lower()
            port = parsed.port if parsed.port is not None else _default_origin_port(scheme)
        except Exception:
            return None
        if not hostname:
            return None
        return hostname, port

    def _request_scheme_for_origin(scheme: str) -> str:
        raw = str(scheme or "").strip().lower()
        if raw == "wss":
            return "https"
        if raw == "ws":
            return "http"
        return raw

    def _trusted_proxy_headers_allowed(client_host: str) -> bool:
        if not trust_xff:
            return False
        trusted_proxy_spec = (config.trusted_proxy_ips or "").strip()
        if trusted_proxy_spec and not ip_allowed((client_host or "").strip(), trusted_proxy_spec):
            return False
        return True

    def _external_request_scheme(headers, *, fallback_scheme: str, client_host: str) -> str:
        request_scheme = _request_scheme_for_origin(fallback_scheme)
        if not _trusted_proxy_headers_allowed(client_host):
            return request_scheme

        forwarded_proto = str(headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip().lower()
        forwarded_scheme = _request_scheme_for_origin(forwarded_proto)
        if forwarded_scheme in {"http", "https"}:
            return forwarded_scheme
        return request_scheme

    def _same_origin_request(origin: str | None, *, host: str, scheme: str) -> bool:
        raw_origin = str(origin or "").strip()
        if not raw_origin:
            return True
        try:
            parsed = urlparse(raw_origin)
            origin_scheme = parsed.scheme.lower()
            origin_host = (parsed.hostname or "").strip().lower()
            origin_port = parsed.port if parsed.port is not None else _default_origin_port(origin_scheme)
        except Exception:
            return False
        request_scheme = _request_scheme_for_origin(scheme)
        if origin_scheme not in {"http", "https"} or origin_scheme != request_scheme:
            return False
        expected = _host_port_for_origin(host, request_scheme)
        if expected is None or not origin_host:
            return False
        return (origin_host, origin_port) == expected

    def _dashboard_request_external_scheme(request: Request) -> str:
        return _external_request_scheme(
            request.headers,
            fallback_scheme=request.url.scheme,
            client_host=request.client.host if request.client else "",
        )

    def _dashboard_origin_forbidden_response(request: Request) -> JSONResponse | None:
        if _same_origin_request(
            request.headers.get("origin"),
            host=request.headers.get("host", ""),
            scheme=_dashboard_request_external_scheme(request),
        ):
            return None
        return JSONResponse({"detail": "forbidden"}, status_code=403)

    def _dashboard_websocket_external_scheme(websocket: WebSocket) -> str:
        return _external_request_scheme(
            websocket.headers,
            fallback_scheme=websocket.url.scheme,
            client_host=websocket.client.host if websocket.client else "",
        )

    def _websocket_origin_allowed(websocket: WebSocket, *, allow_missing: bool = False) -> bool:
        origin = str(websocket.headers.get("origin") or "").strip()
        if not origin:
            return allow_missing
        if _same_origin_request(
            origin,
            host=websocket.headers.get("host", ""),
            scheme=_dashboard_websocket_external_scheme(websocket),
        ):
            return True
        normalized = origin.rstrip("/")
        return normalized in {str(item).strip().rstrip("/") for item in cors_origins}

    def _dashboard_websocket_origin_allowed(websocket: WebSocket) -> bool:
        return _websocket_origin_allowed(websocket)

    def _is_public_path(path: str) -> bool:
        # SPA + static: public. Guard /api except explicit auth endpoints.
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

    @app.middleware("http")
    async def _security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Built-in assets, the authenticated Hermes dashboard, and tokenized runner
        # iframes must be frameable by hermelinChat. Keep everything else denied.
        if (
            _path_is_or_under(request.url.path, "/api/default-artifacts")
            or _path_is_or_under(request.url.path, dashboard_base_path)
            or _is_runner_proxy_frame_path(request.url.path)
        ):
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
        else:
            response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if cookie_secure:
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response

    def _read_default_model_from_config_file() -> Optional[str]:
        cfg_path = config.hermes_home / "config.yaml"
        try:
            text = cfg_path.read_text(encoding="utf-8")
        except Exception:
            logger.debug("could not read config.yaml at %s", cfg_path, exc_info=True)
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
            "db_exists": config.db_path.exists(),
            "auth_enabled": auth_enabled,
        }

    @app.get("/api/info")
    async def api_info():
        return {
            "default_model": _read_default_model(),
            "spawn_cwd": str(config.spawn_cwd),
            "runtime_backend": str(config.runtime_backend or "auto"),
            "runtime_registry_path": str(config.runtime_registry_path),
            "runtime_autostart_default": bool(config.runtime_autostart_default),
        }

    runtime_registry = RuntimeRegistry(config.runtime_registry_path)

    def _pet_sidecar_token_valid(token: str, channel: str) -> bool:
        candidate = str(token or "")
        runtime_channel = str(channel or "")
        if not _PET_SIDECAR_TOKEN_RE.fullmatch(candidate):
            return False
        if hmac.compare_digest(candidate.encode(), pet_sidecar_secret.encode()):
            return True
        for record in runtime_registry.list_runtimes():
            if record.state == "stopped" or record.backend != "tmux":
                continue
            recorded_channel = str((record.metadata or {}).get("pet_event_channel") or "")
            if recorded_channel != runtime_channel:
                continue
            recovered = _pet_sidecar_token_from_process(record.hermes_pid, recorded_channel)
            if recovered and hmac.compare_digest(candidate.encode(), recovered.encode()):
                return True
        return False

    def _runtime_backend_or_error():
        return select_runtime_backend(
            config.runtime_backend,
            tmux_prefix=config.runtime_tmux_prefix,
        )

    def _known_hermes_profile(value: object) -> str:
        profile = _safe_hermes_profile_name(value)
        if not profile:
            raise ValueError("invalid Hermes profile")
        if profile != "default":
            known = {str(item.get("name")) for item in _list_hermes_profiles(config.hermes_home)}
            if profile not in known:
                raise ValueError(f"unknown Hermes profile: {profile}")
        return profile

    def _profile_state_db(profile: object) -> tuple[str, Path]:
        selected = _known_hermes_profile(profile)
        if selected == "default":
            return selected, Path(config.db_path)
        return selected, _hermes_profile_state_db_path(config.hermes_home, selected)

    def _runtime_placeholder_title(value: object) -> str:
        title = str(value or "").strip()
        if not title or title.lower() in {"default", "hermes", "new session"}:
            return "New session"
        if re.fullmatch(r"Hermes\s+\d+", title, flags=re.IGNORECASE):
            return "New session"
        return title

    def _runtime_session_title(record: RuntimeRecord) -> str | None:
        session_id = str(record.active_hermes_session_id or "").strip()
        if not session_id:
            return None
        try:
            _, state_db = _profile_state_db(record.profile)
            base_title = get_session_title(state_db, session_id)
            meta_title = get_titles_map(config.meta_db_path, [session_id]).get(session_id)
            return str(meta_title or base_title or "").strip() or None
        except Exception:
            logger.debug("failed to resolve runtime session title", exc_info=True)
            return None

    def _runtime_dict(record: RuntimeRecord) -> dict:
        data = record.to_dict()
        session_title = _runtime_session_title(record)
        data["session_title"] = session_title
        data["display_title"] = session_title or _runtime_placeholder_title(record.title)
        channel = str((record.metadata or {}).get("pet_event_channel") or "")
        observed_activity = _pet_activity_state().get(channel) if channel else None
        data["runtime_activity"] = observed_activity or ("working" if record.state == "starting" else "idle")
        data["can_attach"] = record.backend == "tmux" and record.state != "stopped"
        data["can_stop"] = record.backend == "tmux" and record.state != "stopped"
        if record.backend == "legacy":
            data["attach_ws_path"] = "/ws/pty"
        else:
            data["attach_ws_path"] = f"/ws/runtimes/{record.runtime_id}/attach"
        return data

    def _runtime_launch_env_and_argv(runtime_id: str, source: str, profile: str = "default") -> tuple[list[str], dict[str, str]]:
        argv = shlex.split(_get_effective_hermes_cmd())
        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        env.setdefault("PYTHONUNBUFFERED", "1")
        env.setdefault("HERMES_HOME", str(config.hermes_home))
        env["HERMES_MANAGED_BY"] = "hermelinchat"
        env["HERMES_MANAGED_RUNTIME_ID"] = runtime_id
        env["HERMES_MANAGED_SOURCE"] = source
        env["HERMELIN_RUNTIME_ID"] = runtime_id
        if argv and Path(argv[0]).name == "hermes":
            argv[0] = _resolve_hermes_executable(argv[0], env)
        argv = _with_hermes_profile_args(argv, profile)
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
            "COLUMNS",
            "LINES",
        ):
            env.pop(k, None)
        try:
            exe_name = Path(argv[0]).name.lower() if argv else ""
        except Exception:
            exe_name = ""
        if "hermes" in exe_name and not _env_flag_default("HERMELIN_PTY_PET_ENABLED", False):
            pty_managed_dir = _prepare_pty_managed_scope(config, env)
            if pty_managed_dir is not None:
                env["HERMES_MANAGED_DIR"] = str(pty_managed_dir)
        if _command_supports_pet_sidecar(argv):
            pet_channel = re.sub(r"[^A-Za-z0-9_-]", "-", f"runtime-{runtime_id}")[:128]
            if not pet_sidecar_channel_re.match(pet_channel):
                pet_channel = _new_pet_event_channel()
            pet_sidecar_url = _build_pet_sidecar_url(pet_channel)
            if pet_sidecar_url:
                _prepare_pet_sidecar_tls_env(env)
                env["HERMES_TUI_SIDECAR_URL"] = pet_sidecar_url
                env["HERMELIN_PET_EVENT_CHANNEL"] = pet_channel
        return argv, env

    async def _reconcile_runtime(record: RuntimeRecord) -> RuntimeRecord:
        if record.backend == "tmux":
            backend = TmuxRuntimeBackend(prefix=config.runtime_tmux_prefix)
            status = await backend.status(record)
            if not status.exists:
                try:
                    return runtime_registry.mark_stopped(record.runtime_id)
                except Exception:
                    return record
            try:
                return runtime_registry.update_runtime(
                    record.runtime_id,
                    state=status.state,
                    hermes_pid=status.hermes_pid,
                    active_hermes_session_id=(
                        status.active_hermes_session_id or record.active_hermes_session_id
                    ),
                    last_seen_at=utc_ts(),
                )
            except Exception:
                return record
        return record

    async def _create_runtime_from_payload(payload: dict | None = None) -> RuntimeRecord:
        payload = payload or {}
        backend = _runtime_backend_or_error()
        rid = str(payload.get("runtime_id") or payload.get("runtimeId") or new_runtime_id()).strip()
        title = str(payload.get("title") or "New session").strip() or "New session"
        profile, profile_db = _profile_state_db(payload.get("profile") or "default")
        source = str(payload.get("source") or "user_ui").strip() or "user_ui"
        resume_raw = str(payload.get("resume") or payload.get("resume_id") or payload.get("resumeId") or "").strip()
        safe_resume = resolve_resume_session_id(profile_db, resume_raw) if resume_raw else None
        if resume_raw and not safe_resume:
            raise ValueError("invalid resume session")
        cwd_raw = str(payload.get("cwd") or config.spawn_cwd).strip()
        cwd = Path(cwd_raw).expanduser()
        cols = int(payload.get("cols") or 120)
        rows = int(payload.get("rows") or 30)
        argv, env = _runtime_launch_env_and_argv(rid, source, profile)
        if safe_resume:
            argv += ["--resume", safe_resume]
        tmux_name = backend.tmux_name_for(rid) if isinstance(backend, TmuxRuntimeBackend) else None
        req = RuntimeCreateRequest(
            runtime_id=rid,
            title=title,
            profile=profile,
            cwd=cwd,
            source=source,
            command=argv,
            env=env,
            launcher_dir=config.hermes_home / "hermelin" / "runtime-launchers",
            tmux_name=tmux_name,
            cols=cols,
            rows=rows,
        )
        record = await backend.create(req)
        if safe_resume:
            record.active_hermes_session_id = safe_resume
        runtime_metadata = dict(record.metadata or {})
        if env.get("HERMELIN_PET_EVENT_CHANNEL"):
            runtime_metadata["pet_event_channel"] = env.get("HERMELIN_PET_EVENT_CHANNEL")
        if env.get("HERMES_TUI_SIDECAR_URL"):
            runtime_metadata["pet_sidecar"] = True
        record.metadata = runtime_metadata
        try:
            existing = runtime_registry.get_runtime(record.runtime_id)
            if existing:
                record = runtime_registry.update_runtime(record.runtime_id, **{k: v for k, v in record.to_dict().items() if k != "runtime_id"})
            else:
                record = runtime_registry.create_runtime(record)
        except ValueError:
            record = runtime_registry.get_runtime(record.runtime_id) or record
        runtime_registry.remember_last_active(record.runtime_id)
        return record

    @app.get("/api/runtimes/config")
    async def api_runtimes_config():
        try:
            backend = _runtime_backend_or_error()
            backend_name = backend.name
            available = backend.available()
            error = None
        except Exception as exc:
            backend_name = "off"
            available = False
            error = str(exc)
        return {
            "enabled": str(config.runtime_backend or "auto").lower() != "off",
            "backend": backend_name,
            "available": available,
            "configured_backend": str(config.runtime_backend or "auto"),
            "autostart_default": bool(config.runtime_autostart_default),
            "tmux_prefix": config.runtime_tmux_prefix,
            "registry_path": str(config.runtime_registry_path),
            "profiles": _list_hermes_profiles(config.hermes_home),
            "default_profile": "default",
            "error": error,
        }

    @app.get("/api/runtimes")
    async def api_runtimes():
        records = runtime_registry.list_runtimes()
        if not records and config.runtime_autostart_default and str(config.runtime_backend or "auto").lower() != "off":
            try:
                records = [await _create_runtime_from_payload({"title": "New session"})]
            except Exception:
                logger.debug("failed to autostart default runtime", exc_info=True)
                records = []
        reconciled = [await _reconcile_runtime(record) for record in records]
        last_active = runtime_registry.get_last_active()
        if not last_active and reconciled:
            last_active = reconciled[0].runtime_id
            runtime_registry.remember_last_active(last_active)
        return {"runtimes": [_runtime_dict(record) for record in reconciled], "last_active_runtime_id": last_active}

    @app.post("/api/runtimes")
    async def api_runtimes_create(payload: dict = Body(default={})):  # type: ignore[assignment]
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "payload must be an object"}, status_code=400)
        try:
            record = await _create_runtime_from_payload(payload)
        except RuntimeBackendError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=503)
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        except Exception as exc:
            logger.warning("failed to create runtime", exc_info=True)
            return JSONResponse({"detail": "failed to create runtime", "error": str(exc)}, status_code=500)
        return {"runtime": _runtime_dict(record)}

    @app.get("/api/runtimes/{runtime_id}")
    async def api_runtime_get(runtime_id: str):
        record = runtime_registry.get_runtime(runtime_id)
        if not record:
            return JSONResponse({"detail": "runtime not found"}, status_code=404)
        record = await _reconcile_runtime(record)
        return {"runtime": _runtime_dict(record)}

    @app.post("/api/runtimes/{runtime_id}/activate")
    async def api_runtime_activate(runtime_id: str):
        record = runtime_registry.get_runtime(runtime_id)
        if not record:
            return JSONResponse({"detail": "runtime not found"}, status_code=404)
        runtime_registry.remember_last_active(runtime_id)
        try:
            record = runtime_registry.update_runtime(runtime_id, last_attached_at=utc_ts())
        except Exception:
            pass
        return {"runtime": _runtime_dict(runtime_registry.get_runtime(runtime_id) or record)}

    @app.post("/api/runtimes/{runtime_id}/session")
    async def api_runtime_bind_session(runtime_id: str, payload: dict = Body(default={})):  # type: ignore[assignment]
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "payload must be an object"}, status_code=400)
        record = runtime_registry.get_runtime(runtime_id)
        if not record:
            return JSONResponse({"detail": "runtime not found"}, status_code=404)
        session_id = str(payload.get("session_id") or payload.get("sessionId") or "").strip()
        if not is_valid_session_id(session_id):
            return JSONResponse({"detail": "invalid session id"}, status_code=400)
        try:
            record = runtime_registry.update_runtime(runtime_id, active_hermes_session_id=session_id)
        except Exception:
            return JSONResponse({"detail": "failed to bind runtime session"}, status_code=500)
        return {"runtime": _runtime_dict(record)}

    @app.post("/api/runtimes/{runtime_id}/stop")
    async def api_runtime_stop(runtime_id: str):
        record = runtime_registry.get_runtime(runtime_id)
        if not record:
            return JSONResponse({"detail": "runtime not found"}, status_code=404)
        if record.backend != "tmux":
            record = runtime_registry.mark_stopped(runtime_id)
            return {"runtime": _runtime_dict(record)}
        backend = TmuxRuntimeBackend(prefix=config.runtime_tmux_prefix)
        try:
            await backend.stop(record)
        except Exception:
            logger.debug("failed to stop tmux runtime", exc_info=True)
        record = runtime_registry.mark_stopped(runtime_id)
        return {"runtime": _runtime_dict(record)}

    @app.get("/api/pet/info")
    async def api_pet_info(slug: str = ""):
        return _pet_overlay_info(config, slug_override=slug)

    @app.get("/api/artifacts")
    async def api_artifacts():
        return list_artifacts(config.artifact_dir, hermes_home=config.hermes_home)

    @app.get("/api/artifacts/latest")
    async def api_artifacts_latest():
        return latest_artifact(config.artifact_dir, hermes_home=config.hermes_home)

    @app.get("/api/default-artifacts/{asset_path:path}")
    async def api_default_artifact_asset(asset_path: str):
        resolved = resolve_default_artifact_path(config.static_dir, asset_path)
        if resolved is None:
            return JSONResponse({"error": "default artifact asset not found"}, status_code=404)
        return FileResponse(resolved)

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
            logger.exception("failed to store bridge event")
            return JSONResponse({"detail": "internal error storing bridge event"}, status_code=500)

        return {"ok": True, "artifact_id": artifact_id, "channel": channel, "event": event_name, "request_id": request_id or None}

    # ---------------------------------------------------------------------
    # Native Hermes dashboard proxy
    # ---------------------------------------------------------------------

    register_hermes_dashboard_routes(
        app,
        config=config,
        dashboard_manager=dashboard_manager,
        dashboard_base_path=dashboard_base_path,
        request_origin_forbidden_response=_dashboard_origin_forbidden_response,
        request_external_scheme=_dashboard_request_external_scheme,
        websocket_origin_allowed=_dashboard_websocket_origin_allowed,
        websocket_external_scheme=_dashboard_websocket_external_scheme,
        check_allowed=_check_allowed,
        auth_enabled=auth_enabled,
        is_authenticated=_is_authenticated,
        cookie_name=cookie_name,
        trust_xff=trust_xff,
    )

    # ---------------------------------------------------------------------
    # HermelinFleet bridge proxy
    # ---------------------------------------------------------------------

    register_fleet_routes(app, config=config, settings=fleet_settings)

    async def _reject_unavailable_fleet_websocket(websocket: WebSocket) -> bool:
        payload: dict[str, str] | None = None
        if not fleet_settings.enabled:
            payload = FLEET_DISABLED_PAYLOAD
        elif not fleet_settings.available:
            payload = FLEET_UNAVAILABLE_PAYLOAD
        if payload is None:
            return False
        await websocket.accept()
        await websocket.send_json(dict(payload))
        await websocket.close(code=1008, reason=payload["detail"])
        return True

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

        if tab_id == DASHBOARD_RUNNER_ID or not is_valid_artifact_id(tab_id):
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
        # Never forward hermelinChat session material to runners.
        "cookie",
        "authorization",
    }

    _RUNNER_STRIP_RESPONSE_HEADERS = {
        # Runner must never be able to set cookies on hermelinChat origin.
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

    @app.api_route("/r/{tab_id}/_t", methods=_RUNNER_PROXY_METHODS)
    @app.api_route("/r/{tab_id}/_t/", methods=_RUNNER_PROXY_METHODS)
    async def runner_proxy_missing_token(tab_id: str):
        if not is_valid_artifact_id(tab_id):
            return JSONResponse({"detail": "invalid tab id"}, status_code=400)
        return JSONResponse({"detail": "unauthorized"}, status_code=401)

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

        client = request.app.state.httpx_client

        try:
            req = client.build_request(
                method=request.method,
                url=upstream_url,
                headers=req_headers,
                content=body,
            )
            upstream_resp = await client.send(req, stream=True)
        except Exception as exc:
            logger.exception("runner proxy error")
            return JSONResponse({"detail": "runner proxy unavailable"}, status_code=502)

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

        return StreamingResponse(
            _iter_bytes(),
            status_code=upstream_resp.status_code,
            headers=resp_headers,
        )

    @app.api_route("/r", methods=_RUNNER_PROXY_METHODS)
    @app.api_route("/r/{path:path}", methods=_RUNNER_PROXY_METHODS)
    async def runner_proxy_reserved_namespace(path: str = ""):
        # Reserve /r for token-bearing runner proxy requests so malformed runner
        # URLs cannot fall through to the public SPA route.
        return JSONResponse({"detail": "unauthorized"}, status_code=401)

    @app.websocket("/r/{tab_id}/_t/{token}")
    @app.websocket("/r/{tab_id}/_t/{token}/{path:path}")
    async def ws_runner_proxy(websocket: WebSocket, tab_id: str, token: str, path: str = ""):
        if not _websocket_origin_allowed(websocket, allow_missing=True):
            await websocket.close(code=1008)
            return
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
            logger.warning("WebSocket runner proxy connection failed for tab=%s", tab_id, exc_info=True)
            try:
                await websocket.close(code=1011)
            except Exception:
                pass
            return

        try:
            await websocket.close()
        except Exception:
            pass

    @app.post("/api/artifacts/{artifact_id}/rename")
    async def api_rename_artifact(artifact_id: str, payload: dict = Body(default={})):  # type: ignore[assignment]
        if not is_valid_artifact_id(artifact_id):
            return JSONResponse({"detail": "invalid artifact id"}, status_code=400)
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "invalid request body"}, status_code=400)
        title = str(payload.get("title") or "").strip()
        if not title or len(title) > 200:
            return JSONResponse({"detail": "invalid artifact title"}, status_code=400)
        try:
            updated = rename_artifact_title(config.artifact_dir, artifact_id, title)
        except ValueError:
            return JSONResponse({"detail": "invalid artifact rename request"}, status_code=400)
        except Exception:
            logger.exception("failed to rename artifact")
            return JSONResponse({"detail": "internal error renaming artifact"}, status_code=500)
        if not updated:
            return JSONResponse({"detail": "artifact not found"}, status_code=404)
        return {"ok": True, "artifact_id": artifact_id, "title": title, "updated": updated}

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
            logger.exception("failed to delete artifact")
            return JSONResponse({"detail": "internal error deleting artifact"}, status_code=500)
        return {"ok": True, "artifact_id": artifact_id, "removed": removed}

    @app.post("/api/artifacts/clear-session")
    async def api_clear_session_artifacts():
        try:
            info = cleanup_session_artifacts(config.artifact_dir)
        except Exception:
            logger.exception("failed to clear session artifacts")
            return JSONResponse({"detail": "internal error clearing session artifacts"}, status_code=500)
        return info

    def _hermes_bin() -> str:
        try:
            argv = shlex.split(_get_hermes_cmd())
            if argv:
                return _resolve_hermes_executable(argv[0], os.environ)
        except Exception:
            pass
        return _resolve_hermes_executable("hermes", os.environ)

    def _hermes_profiled_prefix(profile: str) -> list[str]:
        selected = _known_hermes_profile(profile)
        prefix = [_hermes_bin()]
        if selected != "default":
            prefix.extend(["--profile", selected])
        return prefix

    def _hermes_sessions_rename(session_id: str, title: str, profile: str = "default") -> tuple[bool, str]:
        sid = str(session_id or "").strip()
        t = str(title or "").strip()
        if not sid:
            return False, "session id is required"
        if not t:
            return False, "title is required"

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        cmd = [*_hermes_profiled_prefix(profile), "sessions", "rename", sid, t]
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
                out = f"hermes sessions rename failed (code {r.returncode})"
            if len(out) > 800:
                out = out[:800] + "…"
            return False, out

        return True, ""

    def _hermes_sessions_delete(session_id: str, profile: str = "default") -> tuple[bool, str]:
        sid = str(session_id or "").strip()
        if not sid:
            return False, "session id is required"

        env = os.environ.copy()
        env.setdefault("PYTHONUNBUFFERED", "1")
        env["HERMES_HOME"] = str(config.hermes_home)

        cmd = [*_hermes_profiled_prefix(profile), "sessions", "delete", sid, "--yes"]

        last_out = ""
        for attempt in range(3):
            try:
                r = subprocess.run(
                    cmd,
                    cwd=str(config.spawn_cwd),
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
            except FileNotFoundError:
                return False, f"executable not found: {cmd[0]}"
            except subprocess.TimeoutExpired:
                last_out = "timed out"
                continue
            except Exception as e:
                return False, str(e)

            if r.returncode == 0:
                return True, ""

            msg = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            out = "\n".join([x for x in [msg, err] if x]) or f"hermes sessions delete failed (code {r.returncode})"
            if len(out) > 800:
                out = out[:800] + "…"
            last_out = out

            low = out.lower()
            if "database is locked" in low or "locked" in low:
                time.sleep(0.2 * (attempt + 1))
                continue
            break

        return False, last_out or "delete failed"

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
            logger.debug("hermes config show subprocess failed", exc_info=True)
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
            logger.debug("could not read .env file at %s", env_path, exc_info=True)
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
            logger.warning("failed to write .env file at %s", env_path, exc_info=True)
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
        so hermelinChat doesn't need hermes_cli installed in its own venv.
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
            logger.debug("hermes CLI model list subprocess failed", exc_info=True)
            return None, "hermes_cli_error"

        if r.returncode != 0:
            return None, "hermes_cli_error"

        try:
            data = json.loads((r.stdout or "").strip())
        except Exception:
            logger.debug("failed to parse hermes CLI model list output", exc_info=True)
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
            logger.debug("failed to read .env vars", exc_info=True)
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
            # Redact the API key value from error output
            if v and v in out:
                out = out.replace(v, "[REDACTED]")
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
            logger.debug("failed to parse config.yaml at %s", cfg_path, exc_info=True)
            return {}

    def _get_hermes_launch_mode(raw: dict | None = None) -> str:
        raw = raw if isinstance(raw, dict) else _read_config_yaml()
        return _normalize_hermes_launch_mode(_get_config_value(raw, ("hermelin", "hermes_launch_mode")))

    def _get_effective_hermes_cmd(raw: dict | None = None) -> str:
        if _has_hermes_cmd_override():
            return _get_hermes_cmd()
        raw = raw if isinstance(raw, dict) else _read_config_yaml()
        mode = _get_hermes_launch_mode(raw)
        strudel_enabled = _hermelin_toolset_enabled(raw, "strudel")
        hermes_executable = _managed_hermes_executable(_get_hermes_cmd())
        return _build_hermes_command_for_launch_mode(
            mode,
            strudel_enabled=strudel_enabled,
            hermes_executable=hermes_executable,
        )

    def _write_config_text(updated: str) -> tuple[bool, str]:
        cfg_path = config.hermes_home / "config.yaml"
        tmp_path = cfg_path.with_name(f".{cfg_path.name}.{int(time.time() * 1000)}.tmp")
        try:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path.write_text(updated, encoding="utf-8")
            os.replace(tmp_path, cfg_path)
            return True, ""
        except Exception as exc:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            return False, str(exc)

    def _set_display_skin(skin: str) -> bool:
        """Best-effort: set display.skin in Hermes' config.yaml.

        Hermes reads the skin at startup; hermelinChat uses this to auto-sync the
        CLI skin with the UI theme.

        IMPORTANT: update only the display.skin entry (or append it if missing)
        instead of round-tripping the whole YAML document. That preserves unrelated
        config keys, comments, and manual formatting in the user's config.yaml.
        """

        skin = str(skin or "").strip()
        if not skin:
            return False

        cfg_path = config.hermes_home / "config.yaml"
        try:
            existing = cfg_path.read_text(encoding="utf-8") if cfg_path.exists() else ""
        except Exception:
            existing = ""

        updated, changed = _update_display_skin_config_text(existing, skin)
        if not changed:
            return False

        tmp_path = cfg_path.with_name(f".{cfg_path.name}.{int(time.time() * 1000)}.tmp")
        try:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path.write_text(updated, encoding="utf-8")
            os.replace(tmp_path, cfg_path)
            return True
        except Exception:
            logger.warning("failed to write display skin to config.yaml", exc_info=True)
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
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

        launch_mode = _normalize_hermes_launch_mode(_get_config_value(raw, ("hermelin", "hermes_launch_mode")))

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
            "hermelin": {
                "hermes_launch_mode": launch_mode,
                "hermes_cmd_override": _has_hermes_cmd_override(),
                "effective_hermes_cmd": "custom Hermes command override" if _has_hermes_cmd_override() else _get_effective_hermes_cmd(raw),
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

    def _get_default_artifact_cfg() -> dict:
        return {
            "items": list_default_artifact_settings(hermes_home=config.hermes_home),
            "config_path": str(config.hermes_home / "config.yaml"),
        }

    def _sync_tui_platform_toolsets_config_text(text: str) -> tuple[str, bool]:
        updated = text or ""
        try:
            raw_cfg = yaml.safe_load(updated) or {}
        except Exception:
            raw_cfg = {}
        if not isinstance(raw_cfg, dict):
            raw_cfg = {}
        strudel_enabled = _hermelin_toolset_enabled(raw_cfg, "strudel")

        changed_any = False
        updated, changed = _update_platform_toolset_enabled_config_text(updated, "cli", "artifacts", True)
        changed_any = changed_any or changed
        updated, changed = _update_platform_toolset_enabled_config_text(updated, "cli", "strudel", strudel_enabled)
        changed_any = changed_any or changed
        return updated, changed_any

    def _set_hermelin_launch_mode(mode: str) -> tuple[bool, str]:
        normalized = _normalize_hermes_launch_mode(mode)
        cfg_path = config.hermes_home / "config.yaml"
        try:
            existing = cfg_path.read_text(encoding="utf-8") if cfg_path.exists() else ""
        except Exception:
            existing = ""

        updated, changed_any = _update_hermelin_launch_mode_config_text(existing, normalized)
        if normalized == "tui":
            updated, changed = _sync_tui_platform_toolsets_config_text(updated)
            changed_any = changed_any or changed
        if not changed_any:
            return True, ""
        return _write_config_text(updated)

    def _set_default_artifact_flags(flags: dict[str, bool]) -> tuple[bool, str]:
        supported_ids = {str(item.get("id") or "").strip() for item in list_default_artifact_settings(hermes_home=config.hermes_home)}
        unsupported = sorted(key for key in flags.keys() if key not in supported_ids)
        if unsupported:
            return False, f"unsupported default artifact(s): {', '.join(unsupported)}"

        cfg_path = config.hermes_home / "config.yaml"
        try:
            existing = cfg_path.read_text(encoding="utf-8") if cfg_path.exists() else ""
        except Exception:
            existing = ""

        updated = existing
        changed_any = False
        for artifact_id, enabled in flags.items():
            updated, changed = _update_default_artifact_flag_config_text(updated, artifact_id, bool(enabled))
            changed_any = changed_any or changed
            updated, changed = _update_nested_bool_flag_config_text(updated, ("hermelin", "toolsets", artifact_id), bool(enabled))
            changed_any = changed_any or changed

        # Hermes TUI resolves enabled tools from platform_toolsets.cli rather
        # than from the classic `hermes chat --toolsets ...` command line.
        # Keep Hermelin's tools visible there without clobbering user entries.
        updated, changed = _update_platform_toolset_enabled_config_text(updated, "cli", "artifacts", True)
        changed_any = changed_any or changed
        if "strudel" in flags:
            updated, changed = _update_platform_toolset_enabled_config_text(updated, "cli", "strudel", bool(flags.get("strudel", False)))
            changed_any = changed_any or changed

        if not changed_any:
            return True, ""

        tmp_path = cfg_path.with_name(f".{cfg_path.name}.{int(time.time() * 1000)}.tmp")
        try:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path.write_text(updated, encoding="utf-8")
            os.replace(tmp_path, cfg_path)
        except Exception as exc:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            return False, str(exc)

        next_cmd, cmd_changed, cmd_error = _set_command_toolset_enabled(_get_hermes_cmd(), "strudel", bool(flags.get("strudel", False)))
        if cmd_error:
            return False, cmd_error
        if cmd_changed:
            _set_hermes_cmd(next_cmd)
            env_path = _resolve_hermelin_env_file()
            if env_path is not None:
                try:
                    env_text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
                except Exception:
                    env_text = ""
                updated_env, env_changed = _update_env_var_text(env_text, "HERMELIN_HERMES_CMD", next_cmd)
                if env_changed:
                    env_tmp = env_path.with_name(f".{env_path.name}.{int(time.time() * 1000)}.tmp")
                    try:
                        env_path.parent.mkdir(parents=True, exist_ok=True)
                        env_tmp.write_text(updated_env, encoding="utf-8")
                        os.replace(env_tmp, env_path)
                    except Exception as exc:
                        try:
                            env_tmp.unlink(missing_ok=True)
                        except Exception:
                            pass
                        return False, str(exc)

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
        hermelin_in = payload.get("hermelin") if isinstance(payload.get("hermelin"), dict) else {}

        legacy_sections = ("agent", "display", "memory", "compression", "terminal")
        if not any(isinstance(payload.get(section), dict) for section in legacy_sections):
            launch_mode = _normalize_hermes_launch_mode(
                hermelin_in.get("hermes_launch_mode", cur["hermelin"]["hermes_launch_mode"])
            )
            ok, err = await asyncio.to_thread(_set_hermelin_launch_mode, launch_mode)
            if not ok:
                return JSONResponse(
                    {"detail": "failed to save", "error": f"hermelin.hermes_launch_mode: {err}"},
                    status_code=500,
                )
            return {"ok": True, **_get_cfg()}

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
            "hermelin": {
                "hermes_launch_mode": _normalize_hermes_launch_mode(
                    hermelin_in.get("hermes_launch_mode", cur["hermelin"]["hermes_launch_mode"])
                ),
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

        ok, err = await asyncio.to_thread(_set_hermelin_launch_mode, draft["hermelin"]["hermes_launch_mode"])
        if not ok:
            return JSONResponse({"detail": "failed to save", "error": f"hermelin.hermes_launch_mode: {err}"}, status_code=500)

        # Return fresh values
        return {"ok": True, **_get_cfg()}

    @app.get("/api/settings/default-artifacts")
    async def api_settings_default_artifacts():
        return _get_default_artifact_cfg()

    @app.post("/api/settings/default-artifacts")
    async def api_settings_default_artifacts_set(payload: dict = Body(...)):
        if not isinstance(payload, dict):
            return JSONResponse({"detail": "invalid payload"}, status_code=400)

        items_in = payload.get("items")
        if not isinstance(items_in, list):
            return JSONResponse({"detail": "items list required"}, status_code=400)

        flags: dict[str, bool] = {}
        for item in items_in:
            if not isinstance(item, dict):
                return JSONResponse({"detail": "invalid item"}, status_code=400)
            artifact_id = str(item.get("id") or "").strip()
            if not artifact_id:
                return JSONResponse({"detail": "artifact id required"}, status_code=400)
            flags[artifact_id] = _as_bool(item.get("enabled"), False)

        ok, err = await asyncio.to_thread(_set_default_artifact_flags, flags)
        if not ok:
            return JSONResponse({"detail": "failed to save", "error": err}, status_code=500)

        return {"ok": True, **_get_default_artifact_cfg()}

    @app.get("/api/whisper")
    async def api_whisper():
        # Return a very short UI "whisper" string (randomly sampled).
        try:
            raw = get_random_whisper(config.meta_db_path)
        except Exception:
            logger.debug("failed to get random whisper", exc_info=True)
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

    # ── Update check (cached) ──────────────────────────────────────────

    _GITHUB_REPO = "quarker1337/hermelinChat"
    _update_cache: dict = {
        "latest": None,
        "checked_at": 0.0,
        "error": None,
        "commits_behind_main": None,
        "compare_url": None,
    }
    _UPDATE_CHECK_INTERVAL = 3600  # re-check at most once per hour

    async def _fetch_commits_behind_main(client: httpx.AsyncClient, current_version: str):
        base_refs = []
        source_head = _source_checkout_head()
        if source_head:
            base_refs.append(source_head)

        base_tag = _github_release_tag_for_version(current_version)
        if base_tag and base_tag not in base_refs:
            base_refs.append(base_tag)

        if not base_refs:
            return None, None

        compare_url = None
        for base_ref in base_refs:
            compare_url = f"https://github.com/{_GITHUB_REPO}/compare/{base_ref}...main"
            try:
                r = await client.get(
                    f"https://api.github.com/repos/{_GITHUB_REPO}/compare/{base_ref}...main",
                    headers={"Accept": "application/vnd.github.v3+json"},
                )
                if r.status_code != 200:
                    continue

                data = r.json()
                commits_behind = data.get("ahead_by")
                if not isinstance(commits_behind, int) or commits_behind < 0:
                    continue
                return commits_behind, data.get("html_url") or compare_url
            except Exception:
                logger.debug("commit compare check failed", exc_info=True)
                continue

        return None, compare_url

    def _update_check_response(current_version: str, cached: bool):
        latest = _update_cache["latest"] or current_version
        return {
            "current": current_version,
            "latest": latest,
            "update_available": _is_update_available(current_version, latest),
            "url": f"https://github.com/{_GITHUB_REPO}/releases/latest",
            "cached": cached,
            "error": _update_cache.get("error"),
            "commits_behind_main": _update_cache.get("commits_behind_main"),
            "compare_url": _update_cache.get("compare_url"),
        }

    @app.get("/api/update-check")
    async def update_check():
        """Check GitHub for newer hermelinChat releases and main commits (cached 1h)."""
        from hermelin import __version__ as current_version

        now = time.time()

        # Return cached result if fresh enough
        if now - _update_cache["checked_at"] < _UPDATE_CHECK_INTERVAL and (
            _update_cache["latest"] is not None or _update_cache["error"] is not None
        ):
            return _update_check_response(current_version, cached=True)

        # Fetch from GitHub
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(
                    f"https://api.github.com/repos/{_GITHUB_REPO}/releases/latest",
                    headers={"Accept": "application/vnd.github.v3+json"},
                )
                if r.status_code == 200:
                    data = r.json()
                    tag = (data.get("tag_name") or "").lstrip("v").strip()
                    commits_behind, compare_url = await _fetch_commits_behind_main(client, current_version)
                    _update_cache["latest"] = tag
                    _update_cache["checked_at"] = now
                    _update_cache["error"] = None
                    _update_cache["commits_behind_main"] = commits_behind
                    _update_cache["compare_url"] = compare_url
                else:
                    _update_cache["checked_at"] = now
                    _update_cache["error"] = f"GitHub API returned {r.status_code}"
                    _update_cache["commits_behind_main"] = None
                    _update_cache["compare_url"] = None
        except Exception:
            logger.warning("update check failed", exc_info=True)
            _update_cache["checked_at"] = now
            _update_cache["error"] = "Update check temporarily unavailable"
            _update_cache["commits_behind_main"] = None
            _update_cache["compare_url"] = None

        return _update_check_response(current_version, cached=False)

    # -----------------------------------------------------------------
    # Auth (password -> signed session cookie)
    # -----------------------------------------------------------------

    @app.get("/api/auth/me")
    async def auth_me(request: Request):
        token = request.cookies.get(cookie_name)
        authenticated = _is_authenticated(token)
        resp = JSONResponse({
            "auth_enabled": auth_enabled,
            "authenticated": authenticated,
            "session_ttl_seconds": ttl_seconds if auth_enabled else None,
        })
        # Sliding-session renewal: an open browser tab periodically calls this
        # endpoint, so refresh the signed cookie before Max-Age expires. Give
        # the previous cookie a short grace window so concurrent same-tab
        # requests do not 401 while the browser installs the replacement.
        if auth_enabled and authenticated and token:
            _renew_session_cookie(resp, token)
        return resp

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

        resp = JSONResponse({"ok": True, "auth_enabled": True})
        _set_session_cookie(resp)
        return resp

    @app.post("/api/auth/logout")
    async def auth_logout(request: Request):
        token = request.cookies.get(cookie_name)
        if token:
            jti = extract_session_jti(token=token, secret=cookie_secret)
            _revoke_session_jti(jti, token=token)
        resp = JSONResponse({"ok": True})
        _delete_session_cookie(resp)
        return resp

    @app.get("/api/sessions")
    async def api_sessions(
        limit: int = 50,
        offset: int = 0,
        source: Optional[str] = None,
        profile: str = "default",
    ):
        try:
            selected_profile, state_db = _profile_state_db(profile)
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        sessions = list_sessions(state_db, limit=limit, offset=offset, source=source)
        for session in sessions:
            session["profile"] = selected_profile

        # Overlay custom titles from meta DB, if present.
        try:
            titles = get_titles_map(config.meta_db_path, [s.get("id") for s in sessions])
        except Exception:
            logger.debug("failed to load title overlays from meta DB", exc_info=True)
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

    @app.post("/api/sessions/{session_id}/rename")
    async def api_session_rename(session_id: str, payload: dict = Body(...)):
        sid = str(session_id or "").strip()
        if not is_valid_artifact_id(sid):
            return JSONResponse({"detail": "invalid session id"}, status_code=400)

        title = str((payload or {}).get("title") or "").strip()
        if not title:
            return JSONResponse({"detail": "title required"}, status_code=400)
        if len(title) > 200:
            return JSONResponse({"detail": "title too long"}, status_code=400)

        try:
            profile, state_db = _profile_state_db((payload or {}).get("profile") or "default")
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        if not resolve_resume_session_id(state_db, sid):
            return JSONResponse({"detail": "session not found for profile"}, status_code=404)

        ok, err = await asyncio.to_thread(_hermes_sessions_rename, sid, title, profile)
        if not ok:
            return JSONResponse(
                {
                    "detail": "failed to rename session",
                    "error": err,
                },
                status_code=500,
            )

        # Store in meta DB so the UI can display it (we still call hermes sessions rename for parity).
        try:
            upsert_title(config.meta_db_path, session_id=sid, title=title, source="ui")
        except Exception:
            logger.warning("failed to upsert title in meta DB for session %s", sid, exc_info=True)
            pass

        return {"ok": True, "session_id": sid, "title": title}

    @app.post("/api/sessions/{session_id}/delete")
    async def api_session_delete(session_id: str, payload: dict | None = Body(default=None)):
        sid = str(session_id or "").strip()
        if not is_valid_artifact_id(sid):
            return JSONResponse({"detail": "invalid session id"}, status_code=400)
        try:
            profile, state_db = _profile_state_db((payload or {}).get("profile") or "default")
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        if not resolve_resume_session_id(state_db, sid):
            return JSONResponse({"detail": "session not found for profile"}, status_code=404)

        ok, err = await asyncio.to_thread(_hermes_sessions_delete, sid, profile)
        if not ok:
            return JSONResponse(
                {
                    "detail": "failed to delete session",
                    "error": err,
                },
                status_code=500,
            )

        # Best-effort cleanup: remove any custom title overlay.
        try:
            delete_title(config.meta_db_path, session_id=sid)
        except Exception:
            logger.warning("failed to delete title from meta DB for session %s", sid, exc_info=True)
            pass

        return {"ok": True, "session_id": sid}

    @app.get("/api/search")
    async def api_search(
        q: str,
        limit: int = 20,
        offset: int = 0,
        session_id: Optional[str] = None,
        profile: str = "default",
    ):
        try:
            _, state_db = _profile_state_db(profile)
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        results = search_messages(
            state_db,
            query=q,
            limit=limit,
            offset=offset,
            session_id=session_id,
        )

        # Overlay session titles in search results.
        try:
            titles = get_titles_map(config.meta_db_path, {r.get("session_id") for r in results})
        except Exception:
            logger.debug("failed to load title overlays for search results", exc_info=True)
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
        profile: str = "default",
    ):
        try:
            _, state_db = _profile_state_db(profile)
        except ValueError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        ctx = get_message_context(state_db, message_id=message_id, before=before, after=after)
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

    @app.websocket("/ws/pet-events-pub")
    async def ws_pet_events_pub(
        websocket: WebSocket,
        token: str = "",
        channel: str = "",
    ):
        if not _websocket_origin_allowed(websocket, allow_missing=True):
            await websocket.close(code=1008)
            return
        if not _pet_sidecar_token_valid(token, channel):
            await websocket.close(code=1008)
            return
        if not pet_sidecar_channel_re.match(str(channel or "")):
            await websocket.close(code=1008)
            return

        # This endpoint is a process-local capability URL handed only to the
        # spawned Hermes TUI child. Do not apply the browser/UI IP allowlist here:
        # when built-in TLS requires a public DNS name for hostname verification,
        # the same-machine child callback can arrive via that public/LAN address
        # instead of loopback. The unguessable token + channel gate is the auth.
        await websocket.accept()
        try:
            while True:
                raw = await websocket.receive_text()
                payload = _normalise_pet_event_frame(raw)
                if payload is not None:
                    await _broadcast_pet_event(str(channel), payload)
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.debug("pet event publisher ended", exc_info=True)
            pass

    @app.websocket("/ws/fleet/agents/{agent_id}/attach")
    async def ws_fleet_agent_attach(
        websocket: WebSocket,
        agent_id: str,
        cols: int = 120,
        rows: int = 30,
    ):
        if await _reject_unavailable_fleet_websocket(websocket):
            return
        if not _websocket_origin_allowed(websocket):
            await websocket.close(code=1008)
            return
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

        # Security boundary: Fleet agent metadata is node-controlled and may contain
        # arbitrary dashboard addresses and credentials. Never connect or relay a
        # credential to such an address. Remote terminals must use the central-
        # mediated /nodes/{node}/runtimes/{runtime}/attach path instead.
        try:
            await websocket.send_bytes(
                b"\r\n\x1b[31mlegacy Fleet dashboard attach is disabled; start or select a managed Fleet runtime\x1b[0m\r\n"
            )
        finally:
            await websocket.close(code=1008)
        return



    @app.websocket("/ws/fleet/nodes/{node}/runtimes/{runtime_id}/attach")
    async def ws_fleet_node_runtime_attach(
        websocket: WebSocket,
        node: str,
        runtime_id: str,
        cols: int = 120,
        rows: int = 30,
    ):
        if await _reject_unavailable_fleet_websocket(websocket):
            return
        if not _websocket_origin_allowed(websocket):
            await websocket.close(code=1008)
            return
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

        browser_session_token = extract_cookie_value(websocket.headers.get("cookie", ""), cookie_name)
        if auth_enabled and not _is_authenticated(browser_session_token):
            await websocket.close(code=1008)
            return

        base_url = fleet_settings.base_url
        safe_node = quote(str(node or "").strip(), safe="")
        safe_runtime = quote(str(runtime_id or "").strip(), safe="")
        if not base_url or not safe_node or not safe_runtime:
            try:
                await websocket.send_bytes(b"\r\n\x1b[31mremote fleet runtime unavailable\x1b[0m\r\n")
            except Exception:
                pass
            await websocket.close(code=1008)
            return

        parsed = urlparse(base_url)
        ws_scheme = "wss" if parsed.scheme == "https" else "ws"
        query = f"cols={max(10, int(cols or 120))}&rows={max(5, int(rows or 30))}"
        expected_attach_path = f"{FLEET_API_PREFIX}/nodes/{safe_node}/runtimes/{safe_runtime}/attach"
        fleet_token = fleet_bridge_token(config)
        if not fleet_token:
            try:
                await websocket.send_bytes(b"\r\n\x1b[31mFleet service credential is not configured\x1b[0m\r\n")
            finally:
                await websocket.close(code=1011)
            return
        session_material = browser_session_token or f"unauthenticated:{client_ip}"
        session_binding = hashlib.sha256(session_material.encode("utf-8", errors="replace")).hexdigest()
        ticket_url = f"{base_url.rstrip('/')}{expected_attach_path}-ticket"
        try:
            fleet_client = getattr(app.state, "fleet_http_client", None)
            if fleet_client is None:
                raise RuntimeError("Fleet HTTP client is unavailable")
            ticket_response = await fleet_client.request(
                "POST",
                ticket_url,
                headers={"Authorization": f"Bearer {fleet_token}"},
                json={"user_id": "hermelin-browser", "session_id": session_binding},
            )
            if ticket_response.status_code != 201:
                raise RuntimeError(f"Fleet attach ticket request failed ({ticket_response.status_code})")
            ticket_payload = ticket_response.json()
            attach_ticket = str(ticket_payload.get("ticket") or "").strip()
            attach_path = str(ticket_payload.get("attach_path") or "").strip()
            if not attach_ticket or attach_path != expected_attach_path:
                raise RuntimeError("Fleet returned an invalid attach ticket binding")
        except Exception as exc:
            try:
                await websocket.send_bytes(f"\r\n\x1b[31m{exc}\x1b[0m\r\n".encode("utf-8", errors="replace"))
            finally:
                await websocket.close(code=1011)
            return
        upstream_url = f"{ws_scheme}://{parsed.netloc}{expected_attach_path}?{query}"
        headers = {
            "Authorization": f"Bearer {attach_ticket}",
            "X-Fleet-Attach-User-ID": "hermelin-browser",
            "X-Fleet-Attach-Session-ID": session_binding,
        }

        writer = WebSocketPriorityWriter(websocket, max_droppable_backlog=2)
        writer_task = asyncio.create_task(writer.run())

        async def _send_terminal_error(message: str, *, code: int = 1011) -> None:
            raw = str(message or "remote fleet runtime attach failed")
            raw = raw.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
            try:
                await writer.send_bytes(f"\x1b[31m{raw}\x1b[0m\r\n".encode("utf-8", errors="replace"), priority=0)
            except Exception:
                pass
            try:
                await writer.stop()
            except Exception:
                writer_task.cancel()
            if not writer_task.done():
                try:
                    await asyncio.wait_for(writer_task, timeout=2.0)
                except Exception:
                    writer_task.cancel()
            try:
                await websocket.close(code=code)
            except Exception:
                pass

        try:
            async with websockets.connect(
                upstream_url,
                additional_headers=headers or None,
                max_size=_FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES,
                max_queue=4,
                proxy=None,
                ssl=getattr(app.state, "fleet_ssl_context", None) if ws_scheme == "wss" else None,
            ) as upstream:
                async def _upstream_to_browser() -> None:
                    async for message in upstream:
                        if _fleet_runtime_attach_frame_size(message) > _FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES:
                            await websocket.close(code=1009)
                            return
                        if isinstance(message, bytes):
                            await writer.send_bytes(message, priority=0)
                        else:
                            await writer.send_text(str(message), priority=0)

                async def _browser_to_upstream() -> None:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break
                        raw = msg.get("bytes")
                        if raw is not None:
                            if _fleet_runtime_attach_frame_size(raw) > _FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES:
                                await websocket.close(code=1009)
                                return
                            if raw:
                                await upstream.send(raw)
                            continue
                        text = msg.get("text")
                        if isinstance(text, str) and text:
                            if _fleet_runtime_attach_frame_size(text) > _FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES:
                                await websocket.close(code=1009)
                                return
                            await upstream.send(text)

                upstream_task = asyncio.create_task(_upstream_to_browser())
                browser_task = asyncio.create_task(_browser_to_upstream())
                try:
                    await asyncio.wait({upstream_task, browser_task, writer_task}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in (upstream_task, browser_task):
                        if not task.done():
                            task.cancel()
        except Exception as exc:
            await _send_terminal_error(f"Remote Fleet tmux runtime connection failed: {exc}")
            return
        finally:
            try:
                await writer.stop()
            except Exception:
                writer_task.cancel()
            if not writer_task.done():
                try:
                    await asyncio.wait_for(writer_task, timeout=2.0)
                except Exception:
                    writer_task.cancel()
            try:
                await websocket.close()
            except Exception:
                pass
        return


    @app.websocket("/ws/runtimes/{runtime_id}/attach")
    async def ws_runtime_attach(
        websocket: WebSocket,
        runtime_id: str,
        cols: int = 120,
        rows: int = 30,
    ):
        if not _websocket_origin_allowed(websocket):
            await websocket.close(code=1008)
            return
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

        record = runtime_registry.get_runtime(runtime_id)
        if not record or record.state == "stopped":
            await websocket.close(code=1008)
            return
        if record.backend != "tmux":
            await websocket.close(code=1008)
            return

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
        cols = max(10, int(cols or 120))
        rows = max(5, int(rows or 30))
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
            prefetched = []

        backend = TmuxRuntimeBackend(prefix=config.runtime_tmux_prefix)
        try:
            p = backend.attach_process(record, cols=init_cols, rows=init_rows)
        except Exception as exc:
            hint = f"\r\n\x1b[31mUnable to attach runtime {runtime_id}: {exc}\x1b[0m\r\n"
            try:
                await websocket.send_bytes(hint.encode("utf-8", errors="replace"))
            except Exception:
                pass
            try:
                await websocket.close(code=1011)
            except Exception:
                pass
            return

        try:
            runtime_registry.update_runtime(runtime_id, last_attached_at=utc_ts(), metadata={**(record.metadata or {}), "attached": True})
            runtime_registry.remember_last_active(runtime_id)
        except Exception:
            pass

        writer = WebSocketPriorityWriter(websocket, max_droppable_backlog=2)
        pet_event_channel = str((record.metadata or {}).get("pet_event_channel") or "")

        def _runtime_artifact_snapshot() -> dict[str, dict]:
            items = list_artifacts(config.artifact_dir, hermes_home=config.hermes_home)
            out: dict[str, dict] = {}
            for item in items:
                if not isinstance(item, dict):
                    continue
                artifact_id = item.get("id")
                if artifact_id:
                    out[str(artifact_id)] = item
            return out

        def _runtime_artifact_changed(prev: dict | None, curr: dict) -> bool:
            if not isinstance(prev, dict):
                return True
            for key in ("timestamp", "updated_at", "live", "persistent", "refresh_seconds", "runner_active", "runner_status"):
                if prev.get(key) != curr.get(key):
                    return True
            return False

        def _runtime_artifact_list_payload(snapshot: dict[str, dict]) -> str:
            payload = sorted(snapshot.values(), key=lambda item: float(item.get("timestamp") or 0.0), reverse=True)
            return json.dumps({"type": "artifact_list", "payload": payload}, ensure_ascii=False)

        def _runtime_artifact_payload(item: dict) -> str:
            return json.dumps({"type": "artifact", "payload": item}, ensure_ascii=False)

        async def pump_runtime_artifacts_to_ws() -> None:
            async def _load_snapshot() -> dict[str, dict]:
                return await asyncio.to_thread(_runtime_artifact_snapshot)

            try:
                initial = await _load_snapshot()
                previous: dict[str, dict] = {}
                if initial:
                    if await writer.send_text(_runtime_artifact_list_payload(initial), priority=20, droppable=True):
                        previous = initial

                close_signal_path = config.artifact_dir / "_close_signal.json"
                focus_signal_path = config.artifact_dir / "_focus.json"
                close_signal_seen_ns = 0
                focus_signal_seen_ns = 0
                bridge_commands_dir = artifact_bridge_commands_dir(config.artifact_dir)

                while True:
                    await asyncio.sleep(0.75)
                    current = await _load_snapshot()

                    try:
                        ns = close_signal_path.stat().st_mtime_ns
                        if ns and ns != close_signal_seen_ns:
                            close_signal_seen_ns = ns
                            try:
                                sig = json.loads(close_signal_path.read_text(encoding="utf-8"))
                            except Exception:
                                sig = None
                            if isinstance(sig, dict) and sig.get("action") == "close_all":
                                await writer.send_text(json.dumps({"type": "artifact_close", "payload": sig}, ensure_ascii=False), priority=5, droppable=False)
                    except FileNotFoundError:
                        pass
                    except Exception:
                        pass

                    try:
                        ns = focus_signal_path.stat().st_mtime_ns
                        if ns and ns != focus_signal_seen_ns:
                            focus_signal_seen_ns = ns
                            try:
                                sig = json.loads(focus_signal_path.read_text(encoding="utf-8"))
                            except Exception:
                                sig = None
                            if isinstance(sig, dict) and sig.get("action") == "focus" and sig.get("tab_id"):
                                await writer.send_text(json.dumps({"type": "artifact_focus", "payload": sig}, ensure_ascii=False), priority=5, droppable=False)
                                try:
                                    focus_signal_path.unlink()
                                    focus_signal_seen_ns = 0
                                except Exception:
                                    pass
                    except FileNotFoundError:
                        focus_signal_seen_ns = 0
                    except Exception:
                        pass

                    try:
                        for cmd_path in sorted(bridge_commands_dir.glob("*.json"), key=lambda path: path.name):
                            if not cmd_path.is_file():
                                continue
                            try:
                                cmd = json.loads(cmd_path.read_text(encoding="utf-8"))
                            except Exception:
                                cmd = None
                            if isinstance(cmd, dict):
                                await writer.send_text(json.dumps({"type": "artifact_bridge_command", "payload": cmd}, ensure_ascii=False), priority=5, droppable=False)
                            try:
                                cmd_path.unlink()
                            except Exception:
                                pass
                    except Exception:
                        pass

                    for artifact_id in sorted(previous.keys() - current.keys()):
                        await writer.send_text(json.dumps({"type": "artifact_close", "payload": {"id": artifact_id}}, ensure_ascii=False), priority=5, droppable=False)
                        previous.pop(artifact_id, None)

                    changed_ids = [artifact_id for artifact_id, item in current.items() if artifact_id not in previous or _runtime_artifact_changed(previous.get(artifact_id), item)]
                    changed_ids.sort(key=lambda artifact_id: float(current[artifact_id].get("timestamp") or 0.0))
                    for artifact_id in changed_ids:
                        if await writer.send_text(_runtime_artifact_payload(current[artifact_id]), priority=20, droppable=True):
                            previous[artifact_id] = current[artifact_id]
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("pump_runtime_artifacts_to_ws failed", exc_info=True)

        async def pump_runtime_pet_events_to_ws() -> None:
            if not pet_event_channel or not pet_sidecar_channel_re.match(pet_event_channel):
                return
            queue: asyncio.Queue[str] = asyncio.Queue(maxsize=512)
            channels, _, lock = _pet_event_state()
            async with lock:
                channels.setdefault(pet_event_channel, set()).add(queue)
            try:
                await writer.send_text(
                    json.dumps({"type": "pet_sync", "payload": {"mode": "structured", "source": "runtime-sidecar"}}, ensure_ascii=False),
                    priority=5,
                    droppable=False,
                )
                cached_payload = await _last_pet_event(pet_event_channel)
                if cached_payload:
                    if not await writer.send_text(cached_payload, priority=5, droppable=False):
                        return
                while True:
                    payload = await queue.get()
                    if not await writer.send_text(payload, priority=5, droppable=False):
                        break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("pump runtime pet events ended", exc_info=True)
            finally:
                try:
                    channels, _, lock = _pet_event_state()
                    async with lock:
                        queues = channels.get(pet_event_channel)
                        if queues is not None:
                            queues.discard(queue)
                            if not queues:
                                channels.pop(pet_event_channel, None)
                except Exception:
                    pass

        def _handle_runtime_ws_message(msg: dict) -> bool:
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
                # Signals here target only the tmux attach wrapper, not the
                # underlying persistent Hermes runtime. Explicit stop is a
                # separate authenticated POST /api/runtimes/{id}/stop action.
                if sig in {"INT", "TERM", "HUP", "QUIT"}:
                    try:
                        os.killpg(p.proc.pid, getattr(signal, f"SIG{sig}"))
                    except Exception:
                        pass
                elif sig == "KILL":
                    p.kill()
                return True
            return True

        for msg in prefetched:
            try:
                if not _handle_runtime_ws_message(msg):
                    break
            except Exception:
                pass

        async def pump_attach_to_ws() -> None:
            try:
                while True:
                    data = await asyncio.to_thread(os.read, p.master_fd, 8192)
                    if not data:
                        break
                    if not await writer.send_bytes(data, priority=0):
                        break
            except Exception:
                logger.debug("pump runtime attach to ws ended", exc_info=True)

        async def pump_ws_to_attach() -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if not _handle_runtime_ws_message(msg):
                        break
            except Exception:
                logger.debug("pump ws to runtime attach ended", exc_info=True)

        t1 = asyncio.create_task(pump_attach_to_ws())
        t2 = asyncio.create_task(pump_ws_to_attach())
        t3 = asyncio.create_task(pump_runtime_artifacts_to_ws())
        t4 = asyncio.create_task(pump_runtime_pet_events_to_ws())
        writer_task = asyncio.create_task(writer.run())
        try:
            await asyncio.wait({t1, t2, writer_task}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            try:
                for task in (t1, t2, t3, t4):
                    if not task.done():
                        task.cancel()
                for task in (t3, t4):
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        pass
                try:
                    await writer.stop()
                except Exception:
                    writer_task.cancel()
                if not writer_task.done():
                    try:
                        await asyncio.wait_for(writer_task, timeout=2.0)
                    except Exception:
                        writer_task.cancel()
            finally:
                p.terminate()
                p.close_fds()
                try:
                    current = runtime_registry.get_runtime(runtime_id)
                    if current:
                        runtime_registry.update_runtime(runtime_id, metadata={**(current.metadata or {}), "attached": False}, last_seen_at=utc_ts())
                except Exception:
                    pass
                try:
                    await websocket.close()
                except Exception:
                    pass

    @app.websocket("/ws/pty")
    async def ws_pty(
        websocket: WebSocket,
        resume: Optional[str] = None,
        cont: bool = Query(False, alias="continue"),
        cols: int = 120,
        rows: int = 30,
        clear_session_artifacts: bool = Query(False),
        profile: str = "default",
    ):
        if not _websocket_origin_allowed(websocket):
            await websocket.close(code=1008)
            return
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

        try:
            selected_profile, state_db = _profile_state_db(profile)
        except ValueError:
            await websocket.close(code=1008)
            return

        argv = _with_hermes_profile_args(shlex.split(_get_effective_hermes_cmd()), selected_profile)

        # -------------------------------------------------------------
        # hermelinChat UI theme -> Hermes CLI skin (upstream skin system)
        # -------------------------------------------------------------
        # Hermes reads the active skin from ~/.hermes/config.yaml (display.skin).
        # There is no per-launch CLI flag, so we sync the skin before spawning Hermes.
        ui_theme = ""
        try:
            ui_theme = (websocket.query_params.get("ui_theme") or "").strip()
        except Exception:
            ui_theme = ""

        skin_name: str | None = None
        if ui_theme == "hermelin":
            skin_name = "hermelin"
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

        safe_resume = resolve_resume_session_id(state_db, resume) if resume else None
        if resume and not safe_resume:
            await websocket.close(code=1008)
            return

        if safe_resume:
            argv += ["--resume", safe_resume]
        elif cont:
            argv += ["--continue"]

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        env.setdefault("PYTHONUNBUFFERED", "1")
        env.setdefault("HERMES_HOME", str(config.hermes_home))

        if argv and Path(argv[0]).name == "hermes":
            argv[0] = _resolve_hermes_executable(argv[0], env)

        # Avoid surprising overrides: hermes' runtime CLI prioritizes env vars
        # (and loads ~/.hermes/.env via dotenv). We want config.yaml/.env to be
        # the source of truth, not the environment hermelinChat was launched with.
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
            # TIOCGWINSZ width/height. If hermelinChat was started from a wide
            # local terminal (e.g. 160 cols) and the shell exported COLUMNS,
            # Hermes/Rich will render as if it had that width regardless of the
            # real xterm.js viewport. We must drop them so Rich reads from the
            # PTY.
            "COLUMNS",
            "LINES",
        ):
            env.pop(k, None)

        # Browser xterm renders terminal pets as Unicode half-blocks. HermelinChat
        # draws the selected pet as a crisp canvas overlay instead, so hide the
        # subprocess pet through a child-only Hermes managed scope. This preserves
        # the user's real config and any inherited managed policy.
        if "hermes" in exe_name and not _env_flag_default("HERMELIN_PTY_PET_ENABLED", False):
            pty_managed_dir = _prepare_pty_managed_scope(config, env)
            if pty_managed_dir is not None:
                env["HERMES_MANAGED_DIR"] = str(pty_managed_dir)

        pet_event_channel = _new_pet_event_channel()
        pet_sidecar_url = _build_pet_sidecar_url(pet_event_channel) if _command_supports_pet_sidecar(argv) else None
        if pet_sidecar_url:
            _prepare_pet_sidecar_tls_env(env)
            env["HERMES_TUI_SIDECAR_URL"] = pet_sidecar_url

        # -------------------------------------------------------------
        # Optional session-scoped artifact cleanup
        # -------------------------------------------------------------
        # Opening hermelinChat in another browser or refreshing the app starts a
        # fresh PTY websocket without a resume id. That should not silently wipe
        # non-persistent artifacts from the shared backend instance. Keep cleanup
        # as an explicit opt-in for callers that really want to clear transient
        # artifact state.
        if clear_session_artifacts and not resume and not cont:
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
                        if not list_artifacts(config.artifact_dir, hermes_home=config.hermes_home):
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
                logger.warning("session artifact cleanup failed", exc_info=True)
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

        logger.info("spawning PTY cols=%d rows=%d (query cols=%d rows=%d)", init_cols, init_rows, cols, rows)

        # Ensure the spawn cwd exists (default is ~/.hermes/artifacts/runners/projects).
        try:
            config.spawn_cwd.mkdir(parents=True, exist_ok=True)
        except Exception:
            logger.warning("failed to create spawn cwd %s", config.spawn_cwd, exc_info=True)
            pass

        try:
            p = PtyProcess.spawn(argv, cwd=config.spawn_cwd, env=env, cols=init_cols, rows=init_rows)
        except FileNotFoundError:
            missing = argv[0] if argv else "hermes"
            hint = (
                f"\r\n\x1b[31mUnable to start Hermes: executable not found: {missing}\x1b[0m\r\n"
                "Set HERMELIN_HERMES_CMD to the absolute Hermes path or ensure ~/.local/bin is on the service PATH.\r\n"
            )
            try:
                await websocket.send_bytes(hint.encode("utf-8", errors="replace"))
            except Exception:
                pass
            try:
                await websocket.close(code=1011)
            except Exception:
                pass
            return

        def _artifact_snapshot() -> dict[str, dict]:
            items = list_artifacts(config.artifact_dir, hermes_home=config.hermes_home)
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
            if prev_updated != curr_updated:
                return True
            for key in (
                "live",
                "persistent",
                "refresh_seconds",
                "runner_active",
                "runner_status",
            ):
                if prev.get(key) != curr.get(key):
                    return True
            return False

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

        writer = WebSocketPriorityWriter(websocket, max_droppable_backlog=2)

        async def pump_pty_to_ws() -> None:
            try:
                while True:
                    data = await asyncio.to_thread(os.read, p.master_fd, 8192)
                    if not data:
                        break
                    if not await writer.send_bytes(data, priority=0):
                        break
            except Exception:
                # WebSocket closed, PTY died, etc.
                logger.debug("pump_pty_to_ws ended", exc_info=True)
                pass

        async def pump_ws_to_pty() -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if not _handle_ws_message(msg):
                        break
            except Exception:
                logger.debug("pump_ws_to_pty ended", exc_info=True)
                pass

        async def pump_artifacts_to_ws() -> None:
            async def _load_snapshot() -> dict[str, dict]:
                return await asyncio.to_thread(_artifact_snapshot)

            async def _send_control(payload: str) -> bool:
                return await writer.send_text(payload, priority=5, droppable=False)

            async def _send_artifact(payload: str) -> bool:
                return await writer.send_text(payload, priority=20, droppable=True)

            try:
                initial = await _load_snapshot()
                previous: dict[str, dict] = {}
                if initial:
                    if await _send_artifact(_artifact_list_payload(initial)):
                        previous = initial

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
                    current = await _load_snapshot()

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
                                await _send_control(json.dumps({"type": "artifact_close", "payload": sig}, ensure_ascii=False))
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
                                    await _send_control(
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
                                await _send_control(
                                    json.dumps({"type": "artifact_bridge_command", "payload": cmd}, ensure_ascii=False)
                                )
                            try:
                                cmd_path.unlink()
                            except Exception:
                                pass
                    except Exception:
                        pass

                    for artifact_id in sorted(previous.keys() - current.keys()):
                        await _send_control(_artifact_close_payload(artifact_id))
                        previous.pop(artifact_id, None)

                    changed_ids = [
                        artifact_id
                        for artifact_id, item in current.items()
                        if artifact_id not in previous or _artifact_changed(previous.get(artifact_id), item)
                    ]
                    changed_ids.sort(key=lambda artifact_id: float(current[artifact_id].get("timestamp") or 0.0))

                    for artifact_id in changed_ids:
                        if await _send_artifact(_artifact_payload(current[artifact_id])):
                            previous[artifact_id] = current[artifact_id]
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("pump_artifacts_to_ws failed", exc_info=True)
                pass

        async def pump_pet_events_to_ws() -> None:
            if not pet_sidecar_url:
                return

            queue: asyncio.Queue[str] = asyncio.Queue(maxsize=512)
            channels, _, lock = _pet_event_state()
            async with lock:
                channels.setdefault(pet_event_channel, set()).add(queue)

            try:
                await writer.send_text(
                    json.dumps(
                        {
                            "type": "pet_sync",
                            "payload": {"mode": "structured", "source": "tui-sidecar"},
                        },
                        ensure_ascii=False,
                    ),
                    priority=5,
                    droppable=False,
                )
                cached_payload = await _last_pet_event(pet_event_channel)
                if cached_payload:
                    if not await writer.send_text(cached_payload, priority=5, droppable=False):
                        return
                while True:
                    payload = await queue.get()
                    # Pet state is control-plane truth, not cosmetic artifact data.
                    # Dropping a tool/message lifecycle event leaves the browser
                    # overlay pinned on the last state (commonly `run`), so these
                    # frames must be non-droppable just like pet_sync/artifact_close.
                    if not await writer.send_text(payload, priority=5, droppable=False):
                        break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("pump_pet_events_to_ws ended", exc_info=True)
                pass
            finally:
                try:
                    channels, _, lock = _pet_event_state()
                    async with lock:
                        queues = channels.get(pet_event_channel)
                        if queues is not None:
                            queues.discard(queue)
                            if not queues:
                                channels.pop(pet_event_channel, None)
                except Exception:
                    pass

        t1 = asyncio.create_task(pump_pty_to_ws())
        t2 = asyncio.create_task(pump_ws_to_pty())
        t3 = asyncio.create_task(pump_artifacts_to_ws())
        t4 = asyncio.create_task(pump_pet_events_to_ws())
        writer_task = asyncio.create_task(writer.run())

        try:
            await asyncio.wait({t1, t2, writer_task}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            try:
                t3.cancel()
                t4.cancel()
                for task in (t1, t2):
                    if not task.done():
                        task.cancel()

                for task in (t3, t4):
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        pass

                try:
                    await writer.stop()
                except asyncio.CancelledError:
                    writer_task.cancel()
                except Exception:
                    pass

                if not writer_task.done():
                    try:
                        await asyncio.wait_for(writer_task, timeout=2.0)
                    except asyncio.TimeoutError:
                        writer_task.cancel()
                        try:
                            await writer_task
                        except asyncio.CancelledError:
                            pass
                        except Exception:
                            pass
                    except asyncio.CancelledError:
                        writer_task.cancel()
                    except Exception:
                        pass
                else:
                    try:
                        await writer_task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        pass
            finally:
                # Ensure subprocess is gone and fds are closed even if websocket task
                # cancellation interrupts the pumps while the client disconnects.
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
            try:
                if not candidate.resolve().is_relative_to(static_dir.resolve()):
                    return FileResponse(index_html)
            except (ValueError, OSError):
                return FileResponse(index_html)
            if candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index_html)

    return app
