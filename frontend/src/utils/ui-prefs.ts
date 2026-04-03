import { DEFAULT_THEME_ID, normalizeThemeId } from '../theme/index.js'
import type { UiPrefs } from '../types'

// ─── Storage keys + defaults ────────────────────────────────────────────────

export const UI_PREFS_STORAGE_KEY = 'hermelinChat.uiPrefs'

export const ARTIFACT_PANEL_WIDTH_STORAGE_KEY = 'hermelinChat.artifactPanelWidth'
export const DEFAULT_ARTIFACT_PANEL_WIDTH = 480

export const CURSOR_STYLE_VALUES = ['bar', 'block', 'underline']
export const BACKGROUND_EFFECT_VALUES = ['auto', 'particles', 'matrix-rain', 'nous-crt', 'samaritan']

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: DEFAULT_THEME_ID,
  // Displayed in the sidebar header + browser tab title. (Empty => fallback)
  appName: 'hermelinChat',
  particles: {
    enabled: true,
    // 50..100 (50 matches the old look)
    intensity: 75,
  },
  background: {
    // 'auto' means "use the active theme's default background effect"
    effect: 'auto',
  },
  timestamps: {
    enabled: true,
  },
  terminal: {
    cursorStyle: 'bar',
    cursorBlink: true,
  },
  // Extra post-processing effects intended for screen recordings.
  // These are local-only (saved in browser localStorage).
  videoFx: {
    enabled: false,
    // 0..100
    intensity: 65,
    glitchPulses: true,
  },
}

// ─── Pure utils ─────────────────────────────────────────────────────────────

export function clampNum(n: unknown, min: number, max: number): number {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

export function normalizeUiPrefs(raw: unknown): UiPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const p = r.particles && typeof r.particles === 'object' ? (r.particles as Record<string, unknown>) : {}
  const bg = r.background && typeof r.background === 'object' ? (r.background as Record<string, unknown>) : {}
  const ts = r.timestamps && typeof r.timestamps === 'object' ? (r.timestamps as Record<string, unknown>) : {}
  const term = r.terminal && typeof r.terminal === 'object' ? (r.terminal as Record<string, unknown>) : {}
  const vx = r.videoFx && typeof r.videoFx === 'object' ? (r.videoFx as Record<string, unknown>) : {}

  const cursorStyleRaw = term.cursorStyle ?? DEFAULT_UI_PREFS.terminal.cursorStyle
  const cursorStyleStr = String(cursorStyleRaw || '').toLowerCase()
  const cursorStyle = CURSOR_STYLE_VALUES.includes(cursorStyleStr)
    ? (cursorStyleStr as 'bar' | 'block' | 'underline')
    : DEFAULT_UI_PREFS.terminal.cursorStyle

  const theme = normalizeThemeId(r.theme ?? DEFAULT_UI_PREFS.theme)

  const appNameRaw = r.appName
  // Keep empty string (means "use default") to make text editing ergonomic.
  const appName =
    appNameRaw === undefined || appNameRaw === null
      ? DEFAULT_UI_PREFS.appName
      : String(appNameRaw).slice(0, 64)

  const effectRaw = bg.effect ?? DEFAULT_UI_PREFS.background.effect
  const effectStr = String(effectRaw || '').toLowerCase()
  const effect = BACKGROUND_EFFECT_VALUES.includes(effectStr)
    ? effectStr
    : DEFAULT_UI_PREFS.background.effect

  return {
    theme,
    appName: appName.trim(),
    particles: {
      enabled: p.enabled === undefined ? DEFAULT_UI_PREFS.particles.enabled : !!p.enabled,
      intensity: clampNum(p.intensity ?? DEFAULT_UI_PREFS.particles.intensity, 50, 100),
    },
    background: {
      effect,
    },
    timestamps: {
      enabled: ts.enabled === undefined ? DEFAULT_UI_PREFS.timestamps.enabled : !!ts.enabled,
    },
    terminal: {
      cursorStyle,
      cursorBlink: term.cursorBlink === undefined ? DEFAULT_UI_PREFS.terminal.cursorBlink : !!term.cursorBlink,
    },
    videoFx: {
      enabled: vx.enabled === undefined ? DEFAULT_UI_PREFS.videoFx.enabled : !!vx.enabled,
      intensity: clampNum(vx.intensity ?? DEFAULT_UI_PREFS.videoFx.intensity, 0, 100),
      glitchPulses: vx.glitchPulses === undefined ? DEFAULT_UI_PREFS.videoFx.glitchPulses : !!vx.glitchPulses,
    },
  }
}

export function loadUiPrefs(): UiPrefs {
  if (typeof window === 'undefined') return normalizeUiPrefs(DEFAULT_UI_PREFS)
  try {
    const s = window.localStorage?.getItem(UI_PREFS_STORAGE_KEY)
    if (!s) return normalizeUiPrefs(DEFAULT_UI_PREFS)
    return normalizeUiPrefs(JSON.parse(s))
  } catch {
    return normalizeUiPrefs(DEFAULT_UI_PREFS)
  }
}

export function saveUiPrefs(prefs: UiPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // ignore
  }
}

export function clampArtifactPanelWidth(value: unknown): number {
  const hardMin = 320
  const hardMax = 960

  const w = Number(value)
  const base = Number.isFinite(w) ? w : DEFAULT_ARTIFACT_PANEL_WIDTH

  if (typeof window === 'undefined') {
    return Math.max(hardMin, Math.min(hardMax, base))
  }

  const terminalMin = 340
  const viewport = Number(window.innerWidth)
  const viewportMax = Number.isFinite(viewport) ? viewport - terminalMin : hardMax
  const max = Math.max(hardMin, Math.min(hardMax, viewportMax))

  return Math.max(hardMin, Math.min(max, base))
}

export function loadArtifactPanelWidth(): number {
  if (typeof window === 'undefined') return clampArtifactPanelWidth(DEFAULT_ARTIFACT_PANEL_WIDTH)
  try {
    const raw = window.localStorage?.getItem(ARTIFACT_PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return clampArtifactPanelWidth(DEFAULT_ARTIFACT_PANEL_WIDTH)
    return clampArtifactPanelWidth(Number(raw))
  } catch {
    return clampArtifactPanelWidth(DEFAULT_ARTIFACT_PANEL_WIDTH)
  }
}

export function saveArtifactPanelWidth(width: number): void {
  if (typeof window === 'undefined') return
  try {
    const w = Math.round(clampArtifactPanelWidth(width))
    window.localStorage?.setItem(ARTIFACT_PANEL_WIDTH_STORAGE_KEY, String(w))
  } catch {
    // ignore
  }
}
