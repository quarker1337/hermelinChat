#!/usr/bin/env python3
"""
install_hermes_themes.py — Post-install patcher for Hermes Agent CLI theming.

Run this ONCE after installing or updating hermes-agent.  It patches cli.py to:

  1. Add a --themefile <path> argument so your GUI/wrapper can pick themes at
     startup (defaults to ~/.hermes/theme.yaml if it exists, otherwise the
     baked-in colours).

  2. Replace all hardcoded colours, logos, caduceus, branding, and
     prompt_toolkit styles in cli.py with values loaded from a theme YAML at
     startup time.

Usage:
    # Patch cli.py in-place (uses the default hermes-gold baked-in values):
    python install_hermes_themes.py /path/to/hermes-agent/cli.py

    # Patch and bake in a different default theme:
    python install_hermes_themes.py /path/to/hermes-agent/cli.py --default-theme hermiline.yaml

    # Just show what would change (dry-run):
    python install_hermes_themes.py /path/to/hermes-agent/cli.py --dry-run

    # List bundled themes:
    python install_hermes_themes.py --list-themes

    # Export a starter theme YAML:
    python install_hermes_themes.py --export-theme hermiline > hermiline.yaml

After patching, Hermes accepts:
    hermes --themefile /path/to/mytheme.yaml
    hermes --themefile hermiline.yaml          # looked up in ~/.hermes/themes/
    hermes                                     # uses ~/.hermes/theme.yaml or baked-in default
"""

from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from datetime import datetime

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
REPO_THEMES_DIR = REPO_ROOT / "themes"

# ---------------------------------------------------------------------------
# Theme data
# ---------------------------------------------------------------------------

HERMES_DEFAULT_THEME = {
    "meta": {
        "name": "hermes-default",
        "description": "Upstream Hermes Agent gold/amber theme",
    },
    "colors": {
        "primary":    "#FFD700",
        "secondary":  "#FFBF00",
        "tertiary":   "#CD7F32",
        "text":       "#FFF8DC",
        "muted":      "#B8860B",
        "border":     "#CD7F32",
        "session":    "#8B8682",
    },
    "ansi": {
        "accent": r"\033[1;33m",
        "bold":   r"\033[1m",
        "dim":    r"\033[2m",
        "reset":  r"\033[0m",
        "muted":  r"\033[2m",
    },
    "branding": {
        "product_name":     "Hermes Agent",
        "org_name":         "Nous Research",
        "tagline":          "Messenger of the Digital Gods",
        "compact_tagline":  "AI Agent Framework",
        "compact_symbol":   "⚕",
        "compact_label":    "NOUS HERMES",
        "panel_title":      "Hermes Agent",
        "response_label":   " ⚕ Hermes ",
        "goodbye":          "Goodbye! ⚕",
        "welcome":          "Welcome to Hermes Agent! Type your message or /help for commands.",
    },
    "logo_large": textwrap.dedent("""\
[bold {primary}]██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗[/]
[bold {primary}]██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝[/]
[{secondary}]███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║[/]
[{secondary}]██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║[/]
[{tertiary}]██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║[/]
[{tertiary}]╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝[/]"""),
    "logo_medium": None,
    "logo_small": None,
    "caduceus": textwrap.dedent("""\
[{tertiary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡀⠀⣀⣀⠀⢀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{tertiary}]⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⣇⠸⣿⣿⠇⣸⣿⣿⣷⣦⣄⡀⠀⠀⠀⠀⠀⠀[/]
[{secondary}]⠀⢀⣠⣴⣶⠿⠋⣩⡿⣿⡿⠻⣿⡇⢠⡄⢸⣿⠟⢿⣿⢿⣍⠙⠿⣶⣦⣄⡀⠀[/]
[{secondary}]⠀⠀⠉⠉⠁⠶⠟⠋⠀⠉⠀⢀⣈⣁⡈⢁⣈⣁⡀⠀⠉⠀⠙⠻⠶⠈⠉⠉⠀⠀[/]
[{primary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⡿⠛⢁⡈⠛⢿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{primary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠿⣿⣦⣤⣈⠁⢠⣴⣿⠿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{secondary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠻⢿⣿⣦⡉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{secondary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⣦⣈⠛⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{tertiary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣴⠦⠈⠙⠿⣦⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{tertiary}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣤⡈⠁⢤⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{muted}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠷⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{muted}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⠑⢶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{muted}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠁⢰⡆⠈⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{muted}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⠈⣡⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]
[{muted}]⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀[/]"""),
    "pt_styles": {
        "input-area":                            "{text}",
        "placeholder":                           "#555555 italic",
        "prompt":                                "{text}",
        "prompt-working":                        "#888888 italic",
        "hint":                                  "#555555 italic",
        "input-rule":                            "{tertiary}",
        "image-badge":                           "#87CEEB bold",
        "completion-menu":                       "bg:#1a1a2e {text}",
        "completion-menu.completion":            "bg:#1a1a2e {text}",
        "completion-menu.completion.current":    "bg:#333355 {primary}",
        "completion-menu.meta.completion":       "bg:#1a1a2e #888888",
        "completion-menu.meta.completion.current": "bg:#333355 {secondary}",
        "clarify-border":                        "{tertiary}",
        "clarify-title":                         "{primary} bold",
        "clarify-question":                      "{text} bold",
        "clarify-choice":                        "#AAAAAA",
        "clarify-selected":                      "{primary} bold",
        "clarify-active-other":                  "{primary} italic",
        "clarify-countdown":                     "{tertiary}",
        "sudo-prompt":                           "#FF6B6B bold",
        "sudo-border":                           "{tertiary}",
        "sudo-title":                            "#FF6B6B bold",
        "sudo-text":                             "{text}",
        "approval-border":                       "{tertiary}",
        "approval-title":                        "#FF8C00 bold",
        "approval-desc":                         "{text} bold",
        "approval-cmd":                          "#AAAAAA italic",
        "approval-choice":                       "#AAAAAA",
        "approval-selected":                     "{primary} bold",
    },
}

HERMILINE_THEME = {
    "meta": {
        "name": "hermiline",
        "description": "hermilinChat amber/slate theme",
    },
    "colors": {
        "primary":    "#f5b731",
        "secondary":  "#9a6c12",
        "tertiary":   "#3d2a08",
        "text":       "#b8b8cc",
        "text_bright":"#e8e8f0",
        "muted":      "#55556a",
        "border":     "#232330",
        "surface":    "#0e0e12",
        "background": "#08080a",
        "session":    "#55556a",
        "success":    "#38c878",
        "danger":     "#e84057",
    },
    "ansi": {
        "accent": r"\033[38;2;245;183;49m",
        "bold":   r"\033[1m",
        "dim":    r"\033[2m",
        "reset":  r"\033[0m",
        "muted":  r"\033[38;2;85;85;106m",
    },
    "branding": {
        "product_name":     "hermilinChat",
        "org_name":         "Nous Research",
        "tagline":          "Hermes Agent Terminal",
        "compact_tagline":  "Hermes Agent Terminal",
        "compact_symbol":   "⚕",
        "compact_label":    "hermilinChat",
        "panel_title":      "hermilinChat",
        "response_label":   " ⚕ Hermes ",
        "goodbye":          "Goodbye! ⚕",
        "welcome":          "Welcome to hermilinChat! Type your message or /help for commands.",
    },
    "logo_large": textwrap.dedent("""\
[bold {primary}]██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗██╗     ██╗███╗   ██╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗[/]
[bold {primary}]██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██║     ██║████╗  ██║      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝[/]
[bold {primary}]███████║█████╗  ██████╔╝██╔████╔██║█████╗  ██║     ██║██╔██╗ ██║█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   [/]
[bold {primary}]██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ██║     ██║██║╚██╗██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   [/]
[bold {primary}]██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████╗██║██║ ╚████║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   [/]
[bold {primary}]╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   [/]"""),
    "logo_medium": textwrap.dedent("""\
[bold {primary}]██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗██╗     ██╗███╗   ██╗[/]
[bold {primary}]██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██║     ██║████╗  ██║[/]
[bold {primary}]███████║█████╗  ██████╔╝██╔████╔██║█████╗  ██║     ██║██╔██╗ ██║[/]
[bold {primary}]██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ██║     ██║██║╚██╗██║[/]
[bold {primary}]██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████╗██║██║ ╚████║[/]
[bold {primary}]╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝╚═╝╚═╝  ╚═══╝[/]"""),
    "logo_small": textwrap.dedent("""\
[bold {primary}] _   _                          _ _       [/]
[bold {primary}]| | | |                        | (_)      [/]
[bold {primary}]| |_| | ___ _ __ _ __ ___   ___| |_ _ __  [/]
[bold {primary}]|  _  |/ _ \\ '__| '_ ` _ \\ / _ \\ | | '_ \\ [/]
[bold {primary}]| | | |  __/ |  | | | | | |  __/ | | | | |[/]
[bold {primary}]\\_| |_/\\___|_|  |_| |_| |_|\\___|_|_|_| |_|[/]"""),
    "caduceus": textwrap.dedent("""\
[{primary}]⠀⠀⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡀⠀⠀⠀⠀[/]
[{primary}]⠀⠀⢀⣿⠛⠻⢷⣦⣄⢤⣴⣶⣶⣶⣶⣶⣦⣤⣤⣴⣾⠿⠛⢻⣇⠀⠀⠀[/]
[{primary}]⠀⠀⢸⡇⠀⠀⠀⢙⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣅⠀⠀⠀⣿⠀⠀⠀[/]
[{primary}]⠀⠀⠈⣿⡀⣤⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄⢠⡟⠀⠀⠀[/]
[{primary}]⠀⠀⠀⠘⣷⣿⣿⣿⠟⠛⠻⣿⣿⣿⣿⣿⣿⡿⠛⠛⢿⣿⣿⣾⠁⠀⠀⠀[/]
[{primary}]⠀⠀⠀⠀⣨⣿⣿⣿⡀⠀⠀⢸⣿⣿⣿⣿⣿⠀⠀⠀⣸⣿⣿⣿⠀⠀⠀⠀[/]
[{primary}]⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠻⢿⣿⣿⣿⣿⣿⡿⠃⠀⠀⠀⠀[/]
[{primary}]⠀⠀⠀⠀⠀⠈⠉⢛⣿⣿⣿⣿⣄⠀⠀⠀⣰⣿⣿⣿⣟⠉⠀⠀⠀⠀⠀⠀[/]
[{primary}]⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠛⠿⠿⠛⠀⠛⠿⠟⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀[/]"""),
    "pt_styles": {
        "input-area":                            "{text}",
        "placeholder":                           "#555555 italic",
        "prompt":                                "{text}",
        "prompt-working":                        "#888888 italic",
        "hint":                                  "#555555 italic",
        "input-rule":                            "{border}",
        "image-badge":                           "#87CEEB bold",
        "completion-menu":                       "bg:{surface} {text}",
        "completion-menu.completion":            "bg:{surface} {text}",
        "completion-menu.completion.current":    "bg:{border} {primary}",
        "completion-menu.meta.completion":       "bg:{surface} #888888",
        "completion-menu.meta.completion.current": "bg:{border} {secondary}",
        "clarify-border":                        "{border}",
        "clarify-title":                         "{primary} bold",
        "clarify-question":                      "{text} bold",
        "clarify-choice":                        "#AAAAAA",
        "clarify-selected":                      "{primary} bold",
        "clarify-active-other":                  "{primary} italic",
        "clarify-countdown":                     "{secondary}",
        "sudo-prompt":                           "#e84057 bold",
        "sudo-border":                           "{border}",
        "sudo-title":                            "#e84057 bold",
        "sudo-text":                             "{text}",
        "approval-border":                       "{border}",
        "approval-title":                        "{primary} bold",
        "approval-desc":                         "{text} bold",
        "approval-cmd":                          "#AAAAAA italic",
        "approval-choice":                       "#AAAAAA",
        "approval-selected":                     "{primary} bold",
    },
}

BUNDLED_THEMES = {
    "hermes-default": HERMES_DEFAULT_THEME,
    "hermiline": HERMILINE_THEME,
}


# ---------------------------------------------------------------------------
# Theme helpers
# ---------------------------------------------------------------------------

def deep_merge(base: dict, overlay: dict) -> dict:
    """Deep-merge overlay onto a copy of base."""
    result = copy.deepcopy(base)
    for k, v in overlay.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = copy.deepcopy(v)
    return result


def resolve_theme(raw: dict) -> dict:
    """Merge onto defaults and interpolate {color} placeholders."""
    full = deep_merge(HERMES_DEFAULT_THEME, raw)
    colors = full["colors"]

    def interp(obj):
        if isinstance(obj, str):
            try:
                return obj.format(**colors)
            except (KeyError, ValueError):
                return obj
        if isinstance(obj, dict):
            return {k: interp(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [interp(v) for v in obj]
        return obj

    for section in ("logo_large", "logo_medium", "logo_small", "caduceus",
                     "branding", "pt_styles"):
        if section in full and full[section] is not None:
            full[section] = interp(full[section])
    return full


def theme_to_yaml(theme: dict) -> str:
    """Serialize theme to YAML."""
    import yaml
    return yaml.dump(theme, default_flow_style=False, sort_keys=False,
                     allow_unicode=True)


def load_yaml(path: str) -> dict:
    import yaml
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


# ---------------------------------------------------------------------------
# The code block we inject into cli.py
# ---------------------------------------------------------------------------

THEME_LOADER_BLOCK = r'''
# =============================================================================
# Theme System (injected by install_hermes_themes.py)
# =============================================================================
import yaml as _theme_yaml

def _load_hermes_theme(themefile: str = None) -> dict:
    """Load and resolve a theme from a YAML file.

    Lookup order for the theme file:
      1. Explicit path (--theme/--themefile argument)
      2. $HERMES_HOME/theme.yaml (user default; falls back to ~/.hermes/theme.yaml)
      3. Built-in defaults (no file needed)

    The YAML can be a partial override — missing keys use built-in defaults.
    Colour placeholders like {primary} in art/styles are interpolated from
    the ``colors`` section.
    """
    import copy as _cp
    import os as _os
    from pathlib import Path as _P

    # Resolve Hermes home (defaults to ~/.hermes)
    _hh = (
        _os.environ.get("HERMES_HOME")
        or _os.environ.get("HERMESHOME")
        or str(_P.home() / ".hermes")
    ).strip()
    if _hh.startswith("~"):
        _hh = str(_P.home()) + _hh[1:]
    _HERMES_HOME_DIR = _P(_hh).expanduser()

    # ── locate the file ────────────────────────────────────────────────
    path = None
    if themefile:
        p = _P(themefile).expanduser()
        if p.exists():
            path = p
        else:
            # check $HERMES_HOME/themes/<name>
            alt = _HERMES_HOME_DIR / "themes" / themefile
            if alt.exists():
                path = alt
            else:
                logger.warning("Theme file not found: %s (using defaults)", themefile)
    if path is None:
        default_path = _HERMES_HOME_DIR / "theme.yaml"
        if default_path.exists():
            path = default_path

    # ── load & merge ───────────────────────────────────────────────────
    overlay = {}
    if path:
        try:
            with open(path, "r", encoding="utf-8") as _tf:
                overlay = _theme_yaml.safe_load(_tf) or {}
        except Exception as _e:
            logger.warning("Failed to load theme %s: %s", path, _e)

    # Built-in defaults (baked in by install_hermes_themes.py)
    base = _HERMES_THEME_DEFAULTS

    def _dm(b, o):
        r = _cp.deepcopy(b)
        for k, v in o.items():
            if k in r and isinstance(r[k], dict) and isinstance(v, dict):
                r[k] = _dm(r[k], v)
            else:
                r[k] = _cp.deepcopy(v)
        return r

    full = _dm(base, overlay)
    colors = full.get("colors", {})

    def _interp(obj):
        if isinstance(obj, str):
            try:
                return obj.format(**colors)
            except (KeyError, ValueError):
                return obj
        if isinstance(obj, dict):
            return {k: _interp(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_interp(v) for v in obj]
        return obj

    for _sec in ("logo_large", "logo_medium", "logo_small", "caduceus",
                  "branding", "pt_styles"):
        if _sec in full and full[_sec] is not None:
            full[_sec] = _interp(full[_sec])
    return full


def _apply_hermes_theme(theme: dict):
    """Apply a resolved theme dict to this module's globals."""
    global _GOLD, _BOLD, _DIM, _RST, HERMES_AGENT_LOGO, HERMES_CADUCEUS
    global COMPACT_BANNER, _HERMES_ACTIVE_THEME

    _HERMES_ACTIVE_THEME = theme
    colors  = theme.get("colors", {})
    ansi    = theme.get("ansi", {})
    brand   = theme.get("branding", {})

    # ANSI codes (decode \\033 → real escape)
    def _esc(s):
        return s.encode().decode("unicode_escape") if s else s

    _GOLD = _esc(ansi.get("accent", "\\033[1;33m"))
    _BOLD = _esc(ansi.get("bold",   "\\033[1m"))
    _DIM  = _esc(ansi.get("dim",    "\\033[2m"))
    _RST  = _esc(ansi.get("reset",  "\\033[0m"))

    # Extra ANSI muted (for response boxes in themes that override it)
    global _THEME_MUTED_ANSI
    _THEME_MUTED_ANSI = _esc(ansi.get("muted", "\\033[2m"))

    # ASCII art
    if theme.get("logo_large"):
        HERMES_AGENT_LOGO = theme["logo_large"]
    if theme.get("caduceus"):
        HERMES_CADUCEUS = theme["caduceus"]

    # Compact banner — rebuild from branding
    pri = colors.get("primary", "#FFD700")
    sec = colors.get("secondary", "#FFBF00")
    ter = colors.get("tertiary", "#CD7F32")
    mut = colors.get("muted", "#B8860B")
    sym = brand.get("compact_symbol", "⚕")
    lbl = brand.get("compact_label", "NOUS HERMES")
    tag = brand.get("compact_tagline", "AI Agent Framework")
    tl  = brand.get("tagline", "Messenger of the Digital Gods")
    org = brand.get("org_name", "Nous Research")
    COMPACT_BANNER = (
        f"\n[bold {pri}]╔══════════════════════════════════════════════════════════════╗[/]\n"
        f"[bold {pri}]║[/]  [{sec}]{sym} {lbl}[/] [dim {mut}]- {tag}[/]              [bold {pri}]║[/]\n"
        f"[bold {pri}]║[/]  [{ter}]{tl}[/]    [dim {mut}]{org}[/]   [bold {pri}]║[/]\n"
        f"[bold {pri}]╚══════════════════════════════════════════════════════════════╝[/]\n"
    )


# Placeholder — replaced by install_hermes_themes.py with baked-in defaults
_HERMES_THEME_DEFAULTS = %%BAKED_DEFAULTS%%

# Active theme (set after _apply_hermes_theme runs)
_HERMES_ACTIVE_THEME = None

# An extra ANSI code for the muted/border colour in the response box
_THEME_MUTED_ANSI = "\033[2m"
'''


# ---------------------------------------------------------------------------
# Patching engine
# ---------------------------------------------------------------------------

# Markers we inject so re-running is idempotent
BEGIN_MARKER = "# === HERMES_THEME_SYSTEM_BEGIN ==="
END_MARKER   = "# === HERMES_THEME_SYSTEM_END ==="


def _find_section(lines: list[str], begin: str, end: str) -> tuple[int, int] | None:
    """Find (start_idx, end_idx) of a marked section."""
    start = end_ = None
    for i, line in enumerate(lines):
        if begin in line:
            start = i
        if end in line and start is not None:
            end_ = i
            break
    if start is not None and end_ is not None:
        return (start, end_)
    return None


def _write_backup(src: Path, hermes_home: Path, dry_run: bool = False) -> Path:
    """Write a backup copy of *src* under $HERMES_HOME/backups/.

    We intentionally keep backup files OUTSIDE the Hermes installation directory,
    so hermes-agent remains clean/upgradable (no untracked *.bak files next to
    cli.py/main.py).
    """

    backup_dir = hermes_home.expanduser() / "backups" / "hermes-themes"
    backup_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    digest = hashlib.sha256(str(src).encode("utf-8")).hexdigest()[:8]
    backup_path = backup_dir / f"{src.name}.bak.{stamp}.{digest}"

    if not dry_run:
        shutil.copy2(src, backup_path)

    return backup_path


def _ensure_single_themefile_param(text: str, changes: list[str]) -> str:
    """Ensure cli.py's def main(...) has *exactly one* themefile parameter.

    Older versions of this patcher could insert `themefile` multiple times when
    re-run, breaking Hermes with:

        SyntaxError: duplicate argument 'themefile'

    This function is intentionally idempotent and also repairs that broken state.
    """

    lines = text.split("\n")

    # Find the main() entrypoint signature.
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^\s*def\s+main\s*\(", line):
            start = i
            break

    if start is None:
        return text

    end = None
    for j in range(start, min(start + 250, len(lines))):
        # match: "):" or ") -> int:"
        if re.search(r"\)\s*(?:->\s*[^:]+)?\s*:", lines[j]):
            end = j
            break

    if end is None:
        return text

    sig = lines[start : end + 1]

    theme_line_idxs = [k for k, l in enumerate(sig) if re.search(r"\bthemefile\b", l)]

    if len(theme_line_idxs) > 1:
        for idx in reversed(theme_line_idxs[1:]):
            del sig[idx]
        changes.append("Removed duplicate themefile parameter(s) from main()")

    # Recompute after potential deletions
    theme_line_idxs = [k for k, l in enumerate(sig) if re.search(r"\bthemefile\b", l)]

    if len(theme_line_idxs) == 0:
        insert_at = None
        indent = None

        # Prefer inserting just before verbose (keeps signature readable).
        for k, l in enumerate(sig):
            if re.search(r"\bverbose\b", l) and ":" in l:
                insert_at = k
                indent = re.match(r"^(\s*)", l).group(1)
                break

        if insert_at is None:
            # Fallback: insert before the closing paren line.
            insert_at = max(len(sig) - 1, 0)

            for k in range(len(sig) - 2, -1, -1):
                m = re.match(r"^(\s+)\w", sig[k])
                if m:
                    indent = m.group(1)
                    break

        if indent is None:
            indent = "    "

        sig.insert(insert_at, f"{indent}themefile: str = None,")
        changes.append("Added --themefile parameter to main()")

    lines = lines[:start] + sig + lines[end + 1 :]
    return "\n".join(lines)


def patch_cli(cli_path: str, theme: dict, hermes_home: Path | None = None, dry_run: bool = False) -> list[str]:
    """
    Patch cli.py on disk.  Returns a list of human-readable changes made.
    """
    path = Path(cli_path)
    if not path.exists():
        print(f"Error: {cli_path} not found", file=sys.stderr)
        sys.exit(1)

    original = path.read_text(encoding="utf-8")
    lines = original.split("\n")
    changes = []

    resolved = resolve_theme(theme)
    colors = resolved["colors"]
    ansi = resolved["ansi"]
    brand = resolved["branding"]

    # ── 0. Backup ──────────────────────────────────────────────────────
    if hermes_home is None:
        hermes_home = _resolve_hermes_home()
    if not dry_run:
        backup = _write_backup(path, hermes_home, dry_run=dry_run)
        changes.append(f"Backup: {backup}")

    # Work on the full text for regex replacements
    text = original

    # ── 1. Remove any previous theme injection ─────────────────────────
    prev = _find_section(lines, BEGIN_MARKER, END_MARKER)
    if prev:
        start, end_ = prev
        lines = lines[:start] + lines[end_ + 1:]
        text = "\n".join(lines)
        changes.append("Removed previous theme injection")

    # ── 2. Inject the theme loader block ───────────────────────────────
    # Insert right after the imports section, before the ASCII Art section.
    # We look for the "# ASCII Art & Branding" comment or the first
    # HERMES_AGENT_LOGO definition.
    inject_idx = None
    for i, line in enumerate(lines):
        if "ASCII Art & Branding" in line or "ASCII Art" in line:
            # Go back to find the preceding blank line or comment block start
            inject_idx = i
            break
    if inject_idx is None:
        # Fallback: look for the HERMES_AGENT_LOGO assignment
        for i, line in enumerate(lines):
            if line.startswith("HERMES_AGENT_LOGO"):
                inject_idx = i
                break
    if inject_idx is None:
        print("Error: Could not find injection point in cli.py", file=sys.stderr)
        print("  (looked for 'ASCII Art & Branding' or 'HERMES_AGENT_LOGO')", file=sys.stderr)
        sys.exit(1)

    # Prepare the baked-in defaults as a Python dict literal
    baked = repr(theme)
    loader_code = THEME_LOADER_BLOCK.replace("%%BAKED_DEFAULTS%%", baked)

    injection = [
        BEGIN_MARKER,
        loader_code,
        END_MARKER,
        "",
    ]
    lines = lines[:inject_idx] + [l for l in "\n".join(injection).split("\n")] + lines[inject_idx:]
    text = "\n".join(lines)
    changes.append(f"Injected theme loader ({len(injection)} lines) before ASCII Art section")

    # ── 3. Replace hardcoded ANSI codes ────────────────────────────────
    # The inline _GOLD = "\033[1;33m" etc. that come AFTER our injection.
    # We replace them with references to the theme-loaded values.
    # But since _apply_hermes_theme sets them, we just need the initial
    # definitions to call _apply_hermes_theme.  So we add a call.

    # Find where the _GOLD/ANSI definitions are (after injection)
    ansi_defs_pattern = r'(# ANSI building blocks.*?\n)_GOLD = [^\n]+\n_BOLD = [^\n]+\n_DIM = [^\n]+\n_RST = [^\n]+'
    match = re.search(ansi_defs_pattern, text, re.DOTALL)
    if match:
        text = text[:match.start()] + (
            "# ANSI building blocks for conversation display\n"
            "# (set dynamically by theme system — see _apply_hermes_theme)\n"
            '_GOLD = "\\033[1;33m"  # overwritten by theme\n'
            '_BOLD = "\\033[1m"\n'
            '_DIM = "\\033[2m"\n'
            '_RST = "\\033[0m"\n'
        ) + text[match.end():]
        changes.append("Replaced ANSI definitions with theme-aware defaults")

    # ── 4. Add --themefile to main() ───────────────────────────────────
    # Ensure def main(...) has exactly one themefile param (idempotent + repairs old duplicates).
    text = _ensure_single_themefile_param(text, changes)

    # Also add the docstring entry
    if "themefile" not in text.split("Args:")[1].split("Examples:")[0] if "Args:" in text else "":
        text = text.replace(
            '        verbose: Enable verbose logging',
            '        themefile: Path to a YAML theme file (default: $HERMES_HOME/theme.yaml)\n'
            '        verbose: Enable verbose logging',
        )
        changes.append("Added --themefile to main() docstring")

    # Add the theme loading call at the top of main()
    # Insert right after "os.environ["HERMES_INTERACTIVE"] = "1""
    theme_boot = (
        '\n'
        '    # ── Load and apply theme ──────────────────────────────────────\n'
        '    _theme = _load_hermes_theme(themefile)\n'
        '    _apply_hermes_theme(_theme)\n'
    )
    marker_line = 'os.environ["HERMES_INTERACTIVE"] = "1"'
    if "# ── Load and apply theme" not in text:
        text = text.replace(
            marker_line,
            marker_line + theme_boot,
        )
        changes.append("Added theme loading call to main()")

    # ── 5. Patch build_welcome_banner to use theme colours ─────────────
    # Replace hardcoded hex colours in the build_welcome_banner function
    # with references to _HERMES_ACTIVE_THEME.
    # We do this by injecting a helper at the top of the function.
    bwb_helper = (
        '    # ── Theme-aware colour lookup ──\n'
        '    _t = _HERMES_ACTIVE_THEME or {}\n'
        '    _tc = _t.get("colors", {})\n'
        '    _tb = _t.get("branding", {})\n'
        '    _C_PRI = _tc.get("primary", "#FFD700")\n'
        '    _C_SEC = _tc.get("secondary", "#FFBF00")\n'
        '    _C_TER = _tc.get("tertiary", "#CD7F32")\n'
        '    _C_TXT = _tc.get("text", "#FFF8DC")\n'
        '    _C_MUT = _tc.get("muted", "#B8860B")\n'
        '    _C_BRD = _tc.get("border", _C_TER)\n'
        '    _C_SES = _tc.get("session", "#8B8682")\n'
        '    _PANEL_TITLE = _tb.get("panel_title", "Hermes Agent")\n'
        '    _ORG = _tb.get("org_name", "Nous Research")\n'
    )

    # Find the build_welcome_banner function body start
    bwb_pattern = r'(def build_welcome_banner\([^)]+\):[^\n]*\n(?:\s+"""[\s\S]*?"""[\s\S]*?\n))'
    bwb_match = re.search(bwb_pattern, text)
    if bwb_match and "# ── Theme-aware colour lookup" not in text:
        insert_at = bwb_match.end()
        text = text[:insert_at] + bwb_helper + text[insert_at:]
        changes.append("Injected theme colour lookup into build_welcome_banner()")

        # Now replace the hardcoded colours in that function, but ONLY
        # in the body AFTER the helper block — never inside the helper
        # itself (where the same hex strings appear as fallback defaults).
        func_start = bwb_match.start()
        next_func = re.search(r'\n(?:def |class )', text[func_start + 10:])
        func_end = func_start + 10 + next_func.start() if next_func else len(text)

        # Split: helper block ends at the _ORG line
        helper_end_marker = '_ORG = _tb.get("org_name", "Nous Research")\n'
        helper_split = text[func_start:func_end].find(helper_end_marker)
        if helper_split != -1:
            helper_split += len(helper_end_marker)
            helper_part = text[func_start:func_start + helper_split]
            body_part = text[func_start + helper_split:func_end]
        else:
            # Fallback: treat entire function as body (shouldn't happen)
            helper_part = ""
            body_part = text[func_start:func_end]

        # Replace colour references only in the body part
        replacements = [
            ('#FFD700', '{_C_PRI}'),    # primary
            ('#FFBF00', '{_C_SEC}'),    # secondary
            ('#CD7F32', '{_C_TER}'),    # tertiary
            ('#FFF8DC', '{_C_TXT}'),    # text
            ('#B8860B', '{_C_MUT}'),    # muted
            ('#8B8682', '{_C_SES}'),    # session
        ]

        for old_col, new_ref in replacements:
            new_ref_clean = new_ref.strip('{}')
            body_part = body_part.replace(f'"{old_col}"', f'{new_ref_clean}')
            body_part = body_part.replace(f"'{old_col}'", f'{new_ref_clean}')

        # Fix the panel title
        body_part = body_part.replace(
            'f"[bold {_C_PRI}]Hermes Agent {VERSION}[/]"',
            'f"[bold {_C_PRI}]{_PANEL_TITLE} {VERSION}[/]"',
        )
        body_part = body_part.replace(
            '"Nous Research"',
            '_ORG',
        )
        # Fix border_style
        body_part = body_part.replace(
            'border_style=_C_TER',
            'border_style=_C_BRD',
        )

        text = text[:func_start] + helper_part + body_part + text[func_end:]
        changes.append("Replaced hardcoded colours in build_welcome_banner()")

    # ── 5b. Rewrite embedded Rich markup colours inside build_welcome_banner ─
    # The banner contains lots of inline markup like "[dim #B8860B]...".
    # Earlier patch versions only replaced *standalone* hex strings ("#FFD700"),
    # which leaves the banner looking gold even under a green theme.
    if "def build_welcome_banner" in text:
        theme_markup_helper = (
            '    def _theme_markup(s: str) -> str:\n'
            '        if not _HERMES_ACTIVE_THEME:\n'
            '            return s\n'
            '        for _a, _b in (\n'
            '            ("#FFD700", _C_PRI),\n'
            '            ("#FFBF00", _C_SEC),\n'
            '            ("#CD7F32", _C_TER),\n'
            '            ("#FFF8DC", _C_TXT),\n'
            '            ("#B8860B", _C_MUT),\n'
            '            ("#8B8682", _C_SES),\n'
            '        ):\n'
            '            try:\n'
            '                s = s.replace(_a, _b)\n'
            '            except Exception:\n'
            '                pass\n'
            '        return s\n'
            '\n'
        )

        # Insert helper right after our colour lookup block.
        if "def _theme_markup" not in text and "# ── Theme-aware colour lookup" in text:
            anchor = '_ORG = _tb.get("org_name", "Nous Research")\n'
            if anchor in text:
                text = text.replace(anchor, anchor + theme_markup_helper, 1)
                changes.append("Added _theme_markup() helper to build_welcome_banner()")

        # Apply helper to the joined banner strings.
        text = text.replace(
            'left_content = "\\n".join(left_lines)',
            'left_content = _theme_markup("\\n".join(left_lines))',
        )
        text = text.replace(
            'right_content = "\\n".join(right_lines)',
            'right_content = _theme_markup("\\n".join(right_lines))',
        )

        # Make the outer panel title use theme branding + theme colours.
        text = text.replace(
            'title=f"[bold #FFD700]Hermes Agent {VERSION}[/]",',
            'title=_theme_markup(f"[bold #FFD700]{_PANEL_TITLE} {VERSION}[/]"),',
        )

        # Let org_name come from the theme.
        text = text.replace('Nous Research[/]",', '{_ORG}[/]",')

    # ── 6. Patch the response box to use theme muted ANSI ──────────────
    # The response box uses _GOLD for its borders.  We add _THEME_MUTED_ANSI
    # so themes can use a different colour for the box vs the accent.
    # Look for the response box pattern:
    #   top = f"{_GOLD}╭─{label}...
    text = text.replace(
        'top = f"{_GOLD}╭─{label}',
        'top = f"{_THEME_MUTED_ANSI if _HERMES_ACTIVE_THEME else _GOLD}╭─{label}',
    )
    text = text.replace(
        'bot = f"{_GOLD}╰{',
        'bot = f"{_THEME_MUTED_ANSI if _HERMES_ACTIVE_THEME else _GOLD}╰{',
    )
    # The separator line before agent runs
    text = text.replace(
        """_cprint(f"{_GOLD}{'─' * w}{_RST}")""",
        """_cprint(f"{_THEME_MUTED_ANSI if _HERMES_ACTIVE_THEME else _GOLD}{'─' * w}{_RST}")""",
    )
    if '_THEME_MUTED_ANSI if _HERMES_ACTIVE_THEME' in text:
        changes.append("Patched response box borders to use theme muted colour")

    # ── 7. Patch _show_status colours ──────────────────────────────────
    status_replacements = {
        '"[#FFBF00]': 'f"[{_HERMES_ACTIVE_THEME[\'colors\'][\'secondary\'] if _HERMES_ACTIVE_THEME else \'#FFBF00\'}]' if False else None,
    }
    # Simpler approach: just add a theme-aware colour getter at module level
    # and use it in _show_status.  But that requires too many edits in
    # non-contiguous spots.  For _show_status we'll leave the Rich markup
    # colours as-is since they're minor and build_welcome_banner handles
    # the main branding.  The user can do a second pass if they want to
    # theme _show_status too.

    # ── 8. Patch prompt_toolkit style dict ─────────────────────────────
    # Replace the hardcoded PTStyle.from_dict({...}) with one that reads
    # from the active theme.
    pt_style_pattern = r"(style = PTStyle\.from_dict\(\{)[^}]+(}\))"
    pt_match = re.search(pt_style_pattern, text, re.DOTALL)
    if pt_match and "_HERMES_ACTIVE_THEME" not in text[pt_match.start():pt_match.end() + 200]:
        replacement = (
            "style = PTStyle.from_dict(\n"
            "            _HERMES_ACTIVE_THEME.get('pt_styles', {}) if _HERMES_ACTIVE_THEME else {\n"
            "            'input-area': '#FFF8DC',\n"
            "            'placeholder': '#555555 italic',\n"
            "            'prompt': '#FFF8DC',\n"
            "            'prompt-working': '#888888 italic',\n"
            "            'hint': '#555555 italic',\n"
            "            'input-rule': '#CD7F32',\n"
            "            'image-badge': '#87CEEB bold',\n"
            "            'completion-menu': 'bg:#1a1a2e #FFF8DC',\n"
            "            'completion-menu.completion': 'bg:#1a1a2e #FFF8DC',\n"
            "            'completion-menu.completion.current': 'bg:#333355 #FFD700',\n"
            "            'completion-menu.meta.completion': 'bg:#1a1a2e #888888',\n"
            "            'completion-menu.meta.completion.current': 'bg:#333355 #FFBF00',\n"
            "            'clarify-border': '#CD7F32',\n"
            "            'clarify-title': '#FFD700 bold',\n"
            "            'clarify-question': '#FFF8DC bold',\n"
            "            'clarify-choice': '#AAAAAA',\n"
            "            'clarify-selected': '#FFD700 bold',\n"
            "            'clarify-active-other': '#FFD700 italic',\n"
            "            'clarify-countdown': '#CD7F32',\n"
            "            'sudo-prompt': '#FF6B6B bold',\n"
            "            'sudo-border': '#CD7F32',\n"
            "            'sudo-title': '#FF6B6B bold',\n"
            "            'sudo-text': '#FFF8DC',\n"
            "            'approval-border': '#CD7F32',\n"
            "            'approval-title': '#FF8C00 bold',\n"
            "            'approval-desc': '#FFF8DC bold',\n"
            "            'approval-cmd': '#AAAAAA italic',\n"
            "            'approval-choice': '#AAAAAA',\n"
            "            'approval-selected': '#FFD700 bold',\n"
            "        })"
        )
        text = text[:pt_match.start()] + replacement + text[pt_match.end():]
        changes.append("Patched prompt_toolkit style dict to use theme")

    # ── 9. Patch welcome text in run() ─────────────────────────────────
    old_welcome = '''self.console.print("[#FFF8DC]Welcome to Hermes Agent! Type your message or /help for commands.[/]")'''
    new_welcome = (
        '_wt = _HERMES_ACTIVE_THEME.get("branding", {}).get("welcome", '
        '"Welcome to Hermes Agent! Type your message or /help for commands.") if _HERMES_ACTIVE_THEME else '
        '"Welcome to Hermes Agent! Type your message or /help for commands."\n'
        '        _wtc = _HERMES_ACTIVE_THEME.get("colors", {}).get("text", "#FFF8DC") if _HERMES_ACTIVE_THEME else "#FFF8DC"\n'
        '        self.console.print(f"[{_wtc}]{_wt}[/]")'
    )
    if old_welcome in text:
        text = text.replace(old_welcome, new_welcome)
        changes.append("Patched welcome message to use theme branding")

    # ── 10. Patch goodbye in _print_exit_summary ───────────────────────
    old_goodbye = 'print("Goodbye! ⚕")'
    new_goodbye = (
        '_gb = _HERMES_ACTIVE_THEME.get("branding", {}).get("goodbye", "Goodbye! ⚕") '
        'if _HERMES_ACTIVE_THEME else "Goodbye! ⚕"\n'
        '            print(_gb)'
    )
    if old_goodbye in text:
        text = text.replace(old_goodbye, new_goodbye, 1)
        changes.append("Patched goodbye message to use theme branding")

    # ── 11. Patch the _build_compact_banner to use theme ───────────────
    old_compact_narrow = '''return "\\n[#FFBF00]⚕ NOUS HERMES[/] [dim #B8860B]- Nous Research[/]\\n"'''
    if old_compact_narrow in text:
        new_compact_narrow = (
            '_t = _HERMES_ACTIVE_THEME or {}\n'
            '        _tc = _t.get("colors", {})\n'
            '        _tb = _t.get("branding", {})\n'
            '        return f"\\n[{_tc.get(\'secondary\', \'#FFBF00\')}]'
            '{_tb.get(\'compact_symbol\', \'⚕\')} {_tb.get(\'compact_label\', \'NOUS HERMES\')}[/] '
            '[dim {_tc.get(\'muted\', \'#B8860B\')}]- {_tb.get(\'org_name\', \'Nous Research\')}[/]\\n"'
        )
        text = text.replace(old_compact_narrow, new_compact_narrow)
        changes.append("Patched narrow compact banner to use theme")

    # ── 12. Patch the response label ───────────────────────────────────
    old_label = 'label = " ⚕ Hermes "'
    new_label = (
        'label = _HERMES_ACTIVE_THEME.get("branding", {}).get("response_label", " ⚕ Hermes ") '
        'if _HERMES_ACTIVE_THEME else " ⚕ Hermes "'
    )
    text = text.replace(old_label, new_label)
    if old_label != new_label:
        changes.append("Patched response box label to use theme branding")

    # ── Write ──────────────────────────────────────────────────────────
    if not dry_run:
        path.write_text(text, encoding="utf-8")
        changes.append(f"Wrote patched file: {cli_path}")
    else:
        changes.append("(dry run — no files modified)")

    return changes


# ---------------------------------------------------------------------------
# Patch hermes_cli/main.py — thread --themefile through the arg dispatch
# ---------------------------------------------------------------------------

MAIN_PY_MARKER_BEGIN = "# === HERMES_THEME_MAIN_PY_BEGIN ==="
MAIN_PY_MARKER_END   = "# === HERMES_THEME_MAIN_PY_END ==="


def patch_main_py(main_py_path: str, hermes_home: Path | None = None, dry_run: bool = False) -> list[str]:
    """
    Patch hermes_cli/main.py to add --themefile to the chat subcommand
    and top-level parser, and pass it through cmd_chat → cli.main().
    """
    path = Path(main_py_path)
    if not path.exists():
        print(f"Error: {main_py_path} not found", file=sys.stderr)
        sys.exit(1)

    text = path.read_text(encoding="utf-8")
    changes = []

    # Backup
    if hermes_home is None:
        hermes_home = _resolve_hermes_home()
    if not dry_run:
        backup = _write_backup(path, hermes_home, dry_run=dry_run)
        changes.append(f"Backup: {backup}")

    # ── 1. Add --themefile to the chat subparser ───────────────────────
    # Insert before: chat_parser.set_defaults(func=cmd_chat)
    themefile_arg_block = (
        '    chat_parser.add_argument(\n'
        '        "--themefile", "--theme",\n'
        '        default=None,\n'
        '        help="Path to a YAML theme file for colours/branding (default: $HERMES_HOME/theme.yaml)"\n'
        '    )\n'
    )
    anchor = 'chat_parser.set_defaults(func=cmd_chat)'
    if anchor in text and '"--themefile"' not in text.split(anchor)[0].rsplit('chat_parser = subparsers.add_parser', 1)[-1]:
        text = text.replace('    ' + anchor, themefile_arg_block + '    ' + anchor)
        changes.append("Added --themefile argument to chat subparser")

    # ── 2. Add --themefile to the top-level parser ─────────────────────
    # Insert before: subparsers = parser.add_subparsers(
    top_themefile_block = (
        '    parser.add_argument(\n'
        '        "--themefile", "--theme",\n'
        '        default=None,\n'
        '        help="Path to a YAML theme file for colours/branding (default: $HERMES_HOME/theme.yaml)"\n'
        '    )\n'
    )
    top_anchor = 'subparsers = parser.add_subparsers('
    if top_anchor in text and '"--themefile"' not in text.split(top_anchor)[0]:
        text = text.replace('    ' + top_anchor, top_themefile_block + '    ' + top_anchor)
        changes.append("Added --themefile argument to top-level parser")

    # ── 3. Pass themefile through in cmd_chat kwargs ───────────────────
    # Add "themefile": getattr(args, "themefile", None), to the kwargs dict
    kwargs_anchor = '"worktree": getattr(args, "worktree", False),'
    themefile_kwarg = '        "themefile": getattr(args, "themefile", None),\n'
    if kwargs_anchor in text and '"themefile"' not in text.split('def cmd_chat')[1].split('cli_main')[0]:
        text = text.replace(
            kwargs_anchor,
            kwargs_anchor + '\n' + themefile_kwarg,
        )
        changes.append("Added themefile to cmd_chat kwargs pass-through")

    # ── 4. Fallback paths ──────────────────────────────────────────────
    # Since --themefile is on both the top-level parser and the chat
    # subparser, args.themefile always exists via argparse defaults.
    # The getattr() in the kwargs dict also handles missing attrs.
    # No additional fallback patching needed.

    # ── Write ──────────────────────────────────────────────────────────
    if not dry_run:
        path.write_text(text, encoding="utf-8")
        changes.append(f"Wrote patched file: {main_py_path}")
    else:
        changes.append("(dry run — no files modified)")

    return changes


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _auto_find_main_py(cli_path: str) -> str | None:
    """Try to find hermes_cli/main.py relative to cli.py."""
    cli_dir = Path(cli_path).resolve().parent
    candidates = [
        cli_dir / "hermes_cli" / "main.py",
        cli_dir / "main.py",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def _resolve_hermes_home(explicit: str | None = None) -> Path:
    raw = (
        (explicit or "").strip()
        or os.getenv("HERMES_HOME", "").strip()
        or os.getenv("HERMESHOME", "").strip()
        or str(Path.home() / ".hermes")
    )
    return Path(raw).expanduser()


def _install_repo_themes(hermes_home: Path, force: bool = False, dry_run: bool = False) -> list[str]:
    """Copy hermilinChat-bundled Hermes themes into $HERMES_HOME/themes."""
    changes: list[str] = []

    if not REPO_THEMES_DIR.exists():
        return changes

    dest_dir = hermes_home / "themes"
    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)

    theme_files = sorted(list(REPO_THEMES_DIR.glob("*.yaml")) + list(REPO_THEMES_DIR.glob("*.yml")))
    for src in theme_files:
        if not src.is_file():
            continue

        dest = dest_dir / src.name
        if dest.exists() and not force:
            changes.append(f"Theme exists (skip): {dest}")
            continue

        if not dry_run:
            shutil.copy2(src, dest)
        changes.append(f"Installed theme: {dest}")

    return changes


def _resolve_hermes_exe(path_or_name: str) -> Path:
    candidate = Path(path_or_name).expanduser()
    if candidate.is_file():
        return candidate.resolve()

    found = shutil.which(path_or_name)
    if not found:
        raise FileNotFoundError(f"Could not find Hermes executable: {path_or_name}")
    return Path(found).resolve()


def _detect_hermes_python(hermes_exe: Path, explicit: str) -> Path:
    """Resolve the Python interpreter used by the Hermes installation."""

    def _abs_no_resolve(path: Path) -> Path:
        p = path.expanduser()
        if p.is_absolute():
            return p
        return (Path.cwd() / p).absolute()

    if explicit:
        python_path = _abs_no_resolve(Path(explicit))
        if not python_path.is_file():
            raise FileNotFoundError(f"Hermes Python not found: {python_path}")
        return python_path

    first_line = hermes_exe.read_text(encoding="utf-8").splitlines()[0].strip()
    if not first_line.startswith("#!"):
        raise RuntimeError(f"Unexpected Hermes launcher format: {hermes_exe}")

    shebang = first_line[2:].strip().split()
    if not shebang:
        raise RuntimeError(f"Could not parse shebang from {hermes_exe}")

    if Path(shebang[0]).name == "env":
        if len(shebang) < 2:
            raise RuntimeError(f"env shebang missing interpreter in {hermes_exe}")
        resolved = shutil.which(shebang[1])
        if not resolved:
            raise RuntimeError(f"Could not resolve interpreter from shebang: {shebang[1]}")
        python_path = _abs_no_resolve(Path(resolved))
        if not python_path.is_file():
            raise FileNotFoundError(f"Hermes Python not found: {python_path}")
        return python_path

    python_path = Path(shebang[0]).expanduser()
    if not python_path.is_absolute():
        python_path = (hermes_exe.parent / python_path).absolute()
    if not python_path.is_file():
        raise FileNotFoundError(f"Hermes Python not found: {python_path}")
    return python_path


def _discover_live_paths(hermes_python: Path) -> dict[str, str]:
    code = r'''
import json
import importlib.util


def _origin(name: str) -> str:
    spec = importlib.util.find_spec(name)
    if spec is None:
        raise SystemExit(f"missing module: {name}")
    if not spec.origin:
        raise SystemExit(f"missing origin for module: {name}")
    return spec.origin


print(json.dumps({
    "cli": _origin("cli"),
    "main": _origin("hermes_cli.main"),
}, ensure_ascii=False))
'''

    result = subprocess.run(
        [str(hermes_python), "-c", code],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"Could not discover Hermes module paths. Stderr: {stderr or '<none>'}")

    data = json.loads(result.stdout.strip())
    return {
        "cli": str(Path(data["cli"]).expanduser()),
        "main": str(Path(data["main"]).expanduser()),
    }


def main():
    parser = argparse.ArgumentParser(
        description="Patch Hermes Agent cli.py (and hermes_cli/main.py) with a theme system",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              # Patch both cli.py and hermes_cli/main.py:
              python install_hermes_themes.py /path/to/hermes-agent/cli.py

              # Patch with hermiline as the baked-in default:
              python install_hermes_themes.py ./cli.py --default-theme hermiline

              # Explicit main.py path (if not auto-detected):
              python install_hermes_themes.py ./cli.py --main-py ./hermes_cli/main.py

              # Dry-run (show changes without modifying):
              python install_hermes_themes.py ./cli.py --dry-run

              # Export a theme YAML to customise:
              python install_hermes_themes.py --export-theme hermiline > my_theme.yaml

            After patching, hermes supports:
              hermes --themefile mytheme.yaml
              hermes chat --themefile mytheme.yaml
              hermes                              # uses ~/.hermes/theme.yaml or baked-in
        """),
    )
    parser.add_argument(
        "cli_path", nargs="?", default=None,
        help="Path to the cli.py file to patch (omit with --auto)",
    )
    parser.add_argument(
        "--auto",
        action="store_true",
        help="Auto-detect the active Hermes installation (via the hermes executable) and patch it",
    )
    parser.add_argument(
        "--hermes-exe",
        default="hermes",
        help="Hermes executable to inspect in --auto mode (default: hermes)",
    )
    parser.add_argument(
        "--hermes-python",
        default="",
        help="Override the Python interpreter used by the Hermes installation (auto-detected from hermes shebang if omitted)",
    )
    parser.add_argument(
        "--hermes-home",
        default="",
        help="Hermes home directory for themes (default: $HERMES_HOME or ~/.hermes)",
    )
    parser.add_argument(
        "--skip-install-themes",
        action="store_true",
        help="Skip copying hermilinChat-bundled themes into $HERMES_HOME/themes",
    )
    parser.add_argument(
        "--force-theme-install",
        action="store_true",
        help="Overwrite theme files in $HERMES_HOME/themes if they already exist",
    )
    parser.add_argument(
        "--main-py",
        default=None,
        help="Path to hermes_cli/main.py (auto-detected from cli.py location if omitted)",
    )
    parser.add_argument(
        "--default-theme", "-t",
        default="hermes-default",
        help="Theme to bake in as the default (bundled name or YAML file path)",
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Show what would change without modifying files",
    )
    parser.add_argument(
        "--list-themes",
        action="store_true",
        help="List bundled themes and exit",
    )
    parser.add_argument(
        "--export-theme",
        metavar="NAME_OR_PATH",
        help="Export a theme as YAML to stdout (bundled name or YAML file to resolve)",
    )

    args = parser.parse_args()

    if args.list_themes:
        print("Bundled themes:")
        for name, t in BUNDLED_THEMES.items():
            desc = t.get("meta", {}).get("description", "")
            print(f"  {name:<20} {desc}")
        sys.exit(0)

    if args.export_theme:
        if args.export_theme in BUNDLED_THEMES:
            t = BUNDLED_THEMES[args.export_theme]
        elif Path(args.export_theme).exists():
            t = load_yaml(args.export_theme)
        else:
            print(f"Error: unknown theme or file: {args.export_theme}", file=sys.stderr)
            sys.exit(1)
        print(theme_to_yaml(t))
        sys.exit(0)

    if not args.cli_path and args.auto:
        try:
            hermes_exe = _resolve_hermes_exe(args.hermes_exe)
            hermes_python = _detect_hermes_python(hermes_exe, args.hermes_python)
            live = _discover_live_paths(hermes_python)
            args.cli_path = live.get("cli")
            if not args.main_py:
                args.main_py = live.get("main")
        except Exception as exc:
            print(f"Error: could not auto-detect Hermes installation: {exc}", file=sys.stderr)
            sys.exit(1)

    if not args.cli_path:
        parser.print_help()
        sys.exit(1)

    # Determine which theme to bake in
    if args.default_theme in BUNDLED_THEMES:
        theme = BUNDLED_THEMES[args.default_theme]
    elif Path(args.default_theme).exists():
        theme = load_yaml(args.default_theme)
    else:
        print(f"Error: unknown theme: {args.default_theme}", file=sys.stderr)
        print(f"  Bundled: {', '.join(BUNDLED_THEMES.keys())}", file=sys.stderr)
        print(f"  Or provide a path to a YAML file", file=sys.stderr)
        sys.exit(1)

    # Auto-detect main.py
    main_py = args.main_py or _auto_find_main_py(args.cli_path)

    print(f"Patching: {args.cli_path}")
    if main_py:
        print(f"     and: {main_py}")
    else:
        print(f"  (hermes_cli/main.py not found — skipping; use --main-py to specify)")
    print(f"Default theme: {theme.get('meta', {}).get('name', args.default_theme)}")
    if args.dry_run:
        print("(dry run)")
    print()

    hermes_home = _resolve_hermes_home(args.hermes_home)

    # Patch cli.py
    changes = patch_cli(args.cli_path, theme, hermes_home=hermes_home, dry_run=args.dry_run)
    for c in changes:
        print(f"  ✓ {c}")

    # Patch main.py
    if main_py:
        print()
        main_changes = patch_main_py(main_py, hermes_home=hermes_home, dry_run=args.dry_run)
        for c in main_changes:
            print(f"  ✓ {c}")

    # Install hermilinChat-bundled themes into $HERMES_HOME/themes
    if not args.skip_install_themes:
        theme_changes = _install_repo_themes(
            hermes_home,
            force=args.force_theme_install,
            dry_run=args.dry_run,
        )
        if theme_changes:
            print()
            for c in theme_changes:
                print(f"  ✓ {c}")

    print()
    if not args.dry_run:
        print("Done! Hermes now supports --theme/--themefile <path>")
        print()
        print("Usage:")
        print("  hermes --theme mytheme.yaml                   # top-level (or --themefile)")
        print("  hermes chat --theme mytheme.yaml              # on chat subcommand")
        print("  hermes                                        # uses $HERMES_HOME/theme.yaml or baked-in")
        print()
        print("Bundled hermilinChat themes are installed to:")
        print("  $HERMES_HOME/themes/")
        print()
        print("To create a custom theme:")
        print(f"  python {sys.argv[0]} --export-theme hermes-default > mytheme.yaml")
        print("  # edit mytheme.yaml, then either:")
        print("  #   cp mytheme.yaml $HERMES_HOME/theme.yaml    (auto-loaded)")
        print("  #   hermes --theme mytheme.yaml                (explicit)")
    else:
        print("No files were modified. Remove --dry-run to apply.")


if __name__ == "__main__":
    main()
