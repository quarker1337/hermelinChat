#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SELF_DIR}/.." && pwd)"

SERVICE="hermelin"
ENV_FILE="${ROOT_DIR}/.hermelin.env"
FORCE_ENV=0
YES=0
PULL=0

# By default we generate a self-signed cert and serve HTTPS directly.
# Disable with: ./scripts/install.sh --no-https
ENABLE_HTTPS=1

INSTALL_SERVICE=0
SERVICE_MODE="system"  # system|user

# Forwarded to update.sh
SKIP_FRONTEND=0
SKIP_PYTHON=0
SKIP_HERMES_PATCH=0
SKIP_HERMES_SKINS=0

usage() {
  cat <<EOF
Usage: ./scripts/install.sh [options]

This is a first-time setup helper.

It will:
  - create .hermelin.env (gitignored) if missing
  - run ./scripts/update.sh (creates .venv, installs backend deps, builds frontend, patches Hermes)
  - optionally install + start a systemd service

Options:
  --pull                 Run git pull (default: no pull)
  --env-file PATH        Where to write the env file (default: ./.hermelin.env)
  --force-env            Overwrite the env file if it already exists
  --no-https             Disable built-in HTTPS (do not generate self-signed cert)

  --install-service       Install a systemd service (default: system service)
  --user-service          Install a systemd *user* service (no sudo)
  --system-service        Install a systemd *system* service (sudo)
  --service NAME          Service name (default: hermelin)

  --skip-frontend        Skip npm install/build (NOT recommended; UI will 404 on /)
  --skip-python          Skip pip install -e .
  --skip-hermes-patch    Skip patching the active Hermes installation with artifact tools
  --skip-hermes-skins    Skip installing hermelinChat CLI skins into ~/.hermes/skins/
  --skip-hermes-themes   (deprecated alias for --skip-hermes-skins)

  -y, --yes              Do not prompt for confirmation
  -h, --help             Show help

Examples:
  ./scripts/install.sh
  ./scripts/install.sh --install-service --yes
  ./scripts/install.sh --user-service --service hermelin --yes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull)
      PULL=1
      shift
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      if [[ -z "$ENV_FILE" ]]; then
        echo "ERROR: --env-file requires a path" >&2
        exit 1
      fi
      shift 2
      ;;
    --force-env)
      FORCE_ENV=1
      shift
      ;;

    --no-https)
      ENABLE_HTTPS=0
      shift
      ;;

    --install-service)
      INSTALL_SERVICE=1
      SERVICE_MODE="system"
      shift
      ;;
    --system-service)
      INSTALL_SERVICE=1
      SERVICE_MODE="system"
      shift
      ;;
    --user-service)
      INSTALL_SERVICE=1
      SERVICE_MODE="user"
      shift
      ;;
    --service)
      SERVICE="${2:-}"
      if [[ -z "$SERVICE" ]]; then
        echo "ERROR: --service requires a name" >&2
        exit 1
      fi
      shift 2
      ;;

    --skip-frontend)
      SKIP_FRONTEND=1
      shift
      ;;
    --skip-python)
      SKIP_PYTHON=1
      shift
      ;;
    --skip-hermes-patch)
      SKIP_HERMES_PATCH=1
      shift
      ;;
    --skip-hermes-skins|--skip-hermes-themes)
      SKIP_HERMES_SKINS=1
      shift
      ;;

    -y|--yes)
      YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

# Normalize ENV_FILE if user passed a relative path
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$ROOT_DIR/$ENV_FILE"
fi

ENV_DIR="$(dirname "$ENV_FILE")"

DEFAULT_HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DEFAULT_HERMES_HOME="${DEFAULT_HERMES_HOME/#\~/$HOME}"

DEFAULT_HERMES_EXE="hermes"
if command -v hermes >/dev/null 2>&1; then
  DEFAULT_HERMES_EXE="$(command -v hermes)"
fi

# -------------------------------------------------------------------
# Hermes install sanity check
# -------------------------------------------------------------------
# hermelinChat expects Hermes Agent to be installed for the *current user* so
# it can read/write ~/.hermes without sudo and so upgrades don't get blocked.
if [[ "$DEFAULT_HERMES_EXE" == "hermes" ]]; then
  echo "ERROR: hermes not found in PATH. Install Hermes Agent for this user first." >&2
  exit 1
fi

if [[ "$DEFAULT_HERMES_EXE" != "$HOME"/* ]]; then
  echo "ERROR: hermes executable is not under $HOME: $DEFAULT_HERMES_EXE" >&2
  echo "Please install Hermes Agent as a per-user install (e.g. ~/.local/bin/hermes) and re-run." >&2
  exit 1
fi

# -------------------------------------------------------------------
# Self-signed TLS (enabled by default)
# -------------------------------------------------------------------
SSL_CERTFILE=""
SSL_KEYFILE=""
HERMELIN_COOKIE_SECURE_DEFAULT=0
HERMELIN_ALLOW_INSECURE_HTTP_DEFAULT=0

if [[ "$ENABLE_HTTPS" -eq 1 ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl not found (required for default HTTPS setup)." >&2
    echo "Install openssl, or re-run with: ./scripts/install.sh --no-https" >&2
    exit 1
  fi

  TLS_DIR="${DEFAULT_HERMES_HOME}/hermelin_tls"
  SSL_CERTFILE="${TLS_DIR}/cert.pem"
  SSL_KEYFILE="${TLS_DIR}/key.pem"
  OPENSSL_CNF="${TLS_DIR}/openssl.cnf"

  mkdir -p "$TLS_DIR"
  chmod 700 "$TLS_DIR" || true

  if [[ ! -f "$SSL_CERTFILE" || ! -f "$SSL_KEYFILE" ]]; then
    echo "==> generating self-signed TLS certificate in: $TLS_DIR"

    host1="$(hostname 2>/dev/null || true)"
    host2="$(hostname -f 2>/dev/null || true)"
    ips="$(hostname -I 2>/dev/null || true)"

    {
      echo "[req]"
      echo "default_bits = 2048"
      echo "prompt = no"
      echo "default_md = sha256"
      echo "distinguished_name = dn"
      echo "x509_extensions = v3_req"
      echo
      echo "[dn]"
      echo "CN = localhost"
      echo
      echo "[v3_req]"
      echo "subjectAltName = @alt_names"
      echo
      echo "[alt_names]"
      echo "DNS.1 = localhost"
      echo "IP.1 = 127.0.0.1"

      i_dns=2
      if [[ -n "$host1" && "$host1" != "localhost" ]]; then
        echo "DNS.${i_dns} = ${host1}"
        i_dns=$((i_dns + 1))
      fi
      if [[ -n "$host2" && "$host2" != "$host1" && "$host2" != "localhost" ]]; then
        echo "DNS.${i_dns} = ${host2}"
        i_dns=$((i_dns + 1))
      fi

      i_ip=2
      for ip in $ips; do
        if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
          if [[ "$ip" != "127.0.0.1" ]]; then
            echo "IP.${i_ip} = ${ip}"
            i_ip=$((i_ip + 1))
          fi
        fi
      done
    } >"$OPENSSL_CNF"

    if ! out=$(openssl req -x509 -new -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$SSL_KEYFILE" \
      -out "$SSL_CERTFILE" \
      -config "$OPENSSL_CNF" 2>&1); then
      echo "ERROR: openssl failed to generate a self-signed certificate." >&2
      echo "$out" >&2
      exit 1
    fi

    chmod 600 "$SSL_KEYFILE" || true
    chmod 644 "$SSL_CERTFILE" || true
  else
    echo "==> using existing TLS certificate: $SSL_CERTFILE"
  fi

  HERMELIN_COOKIE_SECURE_DEFAULT=1
else
  # If the user explicitly disables HTTPS, we allow insecure HTTP even on non-localhost.
  # (The server refuses this unless HERMELIN_ALLOW_INSECURE_HTTP=1.)
  HERMELIN_ALLOW_INSECURE_HTTP_DEFAULT=1
fi

if command -v id >/dev/null 2>&1; then
  DEFAULT_USER="$(id -un)"
else
  DEFAULT_USER="${USER:-}" 
fi

COOKIE_SECRET=""
if command -v python3 >/dev/null 2>&1; then
  COOKIE_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))' 2>/dev/null || true)"
fi
if [[ -z "$COOKIE_SECRET" ]] && command -v openssl >/dev/null 2>&1; then
  COOKIE_SECRET="$(openssl rand -base64 32 2>/dev/null | tr -d '\n' || true)"
fi
if [[ -z "$COOKIE_SECRET" ]]; then
  COOKIE_SECRET="change-me-generate-a-long-random-string"
fi

WRITE_ENV=0
if [[ ! -f "$ENV_FILE" ]]; then
  WRITE_ENV=1
elif [[ "$FORCE_ENV" -eq 1 ]]; then
  WRITE_ENV=1
fi

# -------------------------------------------------------------------
# Interactive: offer systemd service install (recommended)
# -------------------------------------------------------------------
if [[ "$INSTALL_SERVICE" -eq 0 && "$YES" -eq 0 ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    read -r -p "Install and start a systemd service for hermelinChat? [y/N] " _svc
    if [[ "${_svc,,}" == "y" || "${_svc,,}" == "yes" ]]; then
      INSTALL_SERVICE=1
      read -r -p "Install as user service (no sudo) or system service (sudo)? [u/s] (default: u) " _mode
      if [[ "${_mode,,}" == "s" || "${_mode,,}" == "system" ]]; then
        SERVICE_MODE="system"
      else
        SERVICE_MODE="user"
      fi
    fi
  fi
fi

echo "==> hermelinChat install"
echo "    root:     $ROOT_DIR"
echo "    env file: $ENV_FILE"
echo

echo "Planned actions:"
if [[ "$WRITE_ENV" -eq 1 ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    echo "  - write env file: yes (overwrite)"
  else
    echo "  - write env file: yes (create)"
  fi
else
  echo "  - write env file: no (exists)"
fi

echo "  - build backend + frontend: yes (via ./scripts/update.sh)"
if [[ "$PULL" -eq 1 ]]; then
  echo "  - git pull: yes"
else
  echo "  - git pull: no"
fi

if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  echo "  - install + start systemd service: yes ($SERVICE_MODE)"
  echo "    service name: $SERVICE"
else
  echo "  - install + start systemd service: no (pass --install-service/--user-service)"
fi

echo

if [[ "$YES" -eq 0 ]]; then
  read -r -p "Proceed? [y/N] " ans
  if [[ "${ans,,}" != "y" && "${ans,,}" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

if [[ "$WRITE_ENV" -eq 1 ]]; then
  echo "==> writing env file: $ENV_FILE"
  mkdir -p "$ENV_DIR"

  cat >"$ENV_FILE" <<EOF
# hermelinChat runtime config (gitignored)
#
# This file is compatible with:
#   - bash:   set -a; source .hermelin.env; set +a
#   - systemd: EnvironmentFile=... (quotes supported)
#
# IMPORTANT:
# - By default we bind to localhost and only allow localhost.
# - If you allow LAN access, set a strong password.
#

# Server bind
HERMELIN_HOST=127.0.0.1
HERMELIN_PORT=3000

# Security: comma-separated allowlist of IPs/CIDRs
HERMELIN_ALLOWED_IPS=127.0.0.1,::1

# UI password auth (argon2id hash; generated by installer)
HERMELIN_PASSWORD_HASH=''

# Cookie signing secret (recommended). Keep stable across restarts.
HERMELIN_COOKIE_SECRET='$COOKIE_SECRET'

# Hermes integration
HERMES_HOME=$DEFAULT_HERMES_HOME
HERMELIN_HERMES_CMD="$DEFAULT_HERMES_EXE chat --toolsets \"hermes-cli, artifacts\""

# Optional
# HERMELIN_META_DB_PATH=$DEFAULT_HERMES_HOME/hermelin_meta.db
# HERMELIN_SPAWN_CWD=$ROOT_DIR

# Built-in HTTPS (self-signed by installer)
# - If both HERMELIN_SSL_CERTFILE and HERMELIN_SSL_KEYFILE are set, hermelinChat
#   serves HTTPS directly.
# - Disable by emptying these vars or re-running installer with --no-https.
HERMELIN_SSL_CERTFILE="$SSL_CERTFILE"
HERMELIN_SSL_KEYFILE="$SSL_KEYFILE"

# Allow insecure HTTP on non-localhost (NOT recommended). Set by installer when using --no-https.
HERMELIN_ALLOW_INSECURE_HTTP=$HERMELIN_ALLOW_INSECURE_HTTP_DEFAULT

# Reverse proxy / TLS
HERMELIN_COOKIE_SECURE=$HERMELIN_COOKIE_SECURE_DEFAULT
HERMELIN_TRUST_X_FORWARDED_FOR=0
EOF

  echo "    wrote: $ENV_FILE"
fi

if [[ -f "$ENV_FILE" ]]; then
  chmod 600 "$ENV_FILE" || true
fi

# -------------------------------------------------------------------
# Ensure env file contains systemd-friendly Hermes command
# -------------------------------------------------------------------
# Under systemd, PATH does not include ~/.local/bin by default (no bashrc).
# If HERMELIN_HERMES_CMD is missing (or set to plain "hermes ..."), PTY spawn
# fails with: FileNotFoundError: 'hermes'
if [[ -f "$ENV_FILE" ]]; then
  # -------------------------------------------------------------------
  # Ensure env file contains HTTPS settings
  # -------------------------------------------------------------------
  echo "==> ensuring HTTPS settings in env file"
  HERMELIN_ENV_FILE="$ENV_FILE" \
    HERMELIN_ENABLE_HTTPS="$ENABLE_HTTPS" \
    HERMELIN_SSL_CERTFILE="$SSL_CERTFILE" \
    HERMELIN_SSL_KEYFILE="$SSL_KEYFILE" \
    python3 - <<'PY'
import os
import re
from pathlib import Path

env_file = Path(os.environ["HERMELIN_ENV_FILE"])
txt = env_file.read_text(encoding="utf-8") if env_file.exists() else ""

def _unquote(s: str) -> str:
    s = (s or "").strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1]
    return s

def get(key: str):
    m = re.search(rf"^{re.escape(key)}=(.*)$", txt, flags=re.M)
    return _unquote(m.group(1)) if m else None

def set_key(key: str, value: str, quote: bool = False):
    global txt
    desired = f'{key}="{value}"' if quote else f"{key}={value}"
    if re.search(rf"^{re.escape(key)}=.*$", txt, flags=re.M):
        txt = re.sub(rf"^{re.escape(key)}=.*$", desired, txt, flags=re.M)
    else:
        txt = txt.rstrip("\n") + "\n" + desired + "\n"

enable = os.environ.get("HERMELIN_ENABLE_HTTPS", "1") == "1"
default_cert = os.environ.get("HERMELIN_SSL_CERTFILE", "")
default_key = os.environ.get("HERMELIN_SSL_KEYFILE", "")

if enable:
    cert = (get("HERMELIN_SSL_CERTFILE") or "").strip()
    key = (get("HERMELIN_SSL_KEYFILE") or "").strip()

    if not cert:
        set_key("HERMELIN_SSL_CERTFILE", default_cert, quote=True)
    if not key:
        set_key("HERMELIN_SSL_KEYFILE", default_key, quote=True)

    cs = (get("HERMELIN_COOKIE_SECURE") or "").strip()
    if cs in ("", "0"):
        set_key("HERMELIN_COOKIE_SECURE", "1")

    set_key("HERMELIN_ALLOW_INSECURE_HTTP", "0")
else:
    set_key("HERMELIN_SSL_CERTFILE", "", quote=True)
    set_key("HERMELIN_SSL_KEYFILE", "", quote=True)
    set_key("HERMELIN_COOKIE_SECURE", "0")
    set_key("HERMELIN_ALLOW_INSECURE_HTTP", "1")

env_file.write_text(txt, encoding="utf-8")
PY

  if ! grep -q '^HERMES_HOME=' "$ENV_FILE"; then
    {
      echo
      echo "# Hermes integration (added by installer)"
      echo "HERMES_HOME=$DEFAULT_HERMES_HOME"
    } >>"$ENV_FILE"
  fi

  if grep -q '^HERMELIN_HERMES_CMD=' "$ENV_FILE"; then
    if grep -Eq "^HERMELIN_HERMES_CMD=[\"']?hermes([[:space:]]|$)" "$ENV_FILE"; then
      echo "==> updating HERMELIN_HERMES_CMD to absolute path (systemd-safe)"
      HERMELIN_ENV_FILE="$ENV_FILE" HERMELIN_HERMES_EXE="$DEFAULT_HERMES_EXE" python3 - <<'PY'
import os
import re
from pathlib import Path

p = Path(os.environ["HERMELIN_ENV_FILE"])
exe = os.environ["HERMELIN_HERMES_EXE"]

txt = p.read_text(encoding="utf-8")
desired = f'HERMELIN_HERMES_CMD="{exe} chat --toolsets hermes-cli,artifacts"'

txt2, n = re.subn(r'^HERMELIN_HERMES_CMD=.*$', desired, txt, flags=re.M)
if n == 0:
    txt2 = txt.rstrip("\n") + "\n" + desired + "\n"

p.write_text(txt2, encoding="utf-8")
PY
    fi
  else
    {
      echo
      echo "# Hermes integration (added by installer)"
      echo "HERMELIN_HERMES_CMD=\"$DEFAULT_HERMES_EXE chat --toolsets hermes-cli,artifacts\""
    } >>"$ENV_FILE"
  fi
fi

# Build everything
UPDATE_ARGS=()
if [[ "$PULL" -eq 0 ]]; then
  UPDATE_ARGS+=("--no-pull")
fi
if [[ "$SKIP_FRONTEND" -eq 1 ]]; then
  UPDATE_ARGS+=("--skip-frontend")
fi
if [[ "$SKIP_PYTHON" -eq 1 ]]; then
  UPDATE_ARGS+=("--skip-python")
fi
if [[ "$SKIP_HERMES_PATCH" -eq 1 ]]; then
  UPDATE_ARGS+=("--skip-hermes-patch")
fi
if [[ "$SKIP_HERMES_SKINS" -eq 1 ]]; then
  UPDATE_ARGS+=("--skip-hermes-skins")
fi

"$SELF_DIR/update.sh" "${UPDATE_ARGS[@]}"

# Sanity check: UI build
if [[ ! -f hermelin/static/index.html ]]; then
  echo "ERROR: hermelin/static/index.html not found after build." >&2
  echo "This usually means the frontend build was skipped or failed." >&2
  echo "Fix options:" >&2
  echo "  - Ensure Node.js + npm are installed" >&2
  echo "  - Re-run: ./scripts/update.sh" >&2
  exit 1
fi

# -------------------------------------------------------------------
# Ensure UI password auth is configured (argon2id hash in env)
# -------------------------------------------------------------------
if [[ "$SKIP_PYTHON" -eq 1 ]]; then
  echo "WARNING: --skip-python set; cannot generate HERMELIN_PASSWORD_HASH." >&2
  echo "Set HERMELIN_PASSWORD_HASH manually in $ENV_FILE or re-run without --skip-python." >&2
else
  if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
    echo "ERROR: $ROOT_DIR/.venv/bin/python not found after update.sh." >&2
    echo "Cannot generate HERMELIN_PASSWORD_HASH." >&2
    exit 1
  fi

  HERMELIN_ENV_FILE="$ENV_FILE" HERMELIN_YES="$YES" "$ROOT_DIR/.venv/bin/python" - <<'PY'
import os
import re
import secrets
import sys
from pathlib import Path

from hermelin.auth import hash_login_password


env_file = Path(os.environ["HERMELIN_ENV_FILE"]).expanduser()
yes = os.environ.get("HERMELIN_YES", "0") == "1"

txt = env_file.read_text(encoding="utf-8") if env_file.exists() else ""


def _unquote(s: str) -> str:
    s = (s or "").strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1]
    return s


def get(key: str) -> str:
    m = re.search(rf"^{re.escape(key)}=(.*)$", txt, flags=re.M)
    return _unquote(m.group(1)) if m else ""


def set_key_single_quoted(key: str, value: str) -> None:
    global txt
    value = (value or "").replace("'", "\\'")
    desired = f"{key}='{value}'"
    if re.search(rf"^{re.escape(key)}=.*$", txt, flags=re.M):
        txt = re.sub(rf"^{re.escape(key)}=.*$", desired, txt, flags=re.M)
    else:
        txt = txt.rstrip("\n") + "\n" + desired + "\n"


def remove_key(key: str) -> None:
    global txt
    txt = re.sub(rf"^{re.escape(key)}=.*\n?", "", txt, flags=re.M)


existing_hash = (get("HERMELIN_PASSWORD_HASH") or "").strip()
if existing_hash:
    print("==> password hash already set in env file")
    sys.exit(0)

legacy_plain = (get("HERMELIN_PASSWORD") or "").strip()
pw = ""
generated = False

if legacy_plain:
    pw = legacy_plain
    print("==> migrating HERMELIN_PASSWORD -> HERMELIN_PASSWORD_HASH")
else:
    if yes:
        pw = secrets.token_urlsafe(32)
        generated = True
    else:
        import getpass

        pw = getpass.getpass("Set hermelinChat UI password (leave blank to generate): ")
        if not pw:
            pw = secrets.token_urlsafe(32)
            generated = True
        else:
            pw2 = getpass.getpass("Confirm password: ")
            if pw2 != pw:
                print("ERROR: passwords do not match", file=sys.stderr)
                sys.exit(1)

phash = hash_login_password(pw)
set_key_single_quoted("HERMELIN_PASSWORD_HASH", phash)
remove_key("HERMELIN_PASSWORD")

env_file.write_text(txt, encoding="utf-8")

if generated:
    print("==> GENERATED UI PASSWORD (SAVE THIS):")
    print(pw)
PY
fi

install_service_system() {
  local unit_path="/etc/systemd/system/${SERVICE}.service"

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "ERROR: systemctl not found; cannot install system service." >&2
    exit 1
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "ERROR: sudo not found; cannot install system service." >&2
    exit 1
  fi

  echo "==> installing systemd system service: $unit_path"

  local service_user="$DEFAULT_USER"
  local workdir="$ROOT_DIR"

  sudo tee "$unit_path" >/dev/null <<EOF
[Unit]
Description=hermelinChat
After=network.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$workdir
EnvironmentFile=$ENV_FILE
UMask=0077
ExecStart=$workdir/.venv/bin/hermelin
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE"
  sudo systemctl --no-pager status "$SERVICE" || true
}

install_service_user() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit_path="$unit_dir/${SERVICE}.service"

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "ERROR: systemctl not found; cannot install user service." >&2
    exit 1
  fi

  echo "==> installing systemd user service: $unit_path"

  mkdir -p "$unit_dir"

  cat >"$unit_path" <<EOF
[Unit]
Description=hermelinChat
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
UMask=0077
ExecStart=$ROOT_DIR/.venv/bin/hermelin
Restart=on-failure

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  systemctl --user --no-pager status "$SERVICE" || true
}

if [[ "$INSTALL_SERVICE" -eq 1 ]]; then
  if [[ "$SERVICE_MODE" == "user" ]]; then
    install_service_user
  else
    install_service_system
  fi
fi

echo
echo "==> install complete"
echo
echo "Quick run (manual):"
echo "  set -a; source '$ENV_FILE'; set +a"
echo "  ./.venv/bin/hermelin"
echo
if [[ "$ENABLE_HTTPS" -eq 1 ]]; then
  echo "Open (HTTPS, self-signed):"
  echo "  https://127.0.0.1:3000"
else
  echo "Open (HTTP):"
  echo "  http://127.0.0.1:3000"
fi
