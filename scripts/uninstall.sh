#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SELF_DIR}/.." && pwd)"

SERVICE="hermelin"
REMOVE_SERVICE=0
KEEP_VENV=0
KEEP_STATIC=0
REMOVE_NODE_MODULES=0
PURGE_DATA=0
REMOVE_CRONJOBS=0
UNPATCH_HERMES=0
YES=0

usage() {
  cat <<EOF
Usage: ./scripts/uninstall.sh [options]

This removes local hermelinChat runtime artifacts so you can reinstall cleanly.

Options:
  --service NAME          systemd service name (default: hermelin)
  --remove-service        Stop + disable service and attempt to remove the unit file
  --keep-venv             Do not delete .venv/
  --keep-static           Do not delete hermelin/static/
  --remove-node-modules   Delete frontend/node_modules/
  --purge-data            Delete hermelinChat data in Hermes home (meta DB + artifacts dir)
  --remove-cronjobs       Remove hermelinChat-installed Hermes cron jobs (autotitle + whispers)
  --unpatch-hermes        Undo the Hermes artifact tool patch (render_panel/close_panel)
  -y, --yes               Do not prompt for confirmation
  -h, --help              Show help

Examples:
  ./scripts/uninstall.sh --yes
  ./scripts/uninstall.sh --remove-service --purge-data --remove-node-modules --unpatch-hermes --remove-cronjobs --yes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE="${2:-}"
      if [[ -z "$SERVICE" ]]; then
        echo "ERROR: --service requires a name" >&2
        exit 1
      fi
      shift 2
      ;;
    --remove-service)
      REMOVE_SERVICE=1
      shift
      ;;
    --keep-venv)
      KEEP_VENV=1
      shift
      ;;
    --keep-static)
      KEEP_STATIC=1
      shift
      ;;
    --remove-node-modules)
      REMOVE_NODE_MODULES=1
      shift
      ;;
    --purge-data)
      PURGE_DATA=1
      shift
      ;;
    --remove-cronjobs)
      REMOVE_CRONJOBS=1
      shift
      ;;
    --unpatch-hermes)
      UNPATCH_HERMES=1
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

echo "==> hermelinChat uninstall"
echo "    root: $ROOT_DIR"
echo

echo "Planned actions:"
echo "  - stop service (if running): $SERVICE"
if [[ "$REMOVE_SERVICE" -eq 1 ]]; then
  echo "  - disable + remove service unit file: yes"
else
  echo "  - disable + remove service unit file: no (pass --remove-service)"
fi

if [[ "$KEEP_VENV" -eq 0 ]]; then
  echo "  - remove .venv/: yes"
else
  echo "  - remove .venv/: no (keep)"
fi

if [[ "$KEEP_STATIC" -eq 0 ]]; then
  echo "  - remove hermelin/static/: yes"
else
  echo "  - remove hermelin/static/: no (keep)"
fi

if [[ "$REMOVE_NODE_MODULES" -eq 1 ]]; then
  echo "  - remove frontend/node_modules/: yes"
else
  echo "  - remove frontend/node_modules/: no (pass --remove-node-modules)"
fi

if [[ "$PURGE_DATA" -eq 1 ]]; then
  echo "  - purge Hermes-home data (meta DB + artifacts): yes"
else
  echo "  - purge Hermes-home data (meta DB + artifacts): no (pass --purge-data)"
fi

if [[ "$REMOVE_CRONJOBS" -eq 1 ]]; then
  echo "  - remove Hermes cronjobs (hermelin-autotitle + hermelin-whispers): yes"
else
  echo "  - remove Hermes cronjobs: no (pass --remove-cronjobs)"
fi

if [[ "$UNPATCH_HERMES" -eq 1 ]]; then
  echo "  - unpatch Hermes artifact tools (render_panel/close_panel): yes"
else
  echo "  - unpatch Hermes artifact tools: no (pass --unpatch-hermes)"
fi

echo

if [[ "$YES" -eq 0 ]]; then
  read -r -p "Proceed? [y/N] " ans
  if [[ "${ans,,}" != "y" && "${ans,,}" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

stop_service() {
  local mode="$1"  # user|system
  local prefix="system"

  # For systemd system services, we avoid sudo until we know the unit exists.
  local sc=(systemctl)
  local sc_root=(sudo systemctl)

  if [[ "$mode" == "user" ]]; then
    prefix="user"
    sc=(systemctl --user)
    sc_root=(systemctl --user)
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi

  # Check if the service unit exists in this mode (no sudo needed).
  if ! "${sc[@]}" list-unit-files 2>/dev/null | grep -q "^${SERVICE}\\.service"; then
    return 0
  fi

  echo "==> stopping ${prefix} service: ${SERVICE}"
  if [[ "$mode" == "user" ]]; then
    "${sc_root[@]}" stop "${SERVICE}" >/dev/null 2>&1 || true
  else
    if command -v sudo >/dev/null 2>&1; then
      "${sc_root[@]}" stop "${SERVICE}" >/dev/null 2>&1 || true
    else
      echo "WARNING: sudo not found; cannot stop system service '${SERVICE}'." >&2
    fi
  fi

  if [[ "$REMOVE_SERVICE" -eq 1 ]]; then
    echo "==> disabling ${prefix} service: ${SERVICE}"
    if [[ "$mode" == "user" ]]; then
      "${sc_root[@]}" disable "${SERVICE}" >/dev/null 2>&1 || true
    else
      if command -v sudo >/dev/null 2>&1; then
        "${sc_root[@]}" disable "${SERVICE}" >/dev/null 2>&1 || true
      else
        echo "WARNING: sudo not found; cannot disable system service '${SERVICE}'." >&2
      fi
    fi

    local frag
    frag="$("${sc[@]}" show -p FragmentPath "${SERVICE}" 2>/dev/null | cut -d= -f2)"
    if [[ -n "$frag" && "$frag" != "/dev/null" && -f "$frag" ]]; then
      echo "==> removing ${prefix} unit file: $frag"
      if [[ "$mode" == "user" ]]; then
        rm -f "$frag" || true
      else
        if command -v sudo >/dev/null 2>&1; then
          sudo rm -f "$frag" || true
        else
          echo "WARNING: sudo not found; cannot remove system unit file: $frag" >&2
        fi
      fi
    fi

    echo "==> daemon-reload (${prefix})"
    if [[ "$mode" == "user" ]]; then
      "${sc_root[@]}" daemon-reload >/dev/null 2>&1 || true
      "${sc_root[@]}" reset-failed "${SERVICE}" >/dev/null 2>&1 || true
    else
      if command -v sudo >/dev/null 2>&1; then
        "${sc_root[@]}" daemon-reload >/dev/null 2>&1 || true
        "${sc_root[@]}" reset-failed "${SERVICE}" >/dev/null 2>&1 || true
      else
        echo "WARNING: sudo not found; cannot daemon-reload systemd." >&2
      fi
    fi
  fi
}

# Stop running service (prefer user, then system)
stop_service "user"
stop_service "system"

if [[ "$KEEP_VENV" -eq 0 && -d .venv ]]; then
  echo "==> removing .venv/"
  rm -rf .venv
fi

if [[ "$KEEP_STATIC" -eq 0 && -d hermelin/static ]]; then
  echo "==> removing hermelin/static/"
  rm -rf hermelin/static
fi

if [[ "$REMOVE_NODE_MODULES" -eq 1 && -d frontend/node_modules ]]; then
  echo "==> removing frontend/node_modules/"
  rm -rf frontend/node_modules
fi

if [[ "$REMOVE_CRONJOBS" -eq 1 ]]; then
  echo "==> removing hermelinChat Hermes cron jobs"
  python3 scripts/uninstall_hermelin_cronjobs.py || true
fi

if [[ "$UNPATCH_HERMES" -eq 1 ]]; then
  echo "==> unpatching Hermes artifact tools"
  python3 scripts/uninstall_hermes_artifact_patch.py || true
fi

if [[ "$PURGE_DATA" -eq 1 ]]; then
  echo "==> purging hermelinChat data in Hermes home"

  HERMES_HOME_DIR="${HERMES_HOME:-}"
  META_DB_PATH="${HERMELIN_META_DB_PATH:-}"

  if [[ -z "$HERMES_HOME_DIR" && -f .hermelin.env ]]; then
    HERMES_HOME_DIR="$(grep -E '^HERMES_HOME=' .hermelin.env | tail -n1 | sed 's/^HERMES_HOME=//' | tr -d '\r' | sed 's/^"//;s/"$//')"
  fi

  if [[ -z "$HERMES_HOME_DIR" ]]; then
    HERMES_HOME_DIR="$HOME/.hermes"
  fi

  if [[ -z "$META_DB_PATH" && -f .hermelin.env ]]; then
    META_DB_PATH="$(grep -E '^HERMELIN_META_DB_PATH=' .hermelin.env | tail -n1 | sed 's/^HERMELIN_META_DB_PATH=//' | tr -d '\r' | sed 's/^"//;s/"$//')"
  fi

  if [[ -z "$META_DB_PATH" ]]; then
    META_DB_PATH="$HERMES_HOME_DIR/hermelin_meta.db"
  fi

  echo "    HERMES_HOME: $HERMES_HOME_DIR"
  echo "    META_DB:     $META_DB_PATH"

  rm -f "$META_DB_PATH" "$META_DB_PATH-wal" "$META_DB_PATH-shm" 2>/dev/null || true

  if [[ -d "$HERMES_HOME_DIR/artifacts" ]]; then
    rm -rf "$HERMES_HOME_DIR/artifacts"
  fi
fi

echo

echo "==> uninstall complete"
echo "Next steps (reinstall):"
echo "  ./scripts/update.sh"
echo "  (optionally) ./scripts/update.sh --restart"
