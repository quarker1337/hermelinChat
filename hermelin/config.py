from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "y", "on"}


_DEFAULT_HERMES_HOME = Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
_DEFAULT_META_DB = _DEFAULT_HERMES_HOME / "hermelin_meta.db"
_DEFAULT_SPAWN_CWD = _DEFAULT_HERMES_HOME / "artifacts" / "runners" / "projects"
DEFAULT_HERMELIN_HERMES_CMD = 'hermes chat --toolsets "hermes-cli, artifacts"'
DEFAULT_HERMES_DASHBOARD_BASE_PATH = "/api/runners/hermes-dashboard"


@dataclass(frozen=True)
class HermelinConfig:
    host: str = os.getenv("HERMELIN_HOST", "127.0.0.1")
    port: int = int(os.getenv("HERMELIN_PORT", "3000"))

    # What to spawn inside the PTY
    # Examples:
    #   hermes
    #   /usr/local/bin/hermes
    #   hermes chat --toolsets "hermes-cli, artifacts, strudel"
    hermes_cmd: str = os.getenv(
        "HERMELIN_HERMES_CMD",
        DEFAULT_HERMELIN_HERMES_CMD,
    )
    hermes_cmd_override: bool = _env_bool("HERMELIN_HERMES_CMD_OVERRIDE", "0") and bool(
        os.getenv("HERMELIN_HERMES_CMD", "").strip()
    )

    # Hermes Agent home (contains state.db, config.yaml, etc.)
    hermes_home: Path = _DEFAULT_HERMES_HOME

    # hermelinChat metadata DB (titles, etc.)
    meta_db_path: Path = Path(os.getenv("HERMELIN_META_DB_PATH", str(_DEFAULT_META_DB))).expanduser()

    # Working directory to run the hermes CLI in.
    # Default: a safe scratch workspace under ~/.hermes so Hermes doesn't create
    # ad-hoc files inside whatever git repo hermelinChat was launched from.
    #
    # Override with HERMELIN_SPAWN_CWD if you want a different workspace.
    spawn_cwd: Path = Path(os.getenv("HERMELIN_SPAWN_CWD", str(_DEFAULT_SPAWN_CWD))).expanduser()

    # CORS (optional): comma-separated browser origins allowed for cross-origin requests.
    # Default is disabled (same-origin UI does not need CORS).
    # Example: https://chat.example.com,http://localhost:5173
    cors_origins: str = os.getenv("HERMELIN_CORS_ORIGINS", "").strip()

    # Security:
    # Comma-separated allowlist of IPs/CIDRs that can access HTTP + WebSocket.
    # Default is localhost-only.
    # Example: "87.159.61.45,127.0.0.1,::1"
    allowed_ips: str = os.getenv("HERMELIN_ALLOWED_IPS", "127.0.0.1,::1")

    # App password auth (recommended if not localhost-only). If not set, auth is disabled.
    # Store only a hash in env (HERMELIN_PASSWORD_HASH). Without TLS, the password can
    # still be sniffed on the network during login.
    auth_password_hash: str = os.getenv("HERMELIN_PASSWORD_HASH", "")

    # Session cookie signing secret (optional). If unset, a random secret is generated at boot
    # which invalidates sessions on restart.
    cookie_secret: str = os.getenv("HERMELIN_COOKIE_SECRET", "")

    session_ttl_seconds: int = int(os.getenv("HERMELIN_SESSION_TTL_SECONDS", "43200"))  # 12h
    cookie_name: str = os.getenv("HERMELIN_SESSION_COOKIE", "hermelin_session")

    # Runner gateway tokens (for sandboxed iframes). These tokens are embedded in the
    # runner proxy URL path so the iframe can authenticate without cookies.
    runner_token_ttl_seconds: int = int(os.getenv("HERMELIN_RUNNER_TOKEN_TTL_SECONDS", "1800"))  # 30m
    runner_token_bind_ip: bool = _env_bool("HERMELIN_RUNNER_TOKEN_BIND_IP", "1")

    # Native Hermes Agent dashboard integration. hermelinChat starts the dashboard
    # on loopback only and exposes it through the authenticated same-origin proxy.
    hermes_dashboard_enabled: bool = _env_bool("HERMELIN_HERMES_DASHBOARD_ENABLED", "1")
    hermes_dashboard_cmd: str = os.getenv("HERMELIN_HERMES_DASHBOARD_CMD", "").strip()
    hermes_dashboard_port: int = int(os.getenv("HERMELIN_HERMES_DASHBOARD_PORT", "0") or "0")
    hermes_dashboard_tui: bool = _env_bool("HERMELIN_HERMES_DASHBOARD_TUI", "0")
    hermes_dashboard_base_path: str = os.getenv(
        "HERMELIN_HERMES_DASHBOARD_BASE_PATH",
        DEFAULT_HERMES_DASHBOARD_BASE_PATH,
    ).strip() or DEFAULT_HERMES_DASHBOARD_BASE_PATH
    hermes_dashboard_startup_timeout_seconds: float = float(
        os.getenv("HERMELIN_HERMES_DASHBOARD_STARTUP_TIMEOUT_SECONDS", "20") or "20"
    )

    # Only enable this if running behind a trusted reverse proxy.
    trust_x_forwarded_for: bool = _env_bool("HERMELIN_TRUST_X_FORWARDED_FOR", "0")

    # If set, only trust X-Forwarded-For / X-Real-IP when the immediate socket peer
    # (request.client.host) is inside this allowlist.
    trusted_proxy_ips: str = os.getenv("HERMELIN_TRUSTED_PROXY_IPS", "").strip()

    # Set to 1 if serving over HTTPS (or behind a TLS-terminating proxy that preserves scheme)
    cookie_secure: bool = _env_bool("HERMELIN_COOKIE_SECURE", "0")

    # Built-in TLS (served directly by uvicorn). If both are set, hermelinChat will
    # serve HTTPS (not just "behind a reverse proxy").
    ssl_certfile: str = os.getenv("HERMELIN_SSL_CERTFILE", "").strip()
    ssl_keyfile: str = os.getenv("HERMELIN_SSL_KEYFILE", "").strip()

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
