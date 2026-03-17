#!/usr/bin/env bash

hermelin_python_venv_install_command() {
  local os_release_file="${HERMELIN_OS_RELEASE_FILE:-/etc/os-release}"
  local id=""
  local id_like=""
  local haystack=""

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
  echo "Install the required Python/venv system package(s), then rerun ./scripts/update.sh (or rerun ./scripts/install.sh)." >&2

  local install_cmd
  if install_cmd="$(hermelin_python_venv_install_command)"; then
    echo "Suggested command for this system: ${install_cmd}" >&2
  else
    echo "Suggested packages: Python 3, venv support, and pip/ensurepip support from your distro." >&2
  fi
}
