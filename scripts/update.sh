#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SELF_DIR}/.." && pwd)"

RESTART=0
SERVICE="hermelin"
SKIP_FRONTEND=0
SKIP_PYTHON=0
SKIP_HERMES_PATCH=0
SKIP_HERMES_SKINS=0
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
  --skip-hermes-skins   Skip installing hermelinChat CLI skins into ~/.hermes/skins/
  --skip-hermes-themes  (deprecated alias for --skip-hermes-skins)
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
    --skip-hermes-skins|--skip-hermes-themes)
      SKIP_HERMES_SKINS=1
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

echo "==> hermelinChat update"
echo "    root: $ROOT_DIR"

test -f pyproject.toml || {
  echo "ERROR: pyproject.toml not found. Are you in the hermelinChat repo?" >&2
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

  VENV_DIR=".venv"
  VENV_PY="${VENV_DIR}/bin/python"
  VENV_ACTIVATE="${VENV_DIR}/bin/activate"

  # If a previous venv creation failed (common when python3-venv/ensurepip is missing),
  # Debian can leave a partial .venv behind that has bin/python but no activate/pip.
  # Detect that and recreate automatically.
  if [[ -d "$VENV_DIR" ]]; then
    if [[ ! -x "$VENV_PY" || ! -f "$VENV_ACTIVATE" ]]; then
      echo "WARNING: $VENV_DIR exists but looks incomplete (missing python/activate). Recreating venv."
      rm -rf "$VENV_DIR"
    fi
  fi

  if [[ ! -x "$VENV_PY" ]]; then
    if ! command -v python3 >/dev/null 2>&1; then
      echo "ERROR: python3 not found (needed to create .venv)." >&2
      exit 1
    fi
    echo "==> creating venv: $VENV_DIR"
    python3 -m venv "$VENV_DIR" || {
      rm -rf "$VENV_DIR" || true
      echo "ERROR: failed to create venv. On Debian/Ubuntu you may need: sudo apt install python3-venv" >&2
      exit 1
    }
  fi

  if [[ ! -f "$VENV_ACTIVATE" ]]; then
    echo "ERROR: $VENV_ACTIVATE not found. The venv appears corrupted." >&2
    echo "Try: rm -rf $VENV_DIR" >&2
    hermelin_print_python_venv_fix_help
    exit 1
  fi

  # shellcheck disable=SC1091
  source "$VENV_ACTIVATE"

  USE_PIP=0
  if command -v uv >/dev/null 2>&1; then
    echo "==> using uv pip for backend deps"
    if ! uv pip install -e .; then
      echo "WARNING: uv pip install failed; falling back to python -m pip" >&2
      USE_PIP=1
    fi
  else
    USE_PIP=1
  fi

  if [[ "$USE_PIP" -eq 1 ]]; then
    # Some environments (notably uv-created venvs) may not include pip.
    if ! python -m pip --version >/dev/null 2>&1; then
      echo "==> pip missing in .venv; bootstrapping with ensurepip"
      python -m ensurepip --upgrade >/dev/null 2>&1 || true
    fi

    if python -m pip --version >/dev/null 2>&1; then
      python -m pip install -e .
    else
      echo "ERROR: pip is missing in .venv and could not be bootstrapped." >&2
      echo "Fix options:" >&2
      echo "  - Recreate the venv: rm -rf $VENV_DIR && python3 -m venv $VENV_DIR" >&2
      echo "  - Install the required system package(s), then rerun ./scripts/update.sh (or rerun ./scripts/install.sh)." >&2
      if install_cmd="$(hermelin_python_venv_install_command)"; then
        echo "    Suggested command: ${install_cmd}" >&2
      fi
      echo "  - Or install uv (https://docs.astral.sh/uv/) and rerun" >&2
      exit 1
    fi
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

if [[ "$SKIP_HERMES_SKINS" -eq 0 ]]; then
  echo "==> installing hermelinChat skins into Hermes (~/.hermes/skins/)"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found (needed for Hermes skin installer)." >&2
    exit 1
  fi
  python3 scripts/install_hermes_skins.py --auto --force
fi

if [[ "$SKIP_FRONTEND" -eq 0 ]]; then
  echo "==> node: ensure native Hermes dashboard frontend"
  if ! command -v hermes >/dev/null 2>&1; then
    echo "WARNING: hermes not found; skipping native dashboard frontend check." >&2
  elif ! command -v python3 >/dev/null 2>&1; then
    echo "WARNING: python3 not found; skipping native dashboard frontend check." >&2
  else
    if command -v npm >/dev/null 2>&1; then
      HERMELIN_NPM_AVAILABLE=1
    else
      HERMELIN_NPM_AVAILABLE=0
    fi
    HERMELIN_ACTIVE_HERMES_EXE="$(command -v hermes)" HERMELIN_NPM_AVAILABLE="$HERMELIN_NPM_AVAILABLE" python3 - <<'PY'
import os
import importlib.util
import subprocess
import sys
from pathlib import Path

hermes_exe = Path(os.environ["HERMELIN_ACTIVE_HERMES_EXE"])
npm_available = os.environ.get("HERMELIN_NPM_AVAILABLE") == "1"
try:
    patch_installer = Path.cwd() / "scripts" / "install_hermes_artifact_patch.py"
    spec = importlib.util.spec_from_file_location("hermelin_hermes_artifact_patch", patch_installer)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load Hermes patch installer helpers from {patch_installer}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    hermes_python = module._detect_hermes_python(hermes_exe, "")
except Exception as exc:
    print(f"WARNING: could not inspect Hermes launcher for dashboard build: {exc}", file=sys.stderr)
    sys.exit(0)

code = r'''
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import hermes_cli.main as main
except Exception as exc:
    print(f"WARNING: could not import hermes_cli.main for dashboard build: {exc}", file=sys.stderr)
    sys.exit(0)

project_root = Path(main.PROJECT_ROOT)
web_dir = project_root / "web"
dist_index = project_root / "hermes_cli" / "web_dist" / "index.html"
npm_available = os.environ.get("HERMELIN_NPM_AVAILABLE") == "1"

if not (web_dir / "package.json").exists():
    print(f"WARNING: active Hermes install has no dashboard web/package.json at {web_dir}; skipping native dashboard build check.", file=sys.stderr)
    sys.exit(0)

try:
    build_needed_fn = getattr(main, "_web_ui_build_needed", None)
    build_needed = bool(build_needed_fn(web_dir)) if callable(build_needed_fn) else not dist_index.exists()
except Exception as exc:
    print(f"WARNING: could not determine whether native Hermes dashboard frontend is stale: {exc}", file=sys.stderr)
    build_needed = not dist_index.exists()

if not build_needed:
    print("  ✓ Native Hermes dashboard frontend already built")
    sys.exit(0)

if not npm_available:
    print("WARNING: Native Hermes dashboard frontend is missing/stale, and npm is not available to build it.", file=sys.stderr)
    print(f"         Hermes install: {project_root}", file=sys.stderr)
    print("         This can happen when the Hermes Agent installer did not prebuild the dashboard web UI.", file=sys.stderr)
    print("         Fix options:", file=sys.stderr)
    print("           - Run `hermes update` from a shell where Node.js/npm is available", file=sys.stderr)
    print(f"           - Or run: cd {web_dir} && npm install && npm run build", file=sys.stderr)
    print("         If hermelinChat runs as a systemd service, run the build as that service user, then restart hermelinChat.", file=sys.stderr)
    sys.exit(0)

try:
    build_fn = getattr(main, "_build_web_ui", None)
    if callable(build_fn):
        ok = build_fn(web_dir, fatal=True)
    else:
        npm = shutil.which("npm")
        if not npm:
            print("ERROR: npm disappeared while preparing to build the native Hermes dashboard frontend.", file=sys.stderr)
            sys.exit(1)
        install = subprocess.run([npm, "install", "--silent"], cwd=web_dir, check=False)
        build = subprocess.run([npm, "run", "build"], cwd=web_dir, check=False) if install.returncode == 0 else install
        ok = build.returncode == 0
except Exception as exc:
    print(f"ERROR: failed to build native Hermes dashboard frontend: {exc}", file=sys.stderr)
    sys.exit(1)
sys.exit(0 if ok else 1)
'''
env = os.environ.copy()
env["HERMELIN_NPM_AVAILABLE"] = "1" if npm_available else "0"
result = subprocess.run([str(hermes_python), "-c", code], check=False, env=env)
sys.exit(result.returncode)
PY
  fi
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
