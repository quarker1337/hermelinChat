#!/usr/bin/env bash

hermelin_platform_name() {
  if [[ -n "${HERMELIN_PLATFORM:-}" ]]; then
    printf '%s\n' "$HERMELIN_PLATFORM"
    return 0
  fi

  case "$(uname -s 2>/dev/null || true)" in
    Darwin)
      echo "macos"
      ;;
    Linux)
      echo "linux"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

hermelin_python_is_supported() {
  local python_bin="${1:-}"
  [[ -n "$python_bin" ]] || return 1
  "$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

hermelin_find_supported_python() {
  local candidate=""

  if [[ -n "${HERMELIN_PYTHON:-}" ]]; then
    if hermelin_python_is_supported "$HERMELIN_PYTHON"; then
      printf '%s\n' "$HERMELIN_PYTHON"
      return 0
    fi
    return 1
  fi

  for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1 && hermelin_python_is_supported "$candidate"; then
      command -v "$candidate"
      return 0
    fi
  done

  return 1
}

hermelin_python_venv_install_command() {
  local os_release_file="${HERMELIN_OS_RELEASE_FILE:-/etc/os-release}"
  local id=""
  local id_like=""
  local haystack=""

  if [[ "$(hermelin_platform_name)" == "macos" ]]; then
    echo "brew install python"
    return 0
  fi

  if [[ -r "$os_release_file" ]]; then
    id="$(sed -n 's/^ID=//p' "$os_release_file" | head -n1 | tr -d '"')"
    id_like="$(sed -n 's/^ID_LIKE=//p' "$os_release_file" | head -n1 | tr -d '"')"
  fi

  haystack=" ${id} ${id_like} "

  case "$haystack" in
    *" debian "*|*" ubuntu "*)
      echo "sudo apt install python3-venv"
      return 0
      ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*)
      echo "sudo dnf install python3 python3-pip"
      return 0
      ;;
    *" arch "*|*" archlinux "*|*" manjaro "*|*" endeavouros "*)
      echo "sudo pacman -S python python-pip"
      return 0
      ;;
  esac

  if command -v apt-get >/dev/null 2>&1 || command -v apt >/dev/null 2>&1; then
    echo "sudo apt install python3-venv"
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    echo "sudo dnf install python3 python3-pip"
    return 0
  fi
  if command -v pacman >/dev/null 2>&1; then
    echo "sudo pacman -S python python-pip"
    return 0
  fi

  return 1
}

hermelin_print_python_venv_fix_help() {
  echo "Install Python 3.10 or newer with venv support, then rerun ./scripts/update.sh (or rerun ./scripts/install.sh)." >&2

  local install_cmd
  if install_cmd="$(hermelin_python_venv_install_command)"; then
    echo "Suggested command for this system: ${install_cmd}" >&2
  else
    echo "Suggested packages: Python 3, venv support, and pip/ensurepip support from your distro." >&2
  fi
}
