from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import yaml

from .config_editor import _update_dashboard_theme_config_text


DASHBOARD_THEME_PREFIX = "hermelinchat-"
DEFAULT_UI_THEME = "hermelin"


# Native Hermes Dashboard themes generated from hermelinChat's standalone UI
# themes. These are written into $HERMES_HOME/dashboard-themes/ so the
# dashboard's own ThemeSwitcher and config key (`dashboard.theme`) can stay in
# charge, while hermelinChat remains the upstream source of visual truth.
_CARD_CLIP = "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)"
_TAB_CLIP = "polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%, 0 8px)"


def _dashboard_skin(
    marker: str,
    *,
    bg: str,
    chrome_background: str,
    card_background: str,
    card_shadow: str,
    edge_color: str,
    accent_color: str,
    filler_opacity: str,
    filler_blend_mode: str = "normal",
    layout_variant: str = "standard",
    overlay_background: str,
    overlay_opacity: str,
) -> dict[str, Any]:
    """Return native dashboard skin controls shared by generated themes."""

    border_image = f"linear-gradient(135deg, {edge_color}, transparent 42%, {accent_color}) 1"
    return {
        "layoutVariant": layout_variant,
        "assets": {"bg": bg},
        "componentStyles": {
            "backdrop": {
                "fillerOpacity": filler_opacity,
                "fillerBlendMode": filler_blend_mode,
                "backgroundSize": "cover",
                "backgroundPosition": "center",
            },
            "card": {
                "clipPath": _CARD_CLIP,
                "borderImage": border_image,
                "background": card_background,
                "boxShadow": card_shadow,
            },
            "header": {
                "background": chrome_background,
                "borderImage": border_image,
                "clipPath": "polygon(0 0, 100% 0, 100% 100%, 0 100%)",
            },
            "sidebar": {
                "background": chrome_background,
                "borderImage": border_image,
            },
            "tab": {"clipPath": _TAB_CLIP},
        },
        "customCSS": f"""/* hermelinchat-dashboard-skin: {marker} */
body::before {{
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 102;
  background: {overlay_background};
  opacity: {overlay_opacity};
  mix-blend-mode: soft-light;
}}
body::after {{
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 103;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, {accent_color} 18%, transparent), inset 0 0 72px rgba(0, 0, 0, 0.18);
}}
@media (prefers-reduced-motion: reduce) {{
  body::before {{ opacity: calc({overlay_opacity} * 0.45); }}
}}
""",
    }


_DASHBOARD_THEME_DEFINITIONS: dict[str, dict[str, Any]] = {
    "hermelin": {
        "name": "hermelinchat-hermelin",
        "label": "hermelinChat · Hermelin",
        "description": "Matches hermelinChat's amber Hermelin theme.",
        "palette": {
            "background": {"hex": "#08080a", "alpha": 1},
            "midground": {"hex": "#e8e8f0", "alpha": 1},
            "foreground": {"hex": "#ffffff", "alpha": 0},
            "warmGlow": "rgba(245, 183, 49, 0.22)",
            "noiseOpacity": 0.28,
        },
        "typography": {
            "fontSans": "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
            "fontMono": "ui-monospace, \"SF Mono\", \"Cascadia Mono\", Menlo, Consolas, monospace",
            "baseSize": "14px",
            "lineHeight": "1.55",
            "letterSpacing": "0",
        },
        "layout": {"radius": "0.75rem", "density": "comfortable"},
        **_dashboard_skin(
            "hermelin",
            bg=(
                "radial-gradient(circle at 12% 0%, rgba(245, 183, 49, 0.20) 0%, transparent 30%), "
                "radial-gradient(circle at 100% 10%, rgba(255, 212, 128, 0.10) 0%, transparent 32%), "
                "linear-gradient(135deg, rgba(8, 8, 10, 0.96) 0%, rgba(22, 17, 8, 0.94) 48%, rgba(8, 8, 10, 0.98) 100%)"
            ),
            chrome_background="linear-gradient(180deg, rgba(14, 14, 18, 0.96), rgba(8, 8, 10, 0.92))",
            card_background="linear-gradient(180deg, rgba(18, 18, 24, 0.92) 0%, rgba(10, 10, 13, 0.86) 100%)",
            card_shadow="0 0 0 1px rgba(245, 183, 49, 0.16) inset, 0 22px 52px rgba(0, 0, 0, 0.32), 0 0 32px rgba(245, 183, 49, 0.08)",
            edge_color="rgba(245, 183, 49, 0.36)",
            accent_color="#f5b731",
            filler_opacity="0.88",
            overlay_background="repeating-linear-gradient(0deg, rgba(245, 183, 49, 0.14) 0 1px, transparent 1px 5px)",
            overlay_opacity="0.045",
        ),
        "colorOverrides": {
            "card": "#0e0e12",
            "cardForeground": "#e8e8f0",
            "popover": "#16161d",
            "popoverForeground": "#e8e8f0",
            "primary": "#f5b731",
            "primaryForeground": "#08080a",
            "secondary": "#16161d",
            "secondaryForeground": "#b8b8cc",
            "muted": "#16161d",
            "mutedForeground": "#77778c",
            "accent": "#3d2a08",
            "accentForeground": "#ffd480",
            "destructive": "#e84057",
            "destructiveForeground": "#ffffff",
            "success": "#38c878",
            "warning": "#f5b731",
            "border": "#232330",
            "input": "#232330",
            "ring": "#f5b731",
        },
    },
    "matrix": {
        "name": "hermelinchat-matrix",
        "label": "hermelinChat · Matrix",
        "description": "Matches hermelinChat's Matrix rabbit theme.",
        "palette": {
            "background": {"hex": "#0c0f0e", "alpha": 1},
            "midground": {"hex": "#e8f0ec", "alpha": 1},
            "foreground": {"hex": "#ffffff", "alpha": 0},
            "warmGlow": "rgba(77, 255, 161, 0.18)",
            "noiseOpacity": 0.72,
        },
        "typography": {
            "fontSans": "ui-monospace, \"SF Mono\", \"Cascadia Mono\", Menlo, Consolas, monospace",
            "fontMono": "ui-monospace, \"SF Mono\", \"Cascadia Mono\", Menlo, Consolas, monospace",
            "baseSize": "14px",
            "lineHeight": "1.5",
            "letterSpacing": "0.015em",
        },
        "layout": {"radius": "0.35rem", "density": "compact"},
        **_dashboard_skin(
            "matrix",
            bg=(
                "radial-gradient(circle at 15% 0%, rgba(77, 255, 161, 0.16) 0%, transparent 24%), "
                "repeating-linear-gradient(90deg, rgba(77, 255, 161, 0.07) 0 1px, transparent 1px 72px), "
                "linear-gradient(180deg, rgba(4, 12, 8, 0.94) 0%, rgba(7, 18, 13, 0.98) 100%)"
            ),
            chrome_background="linear-gradient(180deg, rgba(6, 18, 13, 0.96), rgba(2, 8, 5, 0.92))",
            card_background="linear-gradient(180deg, rgba(8, 22, 15, 0.92) 0%, rgba(3, 10, 7, 0.88) 100%)",
            card_shadow="0 0 0 1px rgba(77, 255, 161, 0.20) inset, 0 18px 42px rgba(0, 0, 0, 0.38), 0 0 28px rgba(77, 255, 161, 0.09)",
            edge_color="rgba(77, 255, 161, 0.40)",
            accent_color="#4dffa1",
            filler_opacity="0.82",
            layout_variant="tiled",
            overlay_background=(
                "repeating-linear-gradient(0deg, rgba(77, 255, 161, 0.16) 0 1px, transparent 1px 4px), "
                "repeating-linear-gradient(90deg, rgba(77, 255, 161, 0.08) 0 1px, transparent 1px 48px)"
            ),
            overlay_opacity="0.055",
        ),
        "colorOverrides": {
            "card": "#111514",
            "cardForeground": "#e8f0ec",
            "popover": "#1a201f",
            "popoverForeground": "#e8f0ec",
            "primary": "#4dffa1",
            "primaryForeground": "#0c0f0e",
            "secondary": "#1a201f",
            "secondaryForeground": "#c8d8d3",
            "muted": "#1a201f",
            "mutedForeground": "#7b938d",
            "accent": "#0a3019",
            "accentForeground": "#b7ffd6",
            "destructive": "#fb7185",
            "destructiveForeground": "#ffffff",
            "success": "#4dffa1",
            "warning": "#f5e642",
            "border": "#2a3533",
            "input": "#2a3533",
            "ring": "#4dffa1",
        },
    },
    "nous": {
        "name": "hermelinchat-nous",
        "label": "hermelinChat · Nous",
        "description": "Matches hermelinChat's Nous dusk theme.",
        "palette": {
            "background": {"hex": "#0e1028", "alpha": 1},
            "midground": {"hex": "#d0d8f0", "alpha": 1},
            "foreground": {"hex": "#ffffff", "alpha": 0},
            "warmGlow": "rgba(136, 184, 240, 0.18)",
            "noiseOpacity": 0.18,
        },
        "typography": {
            "fontSans": "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
            "fontMono": "ui-monospace, \"SF Mono\", \"Cascadia Mono\", Menlo, Consolas, monospace",
            "baseSize": "14px",
            "lineHeight": "1.58",
            "letterSpacing": "0",
        },
        "layout": {"radius": "0.85rem", "density": "comfortable"},
        **_dashboard_skin(
            "nous",
            bg=(
                "radial-gradient(circle at 15% 0%, rgba(136, 184, 240, 0.22) 0%, transparent 32%), "
                "radial-gradient(circle at 92% 18%, rgba(80, 104, 184, 0.16) 0%, transparent 36%), "
                "linear-gradient(135deg, rgba(10, 12, 32, 0.96) 0%, rgba(18, 24, 56, 0.96) 52%, rgba(9, 10, 24, 0.98) 100%)"
            ),
            chrome_background="linear-gradient(180deg, rgba(18, 22, 48, 0.94), rgba(10, 12, 32, 0.90))",
            card_background="linear-gradient(180deg, rgba(20, 24, 56, 0.88) 0%, rgba(12, 14, 34, 0.82) 100%)",
            card_shadow="0 0 0 1px rgba(136, 184, 240, 0.16) inset, 0 22px 48px rgba(0, 0, 0, 0.28), 0 0 36px rgba(136, 184, 240, 0.07)",
            edge_color="rgba(136, 184, 240, 0.32)",
            accent_color="#88b8f0",
            filler_opacity="0.9",
            overlay_background="linear-gradient(120deg, transparent 0%, rgba(136, 184, 240, 0.16) 50%, transparent 100%)",
            overlay_opacity="0.03",
        ),
        "colorOverrides": {
            "card": "#141838",
            "cardForeground": "#d0d8f0",
            "popover": "#1c2248",
            "popoverForeground": "#d0d8f0",
            "primary": "#88b8f0",
            "primaryForeground": "#0e1028",
            "secondary": "#1c2248",
            "secondaryForeground": "#a0b0d0",
            "muted": "#1c2248",
            "mutedForeground": "#6878a0",
            "accent": "#16284a",
            "accentForeground": "#b7ccff",
            "destructive": "#d08888",
            "destructiveForeground": "#0e1028",
            "success": "#80c088",
            "warning": "#e0c868",
            "border": "#2e3860",
            "input": "#2e3860",
            "ring": "#88b8f0",
        },
    },
    "samaritan": {
        "name": "hermelinchat-samaritan",
        "label": "hermelinChat · Samaritan",
        "description": "Matches hermelinChat's warm Samaritan light theme.",
        "palette": {
            "background": {"hex": "#e8e6e1", "alpha": 1},
            "midground": {"hex": "#1a1816", "alpha": 1},
            "foreground": {"hex": "#ffffff", "alpha": 0},
            "warmGlow": "rgba(204, 51, 51, 0.08)",
            "noiseOpacity": 0.0,
        },
        "typography": {
            "fontSans": "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
            "fontMono": "ui-monospace, \"SF Mono\", \"Cascadia Mono\", Menlo, Consolas, monospace",
            "baseSize": "14px",
            "lineHeight": "1.55",
            "letterSpacing": "0",
        },
        "layout": {"radius": "0.45rem", "density": "comfortable"},
        **_dashboard_skin(
            "samaritan",
            bg=(
                "linear-gradient(135deg, rgba(247, 243, 235, 0.96) 0%, rgba(232, 230, 225, 0.96) 54%, rgba(220, 216, 208, 0.96) 100%), "
                "radial-gradient(circle at 82% 6%, rgba(204, 51, 51, 0.10) 0%, transparent 28%)"
            ),
            chrome_background="linear-gradient(180deg, rgba(247, 243, 235, 0.94), rgba(226, 223, 216, 0.90))",
            card_background="linear-gradient(180deg, rgba(247, 243, 235, 0.90) 0%, rgba(221, 219, 214, 0.86) 100%)",
            card_shadow="0 0 0 1px rgba(170, 32, 32, 0.12) inset, 0 18px 36px rgba(26, 24, 22, 0.10)",
            edge_color="rgba(170, 32, 32, 0.22)",
            accent_color="#cc3333",
            filler_opacity="0",
            overlay_background="linear-gradient(90deg, transparent 0%, rgba(204, 51, 51, 0.12) 50%, transparent 100%)",
            overlay_opacity="0.025",
        ),
        "colorOverrides": {
            "card": "#dddbd6",
            "cardForeground": "#1a1816",
            "popover": "#d2d0cb",
            "popoverForeground": "#1a1816",
            "primary": "#cc3333",
            "primaryForeground": "#f7f3eb",
            "secondary": "#d2d0cb",
            "secondaryForeground": "#3a3835",
            "muted": "#d2d0cb",
            "mutedForeground": "#7a7872",
            "accent": "#f0d8d2",
            "accentForeground": "#aa2020",
            "destructive": "#aa2020",
            "destructiveForeground": "#f7f3eb",
            "success": "#2da565",
            "warning": "#cc3333",
            "border": "#bab8b3",
            "input": "#bab8b3",
            "ring": "#cc3333",
        },
    },
}


def available_ui_themes() -> tuple[str, ...]:
    return tuple(_DASHBOARD_THEME_DEFINITIONS.keys())


def normalize_ui_theme(value: object) -> str:
    theme = str(value or "").strip().lower()
    if theme in _DASHBOARD_THEME_DEFINITIONS:
        return theme
    return DEFAULT_UI_THEME


def dashboard_theme_definition_for_ui_theme(value: object) -> dict[str, Any]:
    return dict(_DASHBOARD_THEME_DEFINITIONS[normalize_ui_theme(value)])


def dashboard_theme_name_for_ui_theme(value: object) -> str:
    return str(_DASHBOARD_THEME_DEFINITIONS[normalize_ui_theme(value)]["name"])


def _theme_yaml(definition: dict[str, Any]) -> str:
    body = yaml.safe_dump(definition, allow_unicode=True, sort_keys=False)
    return (
        "# Generated by hermelinChat.\n"
        "# Source of truth: hermelinChat UI theme settings. This file may be overwritten.\n"
        f"{body}"
    )


def ensure_dashboard_theme_files(hermes_home: Path) -> dict[str, Any]:
    themes_dir = Path(hermes_home).expanduser() / "dashboard-themes"
    themes_dir.mkdir(parents=True, exist_ok=True)

    changed = False
    files: list[str] = []
    for definition in _DASHBOARD_THEME_DEFINITIONS.values():
        name = str(definition["name"])
        path = themes_dir / f"{name}.yaml"
        rendered = _theme_yaml(definition)
        try:
            existing = path.read_text(encoding="utf-8") if path.exists() else None
        except Exception:
            existing = None
        if existing != rendered:
            tmp_path = path.with_name(f".{path.name}.{int(time.time() * 1000)}.tmp")
            tmp_path.write_text(rendered, encoding="utf-8")
            os.replace(tmp_path, path)
            changed = True
        files.append(str(path))

    return {"changed": changed, "files": files}


def sync_dashboard_theme_for_ui_theme(hermes_home: Path, ui_theme: object) -> dict[str, Any]:
    """Install matching dashboard themes and set `dashboard.theme`.

    This mutates only $HERMES_HOME/dashboard-themes/*.yaml and the specific
    `dashboard.theme` key in $HERMES_HOME/config.yaml. It never edits the
    installed Hermes Agent source tree.
    """

    normalized = normalize_ui_theme(ui_theme)
    dashboard_theme = dashboard_theme_name_for_ui_theme(normalized)
    theme_files = ensure_dashboard_theme_files(hermes_home)

    cfg_path = Path(hermes_home).expanduser() / "config.yaml"
    try:
        existing = cfg_path.read_text(encoding="utf-8") if cfg_path.exists() else ""
    except Exception:
        existing = ""

    updated, config_changed = _update_dashboard_theme_config_text(existing, dashboard_theme)
    if config_changed:
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = cfg_path.with_name(f".{cfg_path.name}.{int(time.time() * 1000)}.tmp")
        try:
            tmp_path.write_text(updated, encoding="utf-8")
            os.replace(tmp_path, cfg_path)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            raise

    return {
        "ok": True,
        "ui_theme": normalized,
        "dashboard_theme": dashboard_theme,
        "config_path": str(cfg_path),
        "config_changed": bool(config_changed),
        "theme_files_changed": bool(theme_files["changed"]),
        "theme_files": theme_files["files"],
        "changed": bool(config_changed or theme_files["changed"]),
    }
