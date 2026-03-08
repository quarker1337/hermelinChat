from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "y", "on"}


_DEFAULT_HERMES_HOME = Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
_DEFAULT_META_DB = _DEFAULT_HERMES_HOME / "hermilin_meta.db"


@dataclass(frozen=True)
class HermelinConfig:
    host: str = os.getenv("HERMELIN_HOST", "127.0.0.1")
    port: int = int(os.getenv("HERMELIN_PORT", "3000"))

    # What to spawn inside the PTY
    # Examples:
    #   hermes
    #   /usr/local/bin/hermes
    hermes_cmd: str = os.getenv(
        "HERMELIN_HERMES_CMD",
        'hermes chat --toolsets "hermes-cli, artifacts"',
    )

    # Hermes Agent home (contains state.db, config.yaml, etc.)
    hermes_home: Path = _DEFAULT_HERMES_HOME

    # hermilinChat metadata DB (titles, etc.)
    meta_db_path: Path = Path(os.getenv("HERMELIN_META_DB_PATH", str(_DEFAULT_META_DB))).expanduser()

    # Working directory to run the hermes CLI in.
    # Defaults to the directory hermelinChat is started from.
    spawn_cwd: Path = Path(os.getenv("HERMELIN_SPAWN_CWD", os.getcwd())).expanduser()

    # Security:
    # Comma-separated allowlist of IPs/CIDRs that can access HTTP + WebSocket.
    # Default is localhost-only.
    # Example: "87.159.61.45,127.0.0.1,::1"
    allowed_ips: str = os.getenv("HERMELIN_ALLOWED_IPS", "127.0.0.1,::1")

    # App password auth (recommended if not localhost-only). If not set, auth is disabled.
    # NOTE: Without TLS, this password can be sniffed on the network.
    auth_password: str = os.getenv("HERMELIN_PASSWORD", "")

    # Session cookie signing secret (optional). If unset, a random secret is generated at boot
    # which invalidates sessions on restart.
    cookie_secret: str = os.getenv("HERMELIN_COOKIE_SECRET", "")

    session_ttl_seconds: int = int(os.getenv("HERMELIN_SESSION_TTL_SECONDS", "43200"))  # 12h
    cookie_name: str = os.getenv("HERMELIN_SESSION_COOKIE", "hermelin_session")

    # Only enable this if running behind a trusted reverse proxy.
    trust_x_forwarded_for: bool = _env_bool("HERMELIN_TRUST_X_FORWARDED_FOR", "0")

    # Set to 1 if serving over HTTPS (or behind a TLS-terminating proxy that preserves scheme)
    cookie_secure: bool = _env_bool("HERMELIN_COOKIE_SECURE", "0")

    @property
    def db_path(self) -> Path:
        return self.hermes_home / "state.db"

    @property
    def artifact_dir(self) -> Path:
        override = os.getenv("HERMELIN_ARTIFACT_DIR", "").strip()
        if override:
            return Path(override).expanduser()
        return self.hermes_home / "artifacts"

    @property
    def static_dir(self) -> Path:
        return Path(__file__).resolve().parent / "static"
