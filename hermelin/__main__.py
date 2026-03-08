from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from .config import HermelinConfig
from .server import create_app


def _env_bool(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "y", "on"}


def main() -> None:
    p = argparse.ArgumentParser(prog="hermelin", description="hermelinChat web UI for Hermes Agent")
    p.add_argument("--host", default=os.getenv("HERMELIN_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.getenv("HERMELIN_PORT", "3000")))
    p.add_argument(
        "--hermes-cmd",
        default=os.getenv(
            "HERMELIN_HERMES_CMD",
            'hermes chat --toolsets "hermes-cli, artifacts"',
        ),
    )
    p.add_argument("--hermes-home", default=os.getenv("HERMES_HOME", str(Path.home() / ".hermes")))
    p.add_argument("--spawn-cwd", default=os.getenv("HERMELIN_SPAWN_CWD", os.getcwd()))
    p.add_argument(
        "--meta-db",
        default=os.getenv(
            "HERMELIN_META_DB_PATH",
            str(Path(os.getenv("HERMES_HOME", str(Path.home() / ".hermes"))) / "hermilin_meta.db"),
        ),
        help="Path to hermilinChat metadata DB (titles, etc.). Default: $HERMES_HOME/hermilin_meta.db",
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

    if args.reload:
        # Uvicorn reload requires an import string. We pass config via env.
        os.environ["HERMELIN_HOST"] = str(args.host)
        os.environ["HERMELIN_PORT"] = str(args.port)
        os.environ["HERMELIN_HERMES_CMD"] = str(args.hermes_cmd)
        os.environ["HERMES_HOME"] = str(args.hermes_home)
        os.environ["HERMELIN_SPAWN_CWD"] = str(args.spawn_cwd)
        os.environ["HERMELIN_META_DB_PATH"] = str(args.meta_db)
        os.environ["HERMELIN_ALLOWED_IPS"] = str(args.allowed_ips)
        os.environ["HERMELIN_TRUST_X_FORWARDED_FOR"] = "1" if args.trust_xff else "0"

        uvicorn.run(
            "hermelin.server:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            reload=True,
            log_level="info",
        )
        return

    cfg = HermelinConfig(
        host=str(args.host),
        port=int(args.port),
        hermes_cmd=str(args.hermes_cmd),
        hermes_home=Path(args.hermes_home).expanduser(),
        meta_db_path=Path(args.meta_db).expanduser(),
        spawn_cwd=Path(args.spawn_cwd).expanduser(),
        allowed_ips=str(args.allowed_ips),
        trust_x_forwarded_for=bool(args.trust_xff),
    )

    app = create_app(cfg)
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
