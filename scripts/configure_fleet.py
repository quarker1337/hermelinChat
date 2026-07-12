#!/usr/bin/env python3
"""Configure HermelinChat's optional HermelinFleet integration without leaking secrets."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlparse


FLEET_KEYS = {
    "HERMELIN_FLEET_MODE",
    "HERMELIN_FLEET_URL",
    "HERMELIN_FLEET_ADMIN_TOKEN",
    "HERMELIN_FLEET_SERVICE_TOKEN",
}
SHARED_OVERLAY = ipaddress.ip_network("100.64.0.0/10")


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"error: {message}")


def safe_external_url(raw: str, *, allow_insecure_http: bool = False) -> str:
    value = str(raw or "").strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.username or parsed.password or not parsed.hostname or parsed.query or parsed.fragment:
        fail("unsafe Fleet URL")
    if parsed.scheme == "https":
        return value
    if parsed.scheme != "http":
        fail("unsafe Fleet URL: expected https, loopback HTTP, or private-overlay HTTP")
    if allow_insecure_http:
        return value
    host = parsed.hostname.lower()
    if host == "localhost":
        return value
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        fail("unsafe Fleet URL: public or unresolved HTTP host")
    allowed = address.is_loopback or (
        (address.is_private or address in SHARED_OVERLAY)
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_unspecified
    )
    if not allowed:
        fail("unsafe Fleet URL: public or link-local HTTP address")
    return value


def read_token_stdin() -> str:
    value = sys.stdin.read().strip()
    validate_token(value)
    return value


def read_token_file(path: str) -> str:
    value = Path(path).expanduser().read_text(encoding="utf-8").strip()
    validate_token(value)
    return value


def validate_token(value: str) -> None:
    if not value or any(ch.isspace() for ch in value) or "\x00" in value:
        fail("Fleet token must be a non-empty single-line value")


def read_env_value(path: Path, key: str) -> str:
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.startswith(f"{key}="):
            value = raw.split("=", 1)[1].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            return value
    return ""


def update_env_file(path: Path, values: dict[str, str]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    kept: list[str] = []
    for line in existing.splitlines():
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key not in FLEET_KEYS:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    kept.extend(["", "# Optional HermelinFleet integration (managed by installer)"])
    for key in ("HERMELIN_FLEET_MODE", "HERMELIN_FLEET_URL", "HERMELIN_FLEET_SERVICE_TOKEN", "HERMELIN_FLEET_ADMIN_TOKEN"):
        value = values.get(key, "")
        if value:
            if "\n" in value or "\r" in value or "\x00" in value:
                fail(f"unsafe value for {key}")
            kept.append(f"{key}={value}")
    content = "\n".join(kept).rstrip() + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        os.chmod(path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def install_local(source: str) -> tuple[str, str]:
    source_path = Path(source).expanduser().resolve()
    expected_contract = Path(__file__).resolve().parents[1] / "contracts" / "hermelinfleet-api-v1.json"
    source_contract = source_path / "contracts" / "hermelinfleet-api-v1.json"
    try:
        expected = json.loads(expected_contract.read_text(encoding="utf-8"))
        actual = json.loads(source_contract.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"HermelinFleet source is missing a valid compatibility contract: {exc}")
    if actual != expected:
        fail(
            "HermelinFleet source contract does not match this HermelinChat build "
            f"({actual.get('contract_id', 'unknown')} != {expected.get('contract_id', 'unknown')})"
        )
    installer = source_path / "scripts" / "install.sh"
    if not installer.is_file():
        fail(f"HermelinFleet installer not found: {installer}")
    home = Path.home()
    home.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [str(installer), "--mode", "combined", "--source", str(source_path)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        if result.stderr:
            sys.stderr.write(result.stderr)
        fail("HermelinFleet local installation failed")
    central_env = home / ".config" / "hermelinfleet" / "central.env"
    if not central_env.is_file():
        fail("HermelinFleet installer did not create central.env")
    token = read_env_value(central_env, "FLEET_HERMELIN_TOKEN")
    validate_token(token)
    return "http://127.0.0.1:8080", token


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--mode", choices=("off", "external", "local"), required=True)
    parser.add_argument("--url", default="")
    parser.add_argument("--token-file", default="")
    parser.add_argument("--token-stdin", action="store_true")
    parser.add_argument("--fleet-source", default="")
    parser.add_argument("--allow-insecure-http", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    env_file = Path(args.env_file)
    if args.mode == "off":
        update_env_file(env_file, {"HERMELIN_FLEET_MODE": "off"})
        print("HermelinFleet integration disabled.")
        return
    if args.mode == "external":
        if bool(args.token_file) == bool(args.token_stdin):
            fail("external mode requires exactly one of --token-file or --token-stdin")
        url = safe_external_url(args.url, allow_insecure_http=args.allow_insecure_http)
        token = read_token_file(args.token_file) if args.token_file else read_token_stdin()
        update_env_file(
            env_file,
            {
                "HERMELIN_FLEET_MODE": "external",
                "HERMELIN_FLEET_URL": url,
                "HERMELIN_FLEET_SERVICE_TOKEN": token,
            },
        )
        print("HermelinFleet external integration configured.")
        return
    if not args.fleet_source:
        fail("local mode requires --fleet-source")
    url, token = install_local(args.fleet_source)
    update_env_file(
        env_file,
        {
            "HERMELIN_FLEET_MODE": "local",
            "HERMELIN_FLEET_URL": url,
            "HERMELIN_FLEET_SERVICE_TOKEN": token,
        },
    )
    print("HermelinFleet local integration installed and configured.")


if __name__ == "__main__":
    main()
