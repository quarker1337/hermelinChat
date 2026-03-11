from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from http.cookies import SimpleCookie
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError


def generate_secret_bytes() -> bytes:
    return secrets.token_bytes(32)


# Argon2id password hashing for UI login
_PH = PasswordHasher(
    time_cost=3,
    memory_cost=65536,  # 64 MiB
    parallelism=2,
    hash_len=32,
    salt_len=16,
)


def hash_login_password(password: str) -> str:
    password = str(password or "")
    if not password:
        raise ValueError("password required")
    return _PH.hash(password)


def verify_login_password(password: str, password_hash: str) -> bool:
    password = str(password or "")
    password_hash = str(password_hash or "")
    if not password_hash:
        return False
    if not password:
        return False

    try:
        return bool(_PH.verify(password_hash, password))
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    s = data.encode("ascii")
    pad = b"=" * ((4 - (len(s) % 4)) % 4)
    return base64.urlsafe_b64decode(s + pad)


def create_session_token(*, secret: bytes, ttl_seconds: int) -> str:
    now = int(time.time())
    payload = {
        "v": 1,
        "iat": now,
        "exp": now + int(ttl_seconds),
    }
    payload_b = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    payload_b64 = _b64url_encode(payload_b)

    sig = hmac.new(secret, payload_b64.encode("utf-8"), hashlib.sha256).digest()
    sig_b64 = _b64url_encode(sig)

    return f"{payload_b64}.{sig_b64}"


def verify_session_token(*, token: str, secret: bytes) -> bool:
    if not token:
        return False

    if "." not in token:
        return False

    payload_b64, sig_b64 = token.split(".", 1)

    expected_sig = hmac.new(secret, payload_b64.encode("utf-8"), hashlib.sha256).digest()
    expected_sig_b64 = _b64url_encode(expected_sig)

    if not hmac.compare_digest(expected_sig_b64, sig_b64):
        return False

    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception:
        return False

    exp = int(payload.get("exp") or 0)
    if exp <= int(time.time()):
        return False

    return True


def extract_cookie_value(cookie_header: str, name: str) -> Optional[str]:
    if not cookie_header:
        return None

    c = SimpleCookie()
    try:
        c.load(cookie_header)
    except Exception:
        return None

    morsel = c.get(name)
    if not morsel:
        return None

    return morsel.value
