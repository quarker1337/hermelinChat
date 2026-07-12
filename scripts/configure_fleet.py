#!/usr/bin/env python3
"""Configure HermelinChat's optional HermelinFleet integration without leaking secrets."""

from __future__ import annotations

import argparse
import base64
import binascii
from dataclasses import dataclass
import ipaddress
import json
import os
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener


FLEET_KEYS = {
    "HERMELIN_FLEET_MODE",
    "HERMELIN_FLEET_URL",
    "HERMELIN_FLEET_ADMIN_TOKEN",
    "HERMELIN_FLEET_SERVICE_TOKEN",
    "HERMELIN_FLEET_CA_FILE",
}
NODE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{1,8192}$")
IMMUTABLE_GIT_REF_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
MAX_TOKEN_BYTES = 8192
MAX_BUNDLE_BYTES = 128 * 1024
MAX_CA_BYTES = 64 * 1024
MAX_JOIN_SCRIPT_BYTES = 1024 * 1024
DEFAULT_FLEET_REPOSITORY = "git@github.com:quarker1337/hermelinfleet.git"
DEFAULT_FLEET_REF = "f47da678b24ea6240a2785d3a585f23981e1a187"


@dataclass(frozen=True)
class EnrollmentMaterial:
    url: str
    token: str
    node_id: str
    ca_pem: str = ""


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"error: {message}")


def safe_external_url(raw: str, *, allow_insecure_http: bool = False) -> str:
    value = str(raw or "").strip().rstrip("/")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        fail("unsafe Fleet URL")
    parsed = urlparse(value)
    try:
        parsed.port
    except ValueError:
        fail("unsafe Fleet URL: invalid port")
    if (
        parsed.username
        or parsed.password
        or not parsed.hostname
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        fail("unsafe Fleet URL")
    host_value = parsed.hostname
    try:
        ipaddress.ip_address(host_value)
    except ValueError:
        if host_value != "localhost" and not re.fullmatch(r"[A-Za-z0-9.-]+", host_value):
            fail("unsafe Fleet URL: invalid host")
    if parsed.scheme == "https":
        return value
    if parsed.scheme != "http":
        fail("unsafe Fleet URL: expected https or loopback HTTP")
    if allow_insecure_http:
        return value
    host = parsed.hostname.lower()
    if host == "localhost":
        return value
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        fail("unsafe Fleet URL: non-loopback HTTP requires the explicit development override")
    if not address.is_loopback:
        fail("unsafe Fleet URL: non-loopback HTTP requires https")
    return value


def decode_token_bytes(data: bytes) -> str:
    if not data or len(data) > MAX_TOKEN_BYTES:
        fail("Fleet token must be between 1 byte and 8 KiB")
    try:
        value = data.decode("utf-8")
    except UnicodeDecodeError:
        fail("Fleet token must be valid UTF-8")
    if value.endswith("\n"):
        value = value[:-1]
        if value.endswith("\r"):
            value = value[:-1]
    validate_token(value)
    return value


def read_token_stdin() -> str:
    return decode_token_bytes(sys.stdin.buffer.read(MAX_TOKEN_BYTES + 1))


def read_private_file_bytes(path: str, *, max_bytes: int, label: str, require_private: bool = True) -> bytes:
    protected_path = Path(path).expanduser()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(protected_path, flags)
    except OSError:
        fail(f"could not safely open {label}")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            fail(f"{label} must be a regular file")
        if require_private and info.st_uid != os.geteuid():
            fail(f"{label} must be owned by the current user")
        if require_private and info.st_mode & 0o077:
            fail(f"{label} must not be accessible by group or other users")
        if info.st_size <= 0 or info.st_size > max_bytes:
            fail(f"{label} has an invalid size")
        chunks: list[bytes] = []
        total = 0
        while total <= max_bytes:
            chunk = os.read(fd, min(4096, max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        data = b"".join(chunks)
    finally:
        os.close(fd)
    if not data or len(data) > max_bytes:
        fail(f"{label} has an invalid size")
    return data


def read_token_file(path: str, *, require_private: bool = False) -> str:
    label = "Fleet enrollment token file" if require_private else "Fleet token file"
    data = read_private_file_bytes(
        path,
        max_bytes=MAX_TOKEN_BYTES,
        label=label,
        require_private=require_private,
    )
    return decode_token_bytes(data)


def validate_token(value: str) -> None:
    if not TOKEN_PATTERN.fullmatch(value):
        fail("Fleet token contains invalid characters or length")


def validate_ca_pem(data: bytes) -> str:
    if not data or len(data) > MAX_CA_BYTES:
        fail("Fleet CA certificate has an invalid size")
    try:
        text = data.decode("ascii")
        ssl.create_default_context(cadata=text)
    except (UnicodeDecodeError, ssl.SSLError, ValueError):
        fail("Fleet CA certificate is not a valid PEM trust anchor")
    return text


def read_ca_file(path: str) -> str:
    ca_path = Path(path).expanduser()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(ca_path, flags)
    except OSError:
        fail("could not safely open Fleet CA certificate")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > MAX_CA_BYTES:
            fail("Fleet CA certificate must be a regular file no larger than 64 KiB")
        data = os.read(fd, MAX_CA_BYTES + 1)
    finally:
        os.close(fd)
    return validate_ca_pem(data)


def read_enrollment_bundle(path: str) -> EnrollmentMaterial:
    payload = read_private_file_bytes(path, max_bytes=MAX_BUNDLE_BYTES, label="Fleet enrollment bundle")
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail("Fleet enrollment bundle must be valid UTF-8")
    if not lines or lines[0] != "HERMELINFLEET_ENROLLMENT_V1":
        fail("Fleet enrollment bundle has an unsupported format")
    values: dict[str, str] = {}
    for line in lines[1:]:
        if "=" not in line:
            fail("Fleet enrollment bundle contains a malformed field")
        key, value = line.split("=", 1)
        if key not in {"node_id", "central_url", "token", "ca_base64"} or key in values:
            fail("Fleet enrollment bundle contains an unexpected or duplicate field")
        values[key] = value
    if set(values) != {"node_id", "central_url", "token", "ca_base64"}:
        fail("Fleet enrollment bundle is incomplete")
    url = safe_external_url(values["central_url"])
    token = values["token"]
    validate_token(token)
    node_id = validate_node_id(values["node_id"])
    ca_pem = ""
    if values["ca_base64"]:
        try:
            ca_data = base64.b64decode(values["ca_base64"], validate=True)
        except (ValueError, binascii.Error):
            fail("Fleet enrollment bundle contains invalid CA encoding")
        ca_pem = validate_ca_pem(ca_data)
    return EnrollmentMaterial(url=url, token=token, node_id=node_id, ca_pem=ca_pem)


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
    for key in (
        "HERMELIN_FLEET_MODE",
        "HERMELIN_FLEET_URL",
        "HERMELIN_FLEET_SERVICE_TOKEN",
        "HERMELIN_FLEET_ADMIN_TOKEN",
        "HERMELIN_FLEET_CA_FILE",
    ):
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
    if (
        not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", ref)
        or ref.startswith(("-", ".", "/"))
        or ".." in ref
        or "@{" in ref
    ):
        fail("unsafe Fleet repository ref")
    destination = Path.home() / ".local" / "share" / "hermelinChat" / "hermelinfleet-source"
    clone_env = {key: value for key, value in os.environ.items() if not key.startswith("FLEET_")}
    clone_env["GIT_TERMINAL_PROMPT"] = "0"

    def run_git(arguments: list[str], action: str) -> str:
        result = subprocess.run(
            ["git", *arguments],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=clone_env,
        )
        if result.returncode != 0:
            diagnostics = [line.strip() for line in result.stderr.splitlines() if line.strip()]
            detail = diagnostics[-1][:300] if diagnostics else f"git exited with status {result.returncode}"
            fail(f"could not {action} the compatible HermelinFleet source: {detail}")
        return result.stdout.strip()

    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not (destination / ".git").is_dir() or not (destination / "scripts" / "install.sh").is_file():
            fail(f"automatic Fleet source path already exists but is not a checkout: {destination}")
        origin = run_git(["-C", str(destination), "remote", "get-url", "origin"], "verify")
        head = run_git(["-C", str(destination), "rev-parse", "HEAD"], "verify")
        if origin != repository:
            fail("existing automatic Fleet source has an unexpected origin")
        if IMMUTABLE_GIT_REF_PATTERN.fullmatch(ref) and head.lower() != ref.lower():
            fail("existing automatic Fleet source does not match the pinned revision")
        return str(destination.resolve())

    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination.parent.chmod(0o700)
    except OSError:
        pass
    staging = Path(tempfile.mkdtemp(prefix=".hermelinfleet-source.", dir=destination.parent))
    try:
        run_git(["init", "--quiet", str(staging)], "initialize")
        run_git(["-C", str(staging), "remote", "add", "origin", repository], "configure")
        run_git(["-C", str(staging), "fetch", "--depth", "1", "origin", ref], "fetch")
        run_git(["-C", str(staging), "checkout", "--quiet", "--detach", "FETCH_HEAD"], "check out")
        head = run_git(["-C", str(staging), "rev-parse", "HEAD"], "verify")
        if IMMUTABLE_GIT_REF_PATTERN.fullmatch(ref) and head.lower() != ref.lower():
            fail("fetched HermelinFleet source does not match the pinned revision")
        if not (staging / "scripts" / "install.sh").is_file():
            fail("fetched HermelinFleet source is missing its installer")
        os.replace(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return str(destination.resolve())


def install_local(source: str, *, manager_profile: str = "local", manager_host: str = "") -> tuple[str, str, str, str]:
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
    install_env = {key: value for key, value in os.environ.items() if not key.startswith("FLEET_")}
    install_env.update(
        {
            "FLEET_PATCH_HERMES": "1",
            "FLEET_REMOTE_RUNTIME_BACKEND": "tmux",
            "FLEET_REMOTE_RUNTIME_EXEC_MODE": "trusted",
        }
    )
    result = subprocess.run(
        install_args,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=install_env,
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
    configured_url = read_env_value(central_env, "FLEET_PUBLIC_HTTP_URL")
    if not configured_url:
        configured_url = f"https://{manager_host}:8080" if manager_profile == "overlay" else "http://127.0.0.1:8080"
    url = safe_external_url(configured_url)
    ca_file = read_env_value(central_env, "FLEET_HTTP_ROOT_CA")
    if manager_profile == "overlay":
        if not ca_file:
            fail("HermelinFleet overlay installer did not publish its HTTP root CA")
        read_ca_file(ca_file)
        return url, token, "external", str(Path(ca_file).expanduser().resolve())
    return url, token, "local", ""


def validate_node_id(value: str) -> str:
    node_id = str(value or "").strip()
    if not NODE_ID_PATTERN.fullmatch(node_id):
        fail("Fleet node ID must be 1-64 letters, digits, underscores, or hyphens")
    return node_id


def install_remote_node(url: str, token: str, node_id: str, *, ca_pem: str = "") -> None:
    endpoint = f"{url.rstrip('/')}/join.sh"
    request = Request(
        endpoint,
        headers={"Authorization": f"Bearer {token}", "X-Fleet-Node-ID": node_id},
        method="GET",
    )
    if ca_pem:
        context = ssl.create_default_context(cadata=ca_pem)
        opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), NoRedirectHandler())
    else:
        opener = build_opener(ProxyHandler({}), NoRedirectHandler())
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
        env = {key: value for key, value in os.environ.items() if not key.startswith("FLEET_")}
        env.update(
            {
                "FLEET_NODE_ID": node_id,
                "FLEET_PATCH_HERMES": "1",
                "FLEET_REMOTE_RUNTIME_BACKEND": "tmux",
                "FLEET_REMOTE_RUNTIME_EXEC_MODE": "trusted",
            }
        )
        previous_umask = os.umask(0o077)
        try:
            result = subprocess.run(["/bin/sh", temp_name], env=env, check=False)
        finally:
            os.umask(previous_umask)
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
    parser.add_argument("--enrollment-bundle-file", default="")
    parser.add_argument("--ca-file", default="")
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
        ca_file = ""
        if args.ca_file:
            read_ca_file(args.ca_file)
            ca_file = str(Path(args.ca_file).expanduser().resolve())
        update_env_file(
            env_file,
            {
                "HERMELIN_FLEET_MODE": "external",
                "HERMELIN_FLEET_URL": url,
                "HERMELIN_FLEET_SERVICE_TOKEN": token,
                "HERMELIN_FLEET_CA_FILE": ca_file,
            },
        )
        print("HermelinFleet external integration configured.")
        return
    if args.mode == "node":
        if args.enrollment_bundle_file:
            if args.token_file or args.token_stdin or args.url or args.node_id or args.ca_file:
                fail("node enrollment bundle cannot be combined with raw URL, node ID, token, or CA options")
            material = read_enrollment_bundle(args.enrollment_bundle_file)
        else:
            if bool(args.token_file) == bool(args.token_stdin):
                fail("node mode requires an enrollment bundle or exactly one of --token-file or --token-stdin")
            url = safe_external_url(args.url, allow_insecure_http=args.allow_insecure_http)
            token = read_token_file(args.token_file, require_private=True) if args.token_file else read_token_stdin()
            node_id = validate_node_id(args.node_id)
            ca_pem = read_ca_file(args.ca_file) if args.ca_file else ""
            material = EnrollmentMaterial(url=url, token=token, node_id=node_id, ca_pem=ca_pem)
        install_remote_node(material.url, material.token, material.node_id, ca_pem=material.ca_pem)
        update_env_file(env_file, {"HERMELIN_FLEET_MODE": "off"})
        print(f"This HermelinChat host joined the remote FleetManager as node {material.node_id}.")
        return
    source = resolve_fleet_source(args.fleet_source, args.fleet_repository, args.fleet_ref)
    url, token, bridge_mode, ca_file = install_local(
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
            "HERMELIN_FLEET_CA_FILE": ca_file,
        },
    )
    print("HermelinFleet local integration installed and configured.")


if __name__ == "__main__":
    main()
