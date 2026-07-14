#!/usr/bin/env bash

# Shared Go prerequisite helpers for the HermelinChat/Fleet installer.
# These functions never invoke sudo unless hermelin_install_go_package is called
# explicitly after the installer has shown and confirmed its plan.

hermelin_go_package_family() {
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
    *" debian "*|*" ubuntu "*) echo "debian"; return 0 ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) echo "fedora"; return 0 ;;
    *" arch "*|*" archlinux "*|*" manjaro "*|*" endeavouros "*) echo "arch"; return 0 ;;
    *" suse "*|*" opensuse "*|*" sles "*) echo "suse"; return 0 ;;
  esac

  if command -v apt-get >/dev/null 2>&1; then echo "debian"; return 0; fi
  if command -v dnf >/dev/null 2>&1; then echo "fedora"; return 0; fi
  if command -v pacman >/dev/null 2>&1; then echo "arch"; return 0; fi
  if command -v zypper >/dev/null 2>&1; then echo "suse"; return 0; fi
  return 1
}

hermelin_go_install_command() {
  local family
  family="$(hermelin_go_package_family)" || return 1
  case "$family" in
    debian) echo "sudo apt-get update && sudo apt-get install -y golang-go" ;;
    fedora) echo "sudo dnf install -y golang" ;;
    arch) echo "sudo pacman -S --needed go" ;;
    suse) echo "sudo zypper --non-interactive install go" ;;
    *) return 1 ;;
  esac
}

hermelin_find_go() {
  if command -v go >/dev/null 2>&1; then
    command -v go
    return 0
  fi
  if [[ -x "${HOME:-}/.local/go/bin/go" ]]; then
    printf '%s\n' "$HOME/.local/go/bin/go"
    return 0
  fi
  return 1
}

hermelin_go_version_text() {
  local go_bin="${1:-}"
  [[ -n "$go_bin" && -x "$go_bin" ]] || return 1
  "$go_bin" version 2>/dev/null
}

hermelin_go_meets_minimum() {
  local go_bin="${1:-}"
  local output=""
  local major=""
  local minor=""
  output="$(hermelin_go_version_text "$go_bin")" || return 1
  if [[ "$output" =~ go([0-9]+)\.([0-9]+) ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    if (( major > 1 || (major == 1 && minor >= 22) )); then
      return 0
    fi
  fi
  return 1
}

hermelin_install_go_package() {
  local family
  command -v sudo >/dev/null 2>&1 || {
    echo "ERROR: sudo is required for automatic Go package installation." >&2
    return 1
  }
  family="$(hermelin_go_package_family)" || {
    echo "ERROR: no supported system package manager was detected for Go installation." >&2
    return 1
  }

  case "$family" in
    debian)
      sudo apt-get update
      sudo apt-get install -y golang-go
      ;;
    fedora)
      sudo dnf install -y golang
      ;;
    arch)
      sudo pacman -S --needed go
      ;;
    suse)
      sudo zypper --non-interactive install go
      ;;
    *) return 1 ;;
  esac
}

hermelin_print_go_fix_help() {
  local install_cmd=""
  echo "HermelinFleet manager mode requires Go 1.22 or newer to build its pinned source checkout." >&2
  if install_cmd="$(hermelin_go_install_command)"; then
    echo "Suggested command for this system: ${install_cmd}" >&2
  else
    echo "Install Go 1.22+ using your system package manager or https://go.dev/dl/." >&2
  fi
  echo "After Go is installed, rerun ./scripts/install.sh and choose Fleet role 2 again." >&2
}
