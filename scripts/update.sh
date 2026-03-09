#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SELF_DIR}/.." && pwd)"

RESTART=0
SERVICE="hermelin"
SKIP_FRONTEND=0
SKIP_PYTHON=0
SKIP_HERMES_PATCH=0
SKIP_HERMES_THEMES=0
NO_PULL=0

usage() {
  cat <<EOF
Usage: ./scripts/update.sh [options]

Options:
  --restart            Restart systemd service after updating (default service: hermelin)
  --service NAME       systemd service name to restart (default: hermelin)
  --skip-frontend       Skip npm install/build
  --skip-python         Skip pip install -e .
  --skip-hermes-patch   Skip patching the active Hermes installation with artifact tools
  --skip-hermes-themes  Skip patching Hermes CLI with theme system + installing themes
  --no-pull             Skip git pull
  -h, --help            Show help

Notes:
- Exits if the git working tree has local changes (to avoid accidental merges).
- Builds the frontend into hermelin/static/ (required for single-port mode).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart)
      RESTART=1
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
    --skip-hermes-themes)
      SKIP_HERMES_THEMES=1
      shift
      ;;
    --no-pull)
      NO_PULL=1
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

echo "==> hermilinChat update"
echo "    root: $ROOT_DIR"

test -f pyproject.toml || {
  echo "ERROR: pyproject.toml not found. Are you in the hermilinChat repo?" >&2
  exit 1
}

if [[ "$NO_PULL" -eq 0 ]]; then
  if command -v git >/dev/null 2>&1; then
    if [[ -n "$(git status --porcelain=v1)" ]]; then
      echo "ERROR: git working tree has local changes. Commit or stash before updating." >&2
      git status --porcelain=v1 >&2
      exit 1
    fi
    echo "==> git pull --ff-only"
    git pull --ff-only
  else
    echo "WARNING: git not found; skipping pull." >&2
  fi
fi

if [[ "$SKIP_PYTHON" -eq 0 ]]; then
  echo "==> python: install/update backend deps"

  if [[ ! -x .venv/bin/python ]]; then
    if ! command -v python3 >/dev/null 2>&1; then
      echo "ERROR: python3 not found (needed to create .venv)." >&2
      exit 1
    fi
    echo "==> creating venv: .venv"
    python3 -m venv .venv || {
      echo "ERROR: failed to create venv. On Debian/Ubuntu you may need: sudo apt install python3-venv" >&2
      exit 1
    }
  fi

  # shellcheck disable=SC1091
  source .venv/bin/activate

  # Some environments (notably uv-created venvs) may not include pip.
  if ! python -m pip --version >/dev/null 2>&1; then
    echo "==> pip missing in .venv; bootstrapping with ensurepip"
    python -m ensurepip --upgrade >/dev/null 2>&1 || true
  fi

  if python -m pip --version >/dev/null 2>&1; then
    python -m pip install -U pip
    python -m pip install -e .
  elif command -v uv >/dev/null 2>&1; then
    echo "==> pip still unavailable; using uv pip"
    uv pip install -e .
  else
    echo "ERROR: pip is missing in .venv and could not be bootstrapped." >&2
    echo "Fix options:" >&2
    echo "  - Recreate the venv: rm -rf .venv && python3 -m venv .venv" >&2
    echo "  - On Debian/Ubuntu install: sudo apt install python3-venv" >&2
    echo "  - Or install uv (https://docs.astral.sh/uv/) and rerun" >&2
    exit 1
  fi
fi

if [[ "$SKIP_HERMES_PATCH" -eq 0 ]]; then
  echo "==> patching active Hermes installation for artifact tools"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found (needed for Hermes artifact patch installer)." >&2
    exit 1
  fi
  python3 scripts/install_hermes_artifact_patch.py
fi

if [[ "$SKIP_HERMES_THEMES" -eq 0 ]]; then
  echo "==> patching active Hermes installation for CLI themes + installing theme YAMLs"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found (needed for Hermes theme installer)." >&2
    exit 1
  fi
  python3 scripts/install_hermes_themes.py --auto
fi

if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
  echo "==> node: build frontend -> hermelin/static/"

  if ! command -v npm >/dev/null 2>&1; then
    echo "WARNING: npm not found; skipping frontend build. Single-port mode may serve an old/missing UI." >&2
  else
    pushd frontend >/dev/null

    if [[ -f package-lock.json ]]; then
      npm ci || npm install
    else
      npm install
    fi

    npm run build
    popd >/dev/null
  fi
fi

echo "==> update complete"

if [[ "$RESTART" -eq 1 ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "WARNING: systemctl not found; restart the server manually." >&2
    exit 0
  fi

  echo "==> restarting service: $SERVICE"

  # Prefer user service if it exists and systemd user session is available.
  if systemctl --user list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
    systemctl --user restart "$SERVICE"
    systemctl --user --no-pager status "$SERVICE" || true
  else
    sudo systemctl restart "$SERVICE"
    sudo systemctl --no-pager status "$SERVICE" || true
  fi
else
  echo "Restart your running server to pick up changes. systemd examples:"
  echo "  sudo systemctl restart $SERVICE"
  echo "  systemctl --user restart $SERVICE"
fi
