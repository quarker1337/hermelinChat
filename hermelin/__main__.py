from __future__ import annotations

import argparse
import ipaddress
import logging
import os
import re
from pathlib import Path

import uvicorn

from .config import DEFAULT_HERMELIN_HERMES_CMD, HermelinConfig
from .server import _is_managed_hermes_command, _managed_hermes_executable, create_app


def _env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "y", "on"}


def _is_loopback_host(host: str) -> bool:
    h = (host or "").strip().lower()
    if h in {"localhost"}:
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


class _RunnerTokenFilter(logging.Filter):
    """Redact runner bearer tokens from access log lines."""
    _PATTERN = re.compile(r'(/r/[^/]+/_t/)[^\s/"]+')

    def filter(self, record: logging.LogRecord) -> bool:
        if hasattr(record, 'args') and isinstance(record.args, tuple):
            record.args = tuple(
                self._PATTERN.sub(r'\1[REDACTED]', str(a)) if isinstance(a, str) else a
                for a in record.args
            )
        elif hasattr(record, 'msg') and isinstance(record.msg, str):
            record.msg = self._PATTERN.sub(r'\1[REDACTED]', record.msg)
        return True


def main() -> None:
    p = argparse.ArgumentParser(prog="hermelin", description="hermelinChat web UI for Hermes Agent")
    p.add_argument("--host", default=os.getenv("HERMELIN_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.getenv("HERMELIN_PORT", "3000")))

    # Built-in TLS (served directly by uvicorn)
    p.add_argument(
        "--ssl-certfile",
        default=os.getenv("HERMELIN_SSL_CERTFILE", ""),
        help="Path to TLS certificate (PEM) to serve HTTPS directly",
    )
    p.add_argument(
        "--ssl-keyfile",
        default=os.getenv("HERMELIN_SSL_KEYFILE", ""),
        help="Path to TLS private key (PEM) to serve HTTPS directly",
    )
    p.add_argument(
        "--allow-insecure-http",
        action="store_true",
        default=_env_bool("HERMELIN_ALLOW_INSECURE_HTTP", "0"),
        help="Allow serving HTTP without TLS on non-localhost (NOT recommended)",
    )
    p.add_argument(
        "--hermes-cmd",
        default=None,
        help='Hermes command to spawn (advanced override; default is managed from settings)',
    )
    p.add_argument("--hermes-home", default=os.getenv("HERMES_HOME", str(Path.home() / ".hermes")))
    p.add_argument("--spawn-cwd", default=os.getenv("HERMELIN_SPAWN_CWD", os.getcwd()))
    p.add_argument(
        "--meta-db",
        default=os.getenv(
            "HERMELIN_META_DB_PATH",
            str(Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))) / "hermelin_meta.db"),
        ),
        help="Path to hermelinChat metadata DB (titles, etc.). Default: $HERMES_HOME/hermelin_meta.db",
    )

    p.add_argument(
        "--allowed-ips",
        default=os.getenv("HERMELIN_ALLOWED_IPS", "127.0.0.1,::1"),
        help="Comma-separated IPs/CIDRs allowed to access the UI (default: localhost only). Use '*' to allow all.",
    )
    p.add_argument(
        "--trust-xff",
        action="store_true",
        default=_env_bool("HERMELIN_TRUST_X_FORWARDED_FOR", "0"),
        help="Trust X-Forwarded-For / X-Real-IP (ONLY behind a trusted reverse proxy).",
    )

    p.add_argument("--reload", action="store_true", help="Auto-reload server on code changes (dev)")

    args = p.parse_args()

    env_hermes_cmd = os.getenv("HERMELIN_HERMES_CMD", "").strip()
    env_cmd_override = _env_bool("HERMELIN_HERMES_CMD_OVERRIDE", "0")
    env_hermes_cmd_override = bool(env_hermes_cmd) and (env_cmd_override or not _is_managed_hermes_command(env_hermes_cmd))
    hermes_cmd_override = args.hermes_cmd is not None or env_hermes_cmd_override
    hermes_cmd = str(args.hermes_cmd if args.hermes_cmd is not None else (env_hermes_cmd or DEFAULT_HERMELIN_HERMES_CMD))

    if args.reload:
        # Uvicorn reload requires an import string. We pass config via env.
        os.environ["HERMELIN_HOST"] = str(args.host)
        os.environ["HERMELIN_PORT"] = str(args.port)
        if hermes_cmd_override:
            os.environ["HERMELIN_HERMES_CMD"] = hermes_cmd
            os.environ["HERMELIN_HERMES_CMD_OVERRIDE"] = "1"
        elif _is_managed_hermes_command(hermes_cmd) and _managed_hermes_executable(hermes_cmd) != "hermes":
            os.environ["HERMELIN_HERMES_CMD"] = hermes_cmd
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
        else:
            os.environ.pop("HERMELIN_HERMES_CMD", None)
            os.environ.pop("HERMELIN_HERMES_CMD_OVERRIDE", None)
        os.environ["HERMES_HOME"] = str(args.hermes_home)
        os.environ["HERMELIN_SPAWN_CWD"] = str(args.spawn_cwd)
        os.environ["HERMELIN_META_DB_PATH"] = str(args.meta_db)
        os.environ["HERMELIN_ALLOWED_IPS"] = str(args.allowed_ips)
        os.environ["HERMELIN_TRUST_X_FORWARDED_FOR"] = "1" if args.trust_xff else "0"
        os.environ["HERMELIN_SSL_CERTFILE"] = str(args.ssl_certfile)
        os.environ["HERMELIN_SSL_KEYFILE"] = str(args.ssl_keyfile)
        os.environ["HERMELIN_ALLOW_INSECURE_HTTP"] = "1" if args.allow_insecure_http else "0"

        ssl_certfile = str(args.ssl_certfile or "").strip() or None
        ssl_keyfile = str(args.ssl_keyfile or "").strip() or None
        if not (ssl_certfile and ssl_keyfile):
            ssl_certfile = None
            ssl_keyfile = None

        if ssl_certfile is None and ssl_keyfile is None and not args.allow_insecure_http and not _is_loopback_host(str(args.host)):
            print("ERROR: refusing to serve insecure HTTP on non-localhost without TLS")
            print("Hint: configure HERMELIN_SSL_CERTFILE/HERMELIN_SSL_KEYFILE (default), or set HERMELIN_ALLOW_INSECURE_HTTP=1")
            raise SystemExit(1)

        logging.getLogger("uvicorn.access").addFilter(_RunnerTokenFilter())
        uvicorn.run(
            "hermelin.server:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            reload=True,
            log_level="info",
            ssl_certfile=ssl_certfile,
            ssl_keyfile=ssl_keyfile,
        )
        return

    cfg = HermelinConfig(
        host=str(args.host),
        port=int(args.port),
        hermes_cmd=hermes_cmd,
        hermes_cmd_override=hermes_cmd_override,
        hermes_home=Path(args.hermes_home).expanduser(),
        meta_db_path=Path(args.meta_db).expanduser(),
        spawn_cwd=Path(args.spawn_cwd).expanduser(),
        allowed_ips=str(args.allowed_ips),
        trust_x_forwarded_for=bool(args.trust_xff),
        ssl_certfile=str(args.ssl_certfile).strip(),
        ssl_keyfile=str(args.ssl_keyfile).strip(),
    )

    ssl_certfile = cfg.ssl_certfile or None
    ssl_keyfile = cfg.ssl_keyfile or None
    if not (ssl_certfile and ssl_keyfile):
        ssl_certfile = None
        ssl_keyfile = None

    if ssl_certfile is None and ssl_keyfile is None and not args.allow_insecure_http and not _is_loopback_host(cfg.host):
        print("ERROR: refusing to serve insecure HTTP on non-localhost without TLS")
        print("Hint: configure HERMELIN_SSL_CERTFILE/HERMELIN_SSL_KEYFILE (default), or set HERMELIN_ALLOW_INSECURE_HTTP=1")
        raise SystemExit(1)

    app = create_app(cfg)

    logging.getLogger("uvicorn.access").addFilter(_RunnerTokenFilter())
    uvicorn.run(
        app,
        host=cfg.host,
        port=cfg.port,
        log_level="info",
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )


if __name__ == "__main__":
    main()
