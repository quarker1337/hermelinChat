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

# Preferred host role. Internal FLEET_MODE remains for backwards compatibility.
FLEET_ROLE=""
FLEET_MODE=""
FLEET_URL=""
FLEET_TOKEN_FILE=""
FLEET_ENROLLMENT_TOKEN_FILE=""
FLEET_NODE_ID=""
FLEET_SOURCE=""
FLEET_REPOSITORY="git@github.com:quarker1337/hermelinfleet.git"
FLEET_REF="feat/hermelinchat-bridge-runtimes"
FLEET_MANAGER_PROFILE="local"
FLEET_MANAGER_PROFILE_SET=0
FLEET_MANAGER_HOST=""
FLEET_ALLOW_INSECURE_HTTP=0
FLEET_TOKEN_STDIN_VALUE=""
FLEET_ENROLLMENT_TOKEN_STDIN_VALUE=""

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

  --fleet-role ROLE      Host role: standalone (default), manager, or node
  --fleet-mode MODE      Legacy: off, external, or local
  --fleet-url URL        Existing Fleet central URL for node/external mode
  --fleet-enrollment-token-file P
                         Read a five-minute node enrollment token from a mode-0600 file
  --fleet-node-id ID     Node identity (default: hostname -s)
  --fleet-token-file P   Legacy external-cockpit service credential file
  --fleet-source DIR     Existing HermelinFleet checkout for manager mode
  --fleet-repository URL Repository cloned automatically when --fleet-source is omitted
  --fleet-ref REF        Compatible Fleet Git ref used for automatic clone
  --fleet-manager-profile PROFILE
                         Manager exposure: local (default) or overlay
  --fleet-manager-host IP
                         Private LAN/Tailscale IPv4 advertised by overlay managers
  --fleet-allow-insecure-http
                         Allow external public HTTP only for explicit development use

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

    --fleet-role)
      FLEET_ROLE="${2:-}"
      case "$FLEET_ROLE" in standalone|manager|node) ;; *) echo "ERROR: --fleet-role must be standalone, manager, or node" >&2; exit 1 ;; esac
      shift 2
      ;;
    --fleet-mode)
      FLEET_MODE="${2:-}"
      case "$FLEET_MODE" in off|external|local) ;; *) echo "ERROR: --fleet-mode must be off, external, or local" >&2; exit 1 ;; esac
      shift 2
      ;;
    --fleet-url)
      FLEET_URL="${2:-}"
      [[ -n "$FLEET_URL" ]] || { echo "ERROR: --fleet-url requires a URL" >&2; exit 1; }
      shift 2
      ;;
    --fleet-token-file)
      FLEET_TOKEN_FILE="${2:-}"
      [[ -n "$FLEET_TOKEN_FILE" ]] || { echo "ERROR: --fleet-token-file requires a path" >&2; exit 1; }
      shift 2
      ;;
    --fleet-enrollment-token-file)
      FLEET_ENROLLMENT_TOKEN_FILE="${2:-}"
      [[ -n "$FLEET_ENROLLMENT_TOKEN_FILE" ]] || { echo "ERROR: --fleet-enrollment-token-file requires a path" >&2; exit 1; }
      shift 2
      ;;
    --fleet-node-id)
      FLEET_NODE_ID="${2:-}"
      [[ -n "$FLEET_NODE_ID" ]] || { echo "ERROR: --fleet-node-id requires a value" >&2; exit 1; }
      shift 2
      ;;
    --fleet-source)
      FLEET_SOURCE="${2:-}"
      [[ -n "$FLEET_SOURCE" ]] || { echo "ERROR: --fleet-source requires a directory" >&2; exit 1; }
      shift 2
      ;;
    --fleet-repository)
      FLEET_REPOSITORY="${2:-}"
      [[ -n "$FLEET_REPOSITORY" ]] || { echo "ERROR: --fleet-repository requires a URL" >&2; exit 1; }
      shift 2
      ;;
    --fleet-ref)
      FLEET_REF="${2:-}"
      [[ -n "$FLEET_REF" ]] || { echo "ERROR: --fleet-ref requires a value" >&2; exit 1; }
      shift 2
      ;;
    --fleet-manager-profile)
      FLEET_MANAGER_PROFILE="${2:-}"
      case "$FLEET_MANAGER_PROFILE" in local|overlay) ;; *) echo "ERROR: --fleet-manager-profile must be local or overlay" >&2; exit 1 ;; esac
      FLEET_MANAGER_PROFILE_SET=1
      shift 2
      ;;
    --fleet-manager-host)
      FLEET_MANAGER_HOST="${2:-}"
      [[ -n "$FLEET_MANAGER_HOST" ]] || { echo "ERROR: --fleet-manager-host requires an IPv4 address" >&2; exit 1; }
      shift 2
      ;;
    --fleet-allow-insecure-http)
      FLEET_ALLOW_INSECURE_HTTP=1
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
PRESERVE_EXISTING_ENV=0
if [[ ! -f "$ENV_FILE" ]]; then
  WRITE_ENV=1
elif [[ "$FORCE_ENV" -eq 1 ]]; then
  WRITE_ENV=1
else
  PRESERVE_EXISTING_ENV=1
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

# -------------------------------------------------------------------
# Interactive: choose this host's Fleet role (default: standalone)
# -------------------------------------------------------------------
if [[ -n "$FLEET_ROLE" && -n "$FLEET_MODE" ]]; then
  echo "ERROR: use --fleet-role or legacy --fleet-mode, not both" >&2
  exit 1
fi

if [[ -z "$FLEET_ROLE" && -n "$FLEET_MODE" ]]; then
  case "$FLEET_MODE" in
    off) FLEET_ROLE="standalone" ;;
    local) FLEET_ROLE="manager" ;;
    external) FLEET_ROLE="external" ;;
  esac
fi

if [[ -z "$FLEET_ROLE" ]]; then
  if [[ "$YES" -eq 1 ]]; then
    FLEET_ROLE="standalone"
  else
    echo "Choose this HermelinChat host's role:"
    echo "  1) Local HermelinChat only (default)"
    echo "  2) New independent FleetManager (central + local node + cockpit)"
    echo "  3) Join a remote FleetManager as a managed node"
    read -r -p "Role [1/2/3] (default: 1): " _fleet_role
    case "${_fleet_role,,}" in
      2|manager|m) FLEET_ROLE="manager" ;;
      3|node|n|join) FLEET_ROLE="node" ;;
      *) FLEET_ROLE="standalone" ;;
    esac
  fi
fi

case "$FLEET_ROLE" in
  standalone) FLEET_MODE="off" ;;
  manager) FLEET_MODE="local" ;;
  node) FLEET_MODE="node" ;;
  external) FLEET_MODE="external" ;;
  *) echo "ERROR: unsupported Fleet role: $FLEET_ROLE" >&2; exit 1 ;;
esac

if [[ "$FLEET_ROLE" == "manager" ]]; then
  if [[ "$FLEET_MANAGER_PROFILE_SET" -eq 0 && "$YES" -eq 0 ]]; then
    read -r -p "Allow other LAN/Tailscale machines to join this manager? [y/N] " _fleet_overlay
    if [[ "${_fleet_overlay,,}" == "y" || "${_fleet_overlay,,}" == "yes" ]]; then
      FLEET_MANAGER_PROFILE="overlay"
    fi
  fi
  if [[ "$FLEET_MANAGER_PROFILE" == "overlay" && -z "$FLEET_MANAGER_HOST" ]]; then
    default_manager_host="$(hostname -I 2>/dev/null | tr ' ' '\n' | sed -n '/^[0-9][0-9.]*$/p' | sed -n '1p')"
    if [[ "$YES" -eq 1 ]]; then
      echo "ERROR: overlay manager mode requires --fleet-manager-host" >&2
      exit 1
    fi
    read -r -p "Private LAN/Tailscale IPv4 advertised by Fleet [${default_manager_host}]: " FLEET_MANAGER_HOST
    FLEET_MANAGER_HOST="${FLEET_MANAGER_HOST:-$default_manager_host}"
    [[ -n "$FLEET_MANAGER_HOST" ]] || { echo "ERROR: overlay manager requires a private IPv4 address" >&2; exit 1; }
  fi
elif [[ "$FLEET_ROLE" == "node" ]]; then
  if [[ -z "$FLEET_URL" && "$YES" -eq 0 ]]; then
    read -r -p "Remote FleetManager URL (for example http://192.168.1.10:8080): " FLEET_URL
  fi
  [[ -n "$FLEET_URL" ]] || { echo "ERROR: node role requires --fleet-url" >&2; exit 1; }
  if [[ -z "$FLEET_NODE_ID" ]]; then
    FLEET_NODE_ID="$(hostname -s 2>/dev/null || hostname)"
  fi
  if [[ -z "$FLEET_ENROLLMENT_TOKEN_FILE" ]]; then
    if [[ "$YES" -eq 1 ]]; then
      echo "ERROR: noninteractive node role requires --fleet-enrollment-token-file" >&2
      exit 1
    fi
    echo "On the FleetManager, run: fleet-enroll $FLEET_NODE_ID"
    read -r -s -p "Paste the fresh five-minute enrollment token: " FLEET_ENROLLMENT_TOKEN_STDIN_VALUE
    echo
    [[ -n "$FLEET_ENROLLMENT_TOKEN_STDIN_VALUE" ]] || { echo "ERROR: Fleet enrollment token cannot be empty" >&2; exit 1; }
  fi
elif [[ "$FLEET_ROLE" == "external" ]]; then
  if [[ -z "$FLEET_URL" && "$YES" -eq 0 ]]; then
    read -r -p "HermelinFleet central URL (HTTPS or private/loopback HTTP): " FLEET_URL
  fi
  [[ -n "$FLEET_URL" ]] || { echo "ERROR: external Fleet mode requires --fleet-url" >&2; exit 1; }
  if [[ -z "$FLEET_TOKEN_FILE" ]]; then
    if [[ "$YES" -eq 1 ]]; then
      echo "ERROR: noninteractive external Fleet mode requires --fleet-token-file" >&2
      exit 1
    fi
    read -r -s -p "HermelinFleet scoped service credential: " FLEET_TOKEN_STDIN_VALUE
    echo
    [[ -n "$FLEET_TOKEN_STDIN_VALUE" ]] || { echo "ERROR: Fleet credential cannot be empty" >&2; exit 1; }
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
echo "  - HermelinFleet role: $FLEET_ROLE"
if [[ "$FLEET_ROLE" == "external" || "$FLEET_ROLE" == "node" ]]; then
  echo "    endpoint: $FLEET_URL"
elif [[ "$FLEET_ROLE" == "manager" ]]; then
  if [[ -n "$FLEET_SOURCE" ]]; then
    echo "    source: $FLEET_SOURCE"
  else
    echo "    source: automatic clone ($FLEET_REPOSITORY @ $FLEET_REF)"
  fi
  echo "    manager profile: $FLEET_MANAGER_PROFILE"
  if [[ "$FLEET_MANAGER_PROFILE" == "overlay" ]]; then
    echo "    advertised host: $FLEET_MANAGER_HOST"
  fi
  echo "    managed service: hermelinfleet-central.service"
fi
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

# Browser login session lifetime in seconds. Open tabs renew this via /api/auth/me.
# Default: 43200 (12 hours)
# HERMELIN_SESSION_TTL_SECONDS=43200

# Hermes integration
HERMES_HOME=$DEFAULT_HERMES_HOME
HERMELIN_HERMES_CMD="$DEFAULT_HERMES_EXE chat --toolsets \"hermes-cli, artifacts\""

# Artifact JSON read cap in bytes (8 MiB). Raise only if you trust the artifacts.
HERMELIN_ARTIFACT_READ_MAX_FILE_BYTES=8388608

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

# Configure optional Fleet integration before service unit generation. Secrets are
# read from a protected file or stdin and never placed in argv.
FLEET_CONFIG_ARGS=(--env-file "$ENV_FILE" --mode "$FLEET_MODE")
if [[ "$FLEET_ALLOW_INSECURE_HTTP" -eq 1 ]]; then
  FLEET_CONFIG_ARGS+=(--allow-insecure-http)
fi
case "$FLEET_MODE" in
  off)
    python3 "$SELF_DIR/configure_fleet.py" "${FLEET_CONFIG_ARGS[@]}"
    ;;
  external)
    FLEET_CONFIG_ARGS+=(--url "$FLEET_URL")
    if [[ -n "$FLEET_TOKEN_FILE" ]]; then
      python3 "$SELF_DIR/configure_fleet.py" "${FLEET_CONFIG_ARGS[@]}" --token-file "$FLEET_TOKEN_FILE"
    else
      printf '%s' "$FLEET_TOKEN_STDIN_VALUE" | python3 "$SELF_DIR/configure_fleet.py" "${FLEET_CONFIG_ARGS[@]}" --token-stdin
    fi
    FLEET_TOKEN_STDIN_VALUE=""
    ;;
  node)
    FLEET_CONFIG_ARGS+=(--url "$FLEET_URL" --node-id "$FLEET_NODE_ID")
    if [[ -n "$FLEET_ENROLLMENT_TOKEN_FILE" ]]; then
      python3 "$SELF_DIR/configure_fleet.py" "${FLEET_CONFIG_ARGS[@]}" --token-file "$FLEET_ENROLLMENT_TOKEN_FILE"
    else
      printf '%s' "$FLEET_ENROLLMENT_TOKEN_STDIN_VALUE" | python3 "$SELF_DIR/configure_fleet.py" "${FLEET_CONFIG_ARGS[@]}" --token-stdin
    fi
    FLEET_ENROLLMENT_TOKEN_STDIN_VALUE=""
    ;;
  local)
    FLEET_CONFIG_ARGS+=(
      --manager-profile "$FLEET_MANAGER_PROFILE"
      --fleet-repository "$FLEET_REPOSITORY"
      --fleet-ref "$FLEET_REF"
    )
    if [[ -n "$FLEET_SOURCE" ]]; then
      FLEET_CONFIG_ARGS+=(--fleet-source "$FLEET_SOURCE")
    fi
    if [[ "$FLEET_MANAGER_PROFILE" == "overlay" ]]; then
      FLEET_CONFIG_ARGS+=(--manager-host "$FLEET_MANAGER_HOST")
    fi
    PATH="$HOME/.local/go/bin:$PATH" python3 "$SELF_DIR/configure_fleet.py" "${FLEET_CONFIG_ARGS[@]}"
    ;;
esac

# -------------------------------------------------------------------
# Ensure env file contains systemd-friendly Hermes command
# -------------------------------------------------------------------
# Under systemd, PATH does not include ~/.local/bin by default (no bashrc).
# If HERMELIN_HERMES_CMD is missing (or set to plain "hermes ..."), PTY spawn
# fails with: FileNotFoundError: 'hermes'
if [[ -f "$ENV_FILE" && "$PRESERVE_EXISTING_ENV" -eq 0 ]]; then
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

if not (get("HERMELIN_ARTIFACT_READ_MAX_FILE_BYTES") or "").strip():
    set_key("HERMELIN_ARTIFACT_READ_MAX_FILE_BYTES", "8388608")

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
if [[ "$PRESERVE_EXISTING_ENV" -eq 1 ]]; then
  echo "==> preserving existing non-Fleet env settings"
elif [[ "$SKIP_PYTHON" -eq 1 ]]; then
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

FLEET_UNIT_AFTER=""
FLEET_UNIT_WANTS=""
if [[ "$FLEET_MODE" == "local" && "$INSTALL_SERVICE" -eq 1 && "$SERVICE_MODE" != "user" ]]; then
  echo "ERROR: local HermelinFleet is installed as a user service; use --user-service for hermelinChat or choose external Fleet." >&2
  exit 1
fi
if [[ "$FLEET_MODE" == "local" ]]; then
  FLEET_UNIT_AFTER=" hermelinfleet-central.service"
  FLEET_UNIT_WANTS="Wants=hermelinfleet-central.service"
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
After=network-online.target$FLEET_UNIT_AFTER
Wants=network-online.target
$FLEET_UNIT_WANTS

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
After=network-online.target$FLEET_UNIT_AFTER
Wants=network-online.target
$FLEET_UNIT_WANTS

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
