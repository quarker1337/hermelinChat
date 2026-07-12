#!/usr/bin/env python3
"""Configure HermelinChat's optional HermelinFleet integration without leaking secrets."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


FLEET_KEYS = {
    "HERMELIN_FLEET_MODE",
    "HERMELIN_FLEET_URL",
    "HERMELIN_FLEET_ADMIN_TOKEN",
    "HERMELIN_FLEET_SERVICE_TOKEN",
}
SHARED_OVERLAY = ipaddress.ip_network("100.64.0.0/10")
NODE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_JOIN_SCRIPT_BYTES = 1024 * 1024
DEFAULT_FLEET_REPOSITORY = "git@github.com:quarker1337/hermelinfleet.git"
DEFAULT_FLEET_REF = "feat/hermelinchat-bridge-runtimes"


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


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


def read_token_file(path: str, *, require_private: bool = False) -> str:
    token_path = Path(path).expanduser()
    if require_private and token_path.stat().st_mode & 0o077:
        fail("Fleet enrollment token file must not be accessible by group or other users")
    value = token_path.read_text(encoding="utf-8").strip()
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


def resolve_fleet_source(source: str, repository: str, ref: str) -> str:
    if source:
        return str(Path(source).expanduser().resolve())
    parsed = urlparse(repository)
    scp_style_ssh = re.fullmatch(r"[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+", repository)
    safe_url = (
        parsed.scheme in {"https", "file"}
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
    ) or (
        parsed.scheme == "ssh"
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
    )
    if not safe_url and not scp_style_ssh:
        fail("automatic Fleet source requires a credential-free HTTPS, SSH, or file:// repository URL")
    if not ref or ref.startswith("-") or any(ch.isspace() for ch in ref):
        fail("unsafe Fleet repository ref")
    destination = Path.home() / ".local" / "share" / "hermelinChat" / "hermelinfleet-source"
    if destination.exists():
        if (destination / ".git").is_dir() and (destination / "scripts" / "install.sh").is_file():
            return str(destination.resolve())
        fail(f"automatic Fleet source path already exists but is not a checkout: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination.parent.chmod(0o700)
    except OSError:
        pass
    clone_env = os.environ.copy()
    clone_env["GIT_TERMINAL_PROMPT"] = "0"
    result = subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", ref, "--", repository, str(destination)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=clone_env,
    )
    if result.returncode != 0:
        shutil.rmtree(destination, ignore_errors=True)
        diagnostics = [line.strip() for line in result.stderr.splitlines() if line.strip()]
        detail = diagnostics[-1][:300] if diagnostics else f"git exited with status {result.returncode}"
        fail(f"could not clone the compatible HermelinFleet source: {detail}")
    return str(destination.resolve())


def install_local(source: str, *, manager_profile: str = "local", manager_host: str = "") -> tuple[str, str, str]:
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
    install_args = [str(installer), "--mode", "combined", "--source", str(source_path), "--profile", manager_profile]
    if manager_profile == "overlay":
        if not manager_host:
            fail("overlay manager profile requires --manager-host")
        install_args.extend(["--public-host", manager_host])
    result = subprocess.run(
        install_args,
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
    if manager_profile == "overlay":
        return f"http://{manager_host}:8080", token, "external"
    return "http://127.0.0.1:8080", token, "local"


def validate_node_id(value: str) -> str:
    node_id = str(value or "").strip()
    if not NODE_ID_PATTERN.fullmatch(node_id):
        fail("Fleet node ID must be 1-64 letters, digits, underscores, or hyphens")
    return node_id


def install_remote_node(url: str, token: str, node_id: str) -> None:
    endpoint = f"{url.rstrip('/')}/join.sh"
    request = Request(
        endpoint,
        headers={"Authorization": f"Bearer {token}", "X-Fleet-Node-ID": node_id},
        method="GET",
    )
    opener = build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=15) as response:
            content_type = response.headers.get_content_type()
            if content_type not in {"text/x-shellscript", "text/plain", "application/x-sh"}:
                fail(f"Fleet join endpoint returned unexpected content type {content_type!r}")
            script = response.read(MAX_JOIN_SCRIPT_BYTES + 1)
    except HTTPError as exc:
        if exc.code in {301, 302, 303, 307, 308}:
            fail("Fleet join endpoint redirected; refusing to forward enrollment credentials")
        if exc.code == 401:
            fail("Fleet enrollment was rejected: token expired, used, or minted for a different node ID")
        fail(f"Fleet join endpoint returned HTTP {exc.code}")
    except URLError as exc:
        fail(f"could not reach Fleet join endpoint: {exc.reason}")
    if len(script) > MAX_JOIN_SCRIPT_BYTES:
        fail("Fleet join script exceeds the 1 MiB safety limit")
    if not script.startswith(b"#!"):
        fail("Fleet join endpoint did not return an executable shell script")

    fd, temp_name = tempfile.mkstemp(prefix="hermelinfleet-join-", suffix=".sh")
    try:
        os.fchmod(fd, 0o700)
        with os.fdopen(fd, "wb") as handle:
            handle.write(script)
            handle.flush()
            os.fsync(handle.fileno())
        env = os.environ.copy()
        env.pop("FLEET_ENROLLMENT_TOKEN", None)
        env.update(
            {
                "FLEET_NODE_ID": node_id,
                "FLEET_PATCH_HERMES": "1",
                "FLEET_REMOTE_RUNTIME_BACKEND": "tmux",
                "FLEET_REMOTE_RUNTIME_EXEC_MODE": "trusted",
            }
        )
        result = subprocess.run(["/bin/sh", temp_name], env=env, check=False)
        if result.returncode != 0:
            fail(f"Fleet node installer failed with status {result.returncode}")
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--mode", choices=("off", "external", "local", "node"), required=True)
    parser.add_argument("--url", default="")
    parser.add_argument("--token-file", default="")
    parser.add_argument("--token-stdin", action="store_true")
    parser.add_argument("--node-id", default="")
    parser.add_argument("--fleet-source", default="")
    parser.add_argument("--fleet-repository", default=DEFAULT_FLEET_REPOSITORY)
    parser.add_argument("--fleet-ref", default=DEFAULT_FLEET_REF)
    parser.add_argument("--manager-profile", choices=("local", "overlay"), default="local")
    parser.add_argument("--manager-host", default="")
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
    if args.mode == "node":
        if bool(args.token_file) == bool(args.token_stdin):
            fail("node mode requires exactly one of --token-file or --token-stdin")
        url = safe_external_url(args.url, allow_insecure_http=args.allow_insecure_http)
        token = read_token_file(args.token_file, require_private=True) if args.token_file else read_token_stdin()
        node_id = validate_node_id(args.node_id)
        install_remote_node(url, token, node_id)
        update_env_file(env_file, {"HERMELIN_FLEET_MODE": "off"})
        print(f"This HermelinChat host joined the remote FleetManager as node {node_id}.")
        return
    source = resolve_fleet_source(args.fleet_source, args.fleet_repository, args.fleet_ref)
    url, token, bridge_mode = install_local(
        source,
        manager_profile=args.manager_profile,
        manager_host=args.manager_host,
    )
    update_env_file(
        env_file,
        {
            "HERMELIN_FLEET_MODE": bridge_mode,
            "HERMELIN_FLEET_URL": url,
            "HERMELIN_FLEET_SERVICE_TOKEN": token,
        },
    )
    print("HermelinFleet local integration installed and configured.")


if __name__ == "__main__":
    main()
