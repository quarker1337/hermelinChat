import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'

import ArtifactPanel from './components/ArtifactPanel.jsx'
import VideoFxOverlay from './components/VideoFxOverlay.jsx'

import { AMBER, SLATE, DEFAULT_THEME_ID, THEME_OPTIONS, THEMES, normalizeThemeId, setActiveThemeId, hexToRgb } from './theme/index.js'

// ─── UI PREFS (LOCAL) ───────────────────────────────────────────────
// Stored in localStorage and applied instantly (no backend required).
const UI_PREFS_STORAGE_KEY = 'hermelinChat.uiPrefs'

const ARTIFACT_PANEL_WIDTH_STORAGE_KEY = 'hermelinChat.artifactPanelWidth'
const DEFAULT_ARTIFACT_PANEL_WIDTH = 480

const CURSOR_STYLE_VALUES = ['bar', 'block', 'underline']
const BACKGROUND_EFFECT_VALUES = ['auto', 'particles', 'matrix-rain', 'nous-crt', 'samaritan']

// Release version (keep in sync with git tag + backend pyproject).
const HERMELINCHAT_VERSION = '0.13'

const DEFAULT_UI_PREFS = {
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

function clampNum(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

function normalizeUiPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const p = r.particles && typeof r.particles === 'object' ? r.particles : {}
  const bg = r.background && typeof r.background === 'object' ? r.background : {}
  const ts = r.timestamps && typeof r.timestamps === 'object' ? r.timestamps : {}
  const term = r.terminal && typeof r.terminal === 'object' ? r.terminal : {}
  const vx = r.videoFx && typeof r.videoFx === 'object' ? r.videoFx : {}

  const cursorStyleRaw = term.cursorStyle ?? DEFAULT_UI_PREFS.terminal.cursorStyle
  const cursorStyleStr = String(cursorStyleRaw || '').toLowerCase()
  const cursorStyle = CURSOR_STYLE_VALUES.includes(cursorStyleStr)
    ? cursorStyleStr
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

function loadUiPrefs() {
  if (typeof window === 'undefined') return normalizeUiPrefs(DEFAULT_UI_PREFS)
  try {
    const s = window.localStorage?.getItem(UI_PREFS_STORAGE_KEY)
    if (!s) return normalizeUiPrefs(DEFAULT_UI_PREFS)
    return normalizeUiPrefs(JSON.parse(s))
  } catch {
    return normalizeUiPrefs(DEFAULT_UI_PREFS)
  }
}

function saveUiPrefs(prefs) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // ignore
  }
}

function clampArtifactPanelWidth(value) {
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

function loadArtifactPanelWidth() {
  if (typeof window === 'undefined') return clampArtifactPanelWidth(DEFAULT_ARTIFACT_PANEL_WIDTH)
  try {
    const raw = window.localStorage?.getItem(ARTIFACT_PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return clampArtifactPanelWidth(DEFAULT_ARTIFACT_PANEL_WIDTH)
    return clampArtifactPanelWidth(Number(raw))
  } catch {
    return clampArtifactPanelWidth(DEFAULT_ARTIFACT_PANEL_WIDTH)
  }
}

function saveArtifactPanelWidth(width) {
  if (typeof window === 'undefined') return
  try {
    const w = Math.round(clampArtifactPanelWidth(width))
    window.localStorage?.setItem(ARTIFACT_PANEL_WIDTH_STORAGE_KEY, String(w))
  } catch {
    // ignore
  }
}

function formatModelLabel(raw) {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return null

    // Sometimes the backend leaks a dict-ish string here (e.g.
    // "{'default': 'z-ai/glm-5', 'provider': 'openrouter'}").
    // Try to extract a real model id for display.
    const mDefault = s.match(/['"]default['"]\s*:\s*['"]([^'"]+)['"]/)
    if (mDefault && mDefault[1]) return mDefault[1].trim() || s

    const mModel = s.match(/['"]model['"]\s*:\s*['"]([^'"]+)['"]/)
    if (mModel && mModel[1]) return mModel[1].trim() || s

    // YAML-ish mapping (no quotes): "{default: z-ai/glm-5, provider: openrouter}"
    const mYamlDefault = s.match(/\bdefault\s*:\s*([^,}]+)/)
    if (mYamlDefault && mYamlDefault[1]) {
      const v = mYamlDefault[1].trim().replace(/^['"]|['"]$/g, '')
      return v || s
    }

    return s
  }

  if (typeof raw === 'object') {
    const o = raw || {}
    const v = o.default ?? o.model ?? o.value ?? o.id ?? o.name
    if (typeof v === 'string') {
      const s = v.trim()
      return s || null
    }
    return null
  }

  return String(raw)
}

// Small inline version for headers
// Reuses the app favicon (yellow circle + hermelin face)
const InvertelinSmall = ({ size = 22, href = '/favicon.svg' }) => (
  <img
    src={href}
    width={size}
    height={size}
    alt=""
    draggable={false}
    style={{ display: 'block' }}
  />
)

function normalizeInlineSvg(svgRaw) {
  const s = (svgRaw || '').toString()
  if (!s) return ''
  return s
    .replace('<svg ', '<svg width="100%" height="100%" style="display:block" ')
    .replace(/fill="black"/g, 'fill="currentColor"')
}

function svgViewBoxAspect(svgRaw) {
  const s = (svgRaw || '').toString()
  if (!s) return 1
  const m = s.match(/viewBox\s*=\s*"([^"]+)"/)
  if (!m) return 1
  const parts = m[1].trim().split(/[\s,]+/).map((v) => Number(v))
  if (parts.length !== 4) return 1
  const w = parts[2]
  const h = parts[3]
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) return 1
  return w / h
}

const InlineSvgIcon = ({ svgRaw, size = 18, color = AMBER[400], title = '' }) => {
  const svg = useMemo(() => normalizeInlineSvg(svgRaw), [svgRaw])
  const aspect = svgViewBoxAspect(svgRaw)
  const w = Math.round(size * aspect)

  return (
    <span
      title={title || undefined}
      style={{
        display: 'inline-block',
        width: w,
        height: size,
        color,
        lineHeight: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

const SidebarDockIcon = ({ expand = false, size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
    <polyline points={expand ? '12 9 15 12 12 15' : '15 9 12 12 15 15'} />
  </svg>
)

const SettingsIcon = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const PlusIcon = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const LogoutIcon = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

// ─── PARTICLE FIELD ────────────────────────────────────────────────
const ParticleField = ({ intensity = 50 }) => {
  const canvasRef = useRef(null)

  const pct = clampNum(intensity, 0, 100)
  // 50 == current look
  const factor = pct / 50
  const canvasOpacity = clampNum(0.5 * factor, 0, 1)

  const accentHex = AMBER[400] || '#f5b731'
  const accentRgb = hexToRgb(accentHex) || { r: 245, g: 183, b: 49 }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId
    let particles = []

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800
      canvas.height = canvas.parentElement?.offsetHeight || 600

      const count = Math.max(0, Math.round(60 * factor))
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        o: Math.min(0.22, (Math.random() * 0.15 + 0.03) * factor),
      }))
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = canvas.width
        if (p.x > canvas.width) p.x = 0
        if (p.y < 0) p.y = canvas.height
        if (p.y > canvas.height) p.y = 0
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${p.o})`
        ctx.fill()
      }

      const connBase = Math.min(0.08, 0.04 * factor)
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < 120) {
            ctx.beginPath()
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            ctx.strokeStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${connBase * (1 - d / 120)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }
      animId = requestAnimationFrame(draw)
    }

    init()
    window.addEventListener('resize', init)
    draw()
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
    }
  }, [factor, accentRgb.r, accentRgb.g, accentRgb.b])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: canvasOpacity,
        zIndex: 0,
      }}
    />
  )
}

const GrainOverlay = ({ opacity = 0.03 }) => (
  <div
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      pointerEvents: 'none',
      zIndex: 10,
      opacity,
      mixBlendMode: 'overlay',
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
    }}
  />
)

// ─── MATRIX RAIN FIELD ───────────────────────────────────────────────
const MatrixRainField = ({ intensity = 50, config }) => {
  const canvasRef = useRef(null)

  const pct = clampNum(intensity, 0, 100)
  // 75 == "normal" intensity
  const factor = pct / 75

  const cfg = config && typeof config === 'object' ? config : {}

  const colWidth = clampNum(cfg.colWidth ?? 14, 8, 32)
  const fontSize = clampNum(cfg.fontSize ?? 12, 8, 24)
  const fadeAlpha = clampNum(cfg.fadeAlpha ?? 0.04, 0.01, 0.2)
  const baseOpacity = clampNum(cfg.opacity ?? 0.3, 0, 1)
  const canvasOpacity = clampNum(baseOpacity * factor, 0, 1)

  const speedBase = clampNum(cfg.speedBase ?? 0.3, 0.01, 5)
  const speedJitter = clampNum(cfg.speedJitter ?? 0.25, 0, 5)

  // Optional throttling + palette tweaks (see matrix_effect.js reference)
  const frameMs = clampNum(cfg.frameMs ?? 0, 0, 250)
  const redChance = clampNum(cfg.redChance ?? 0, 0, 1)
  // When a drop is past the bottom, chance (per draw) to reset it back to the top.
  const resetChance = clampNum(cfg.resetChance ?? 0.98, 0, 1)

  const redBrightHex = cfg.redBright ?? '#ff4d4d'
  const redMidHex = cfg.redMid ?? '#cc2a2a'
  const redDimHex = cfg.redDim ?? '#7a1616'

  const redBright = hexToRgb(redBrightHex) || { r: 255, g: 77, b: 77 }
  const redMid = hexToRgb(redMidHex) || redBright
  const redDim = hexToRgb(redDimHex) || redMid

  const brightHex = AMBER[400] || '#4dffa1'
  const midHex = AMBER[500] || brightHex
  const dimHex = AMBER[700] || midHex

  const bright = hexToRgb(brightHex) || { r: 77, g: 255, b: 161 }
  const mid = hexToRgb(midHex) || bright
  const dim = hexToRgb(dimHex) || mid

  const bgHex = SLATE.bg || '#0c0f0e'
  const bgRgb = hexToRgb(bgHex) || { r: 12, g: 15, b: 14 }

  const chars =
    'アウエオカキクケコサシスセソタチツテトナニネノハヒフヘホマミムメモヤユヨラリルレロワン01234589ABCDEF'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    if (prefersReducedMotion) return

    let animId
    let drops = []
    let columns = 0
    let lastDraw = 0

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800
      canvas.height = canvas.parentElement?.offsetHeight || 600

      columns = Math.max(1, Math.floor(canvas.width / colWidth))
      drops = Array(columns)
        .fill(0)
        .map(() => Math.random() * -80)

      ctx.font = `${fontSize}px monospace`
      ctx.textBaseline = 'top'
    }

    const draw = (ts) => {
      animId = requestAnimationFrame(draw)

      // Throttle draws (prevents smear when speed is low).
      if (frameMs > 0 && lastDraw && ts - lastDraw < frameMs) return

      const dt = lastDraw ? Math.min(200, ts - lastDraw) : 16
      lastDraw = ts

      // Fade to background (creates trails).
      ctx.fillStyle = `rgba(${bgRgb.r},${bgRgb.g},${bgRgb.b},${fadeAlpha})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      const step = (dt / 16) * factor

      for (let i = 0; i < drops.length; i++) {
        const c = chars[Math.floor(Math.random() * chars.length)]
        const b = Math.random()
        const isRed = redChance > 0 && Math.random() < redChance

        if (isRed) {
          if (b > 0.96) {
            ctx.fillStyle = `rgba(${redBright.r},${redBright.g},${redBright.b},0.5)`
          } else if (b > 0.85) {
            ctx.fillStyle = `rgba(${redMid.r},${redMid.g},${redMid.b},0.18)`
          } else {
            ctx.fillStyle = `rgba(${redDim.r},${redDim.g},${redDim.b},0.08)`
          }
        } else {
          if (b > 0.96) {
            ctx.fillStyle = `rgba(${bright.r},${bright.g},${bright.b},0.5)`
          } else if (b > 0.85) {
            ctx.fillStyle = `rgba(${mid.r},${mid.g},${mid.b},0.18)`
          } else {
            ctx.fillStyle = `rgba(${dim.r},${dim.g},${dim.b},0.08)`
          }
        }

        const x = i * colWidth
        const y = drops[i] * colWidth

        ctx.fillText(c, x, y)

        if (y > canvas.height && Math.random() > resetChance) {
          drops[i] = 0
        } else {
          drops[i] += (speedBase + Math.random() * speedJitter) * step
        }
      }
    }

    init()
    window.addEventListener('resize', init)
    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
    }
  }, [
    colWidth,
    fontSize,
    fadeAlpha,
    factor,
    speedBase,
    speedJitter,
    frameMs,
    redChance,
    resetChance,

    redBrightHex,
    redBright.r,
    redBright.g,
    redBright.b,

    redMidHex,
    redMid.r,
    redMid.g,
    redMid.b,

    redDimHex,
    redDim.r,
    redDim.g,
    redDim.b,

    brightHex,
    bright.r,
    bright.g,
    bright.b,

    midHex,
    mid.r,
    mid.g,
    mid.b,

    dimHex,
    dim.r,
    dim.g,
    dim.b,

    bgHex,
    bgRgb.r,
    bgRgb.g,
    bgRgb.b,
  ])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: canvasOpacity,
        zIndex: 0,
      }}
    />
  )
}

const NousCRTField = ({ intensity = 50 }) => {
  const canvasRef = useRef(null)

  const pct = clampNum(intensity, 0, 100)
  // 75 == "normal" intensity
  const factor = pct / 75
  const canvasOpacity = clampNum(0.9 * factor, 0, 1)

  const accentHex = AMBER[400] || '#5cc8e6'
  const accentRgb = hexToRgb(accentHex) || { r: 92, g: 200, b: 230 }

  const bgHex = SLATE.bg || '#06181e'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    if (prefersReducedMotion) return

    let animId
    let t = 0

    const f = clampNum(factor, 0, 2)

    const baseCount = 25
    const phosphorCount = Math.max(0, Math.round(baseCount * f))

    const phosphors = Array.from({ length: phosphorCount }, () => ({
      x: 0,
      y: 0,
      r: (Math.random() * 60 + 20) * clampNum(f, 0.7, 1.3),
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.003 + 0.001,
      maxOpacity: Math.min(0.08, (Math.random() * 0.04 + 0.01) * f),
    }))

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight
      for (const p of phosphors) {
        p.x = Math.random() * canvas.width
        p.y = Math.random() * canvas.height
      }
    }

    const draw = () => {
      const W = canvas.width
      const H = canvas.height

      // Base fill
      ctx.fillStyle = bgHex
      ctx.fillRect(0, 0, W, H)

      // Phosphor glow patches
      for (const p of phosphors) {
        const pulse = (Math.sin(t * p.speed + p.phase) + 1) * 0.5
        const opacity = p.maxOpacity * pulse
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
        g.addColorStop(0, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${opacity})`)
        g.addColorStop(1, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0)`)
        ctx.fillStyle = g
        ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2)
      }

      // Heavy scanlines
      const scanAlpha = 0.12 * f
      if (scanAlpha > 0.001) {
        ctx.fillStyle = `rgba(0,0,0,${scanAlpha})`
        for (let y = 0; y < H; y += 2) {
          ctx.fillRect(0, y, W, 1)
        }
      }

      // Vertical sub-pixel columns
      const colAlpha = 0.02 * f
      if (colAlpha > 0.001) {
        ctx.fillStyle = `rgba(0,0,0,${colAlpha})`
        for (let x = 0; x < W; x += 3) {
          ctx.fillRect(x, 0, 1, H)
        }
      }

      // Screen curvature vignette
      const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.65)
      vig.addColorStop(0, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${0.02 * f})`)
      vig.addColorStop(0.6, 'rgba(0,0,0,0)')
      vig.addColorStop(1, `rgba(0,0,0,${0.35 * Math.min(1, f)})`)
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Rolling interference bar
      const rollY = ((t * 0.3) % (H + 120)) - 60
      ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${0.015 * f})`
      ctx.fillRect(0, rollY, W, 40)
      ctx.fillStyle = `rgba(0,0,0,${0.03 * f})`
      ctx.fillRect(0, rollY + 40, W, 20)

      // Whole-screen flicker removed (too distracting)

      // Occasional horizontal glitch line
      if (Math.random() < 0.01 * f) {
        const gy = Math.random() * H
        const a = Math.random() * 0.08 * f + 0.02 * f
        ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${a})`
        ctx.fillRect(0, gy, W, 1 + Math.random() * 2)
      }

      // Corner shadows for CRT bezel feel
      const corners = [
        [0, 0],
        [W, 0],
        [0, H],
        [W, H],
      ]

      const cornerAlpha = 0.25 * Math.min(1, f)
      for (const [cx, cy] of corners) {
        const c = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.35)
        c.addColorStop(0, `rgba(0,0,0,${cornerAlpha})`)
        c.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = c
        const rx = cx === 0 ? 0 : W * 0.6
        const ry = cy === 0 ? 0 : H * 0.6
        ctx.fillRect(rx, ry, W * 0.4, H * 0.4)
      }

      t++
      animId = requestAnimationFrame(draw)
    }

    init()
    window.addEventListener('resize', init)
    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
    }
  }, [factor, accentRgb.r, accentRgb.g, accentRgb.b, bgHex])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: canvasOpacity,
        zIndex: 0,
      }}
    />
  )
}

const SamaritanField = ({ intensity = 50 }) => {
  const canvasRef = useRef(null)

  const pct = clampNum(intensity, 0, 100)
  // 75 == "normal" intensity
  const factor = pct / 75
  const canvasOpacity = clampNum(0.85 * factor, 0, 1)

  const bgHex = SLATE.bg || '#e8e6e1'
  const bgRgb = hexToRgb(bgHex) || { r: 232, g: 230, b: 225 }

  const textHex = SLATE.text || '#3a3835'
  const textRgb = hexToRgb(textHex) || { r: 58, g: 56, b: 53 }

  const borderHex = SLATE.border || '#bab8b3'
  const borderRgb = hexToRgb(borderHex) || { r: 186, g: 184, b: 179 }

  const accentHex = AMBER[400] || '#cc3333'
  const accentRgb = hexToRgb(accentHex) || { r: 204, g: 51, b: 51 }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    if (prefersReducedMotion) return

    let animId
    let t = 0

    const f = clampNum(factor, 0, 2)

    let blocks = []
    const maxBlocks = Math.max(10, Math.round(45 * f))

    const nodeCount = Math.max(4, Math.round(8 * f))
    const nodes = Array.from({ length: nodeCount }, () => ({
      x: 0,
      y: 0,
      vx: (Math.random() - 0.5) * 0.04,
      vy: (Math.random() - 0.5) * 0.04,
      phase: Math.random() * Math.PI * 2,
    }))

    const spawnBlock = (W, H) => {
      const isH = Math.random() > 0.35
      const depth = Math.random()
      let x, y, vx, vy

      const speedScale = 0.8 + f * 0.6

      if (isH) {
        const left = Math.random() > 0.5
        x = left ? -120 : W + 120
        y = Math.random() * H
        vx = (left ? 1 : -1) * (0.1 + depth * 0.5) * speedScale
        vy = (Math.random() - 0.5) * 0.05
      } else {
        const top = Math.random() > 0.5
        x = Math.random() * W
        y = top ? -80 : H + 80
        vx = (Math.random() - 0.5) * 0.05
        vy = (top ? 1 : -1) * (0.1 + depth * 0.5) * speedScale
      }

      let w = (Math.random() * 35 + 8) * (0.3 + depth * 0.7)
      let h = (Math.random() * 6 + 2) * (0.3 + depth * 0.7)
      if (Math.random() < 0.2) {
        const tmp = w
        w = h * 0.6
        h = tmp * 1.2
      }

      return {
        x,
        y,
        vx,
        vy,
        w,
        h,
        depth,
        opacity: (0.06 + depth * 0.2) * (0.4 + Math.random() * 0.6) * (0.7 + f * 0.6),
        life: 0,
        maxLife: 600 + Math.random() * 800,
      }
    }

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight

      blocks = []
      const seedCount = Math.max(0, Math.round(30 * f))
      for (let i = 0; i < seedCount; i++) {
        const b = spawnBlock(canvas.width, canvas.height)
        b.life = Math.random() * b.maxLife
        blocks.push(b)
      }

      for (const n of nodes) {
        n.x = Math.random() * canvas.width
        n.y = Math.random() * canvas.height
      }
    }

    const draw = () => {
      const W = canvas.width
      const H = canvas.height

      // Base
      ctx.fillStyle = bgHex
      ctx.fillRect(0, 0, W, H)

      // Vignette
      const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.8)
      vig.addColorStop(0, `rgba(${bgRgb.r},${bgRgb.g},${bgRgb.b},0)`)
      vig.addColorStop(1, `rgba(${borderRgb.r},${borderRgb.g},${borderRgb.b},${(0.22 * f).toFixed(4)})`)
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Grid
      const gridAlpha = 0.025 * f
      if (gridAlpha > 0.001) {
        ctx.strokeStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${gridAlpha.toFixed(4)})`
        ctx.lineWidth = 0.5
        for (let x = 0; x < W; x += 70) {
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, H)
          ctx.stroke()
        }
        for (let y = 0; y < H; y += 70) {
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(W, y)
          ctx.stroke()
        }
      }

      // Connection nodes
      for (const n of nodes) {
        n.x += n.vx + Math.sin(t * 0.0008 + n.phase) * 0.02
        n.y += n.vy + Math.cos(t * 0.0006 + n.phase) * 0.015
        if (n.x < 0) n.x = W
        if (n.x > W) n.x = 0
        if (n.y < 0) n.y = H
        if (n.y > H) n.y = 0
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
          if (dist < 300) {
            const alpha = (1 - dist / 300) * 0.03 * f
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            if ((i + j) % 2 === 0) {
              ctx.lineTo(b.x, a.y)
              ctx.lineTo(b.x, b.y)
            } else {
              ctx.lineTo(a.x, b.y)
              ctx.lineTo(b.x, b.y)
            }
            ctx.strokeStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${alpha.toFixed(4)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }

      // Spawn blocks
      if (blocks.length < maxBlocks && Math.random() < 0.03 * f) {
        blocks.push(spawnBlock(W, H))
      }

      // Draw blocks
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        b.x += b.vx
        b.y += b.vy
        b.life++

        if (
          b.life > b.maxLife ||
          b.x < -200 ||
          b.x > W + 200 ||
          b.y < -200 ||
          b.y > H + 200
        ) {
          blocks.splice(i, 1)
          continue
        }

        const alpha =
          b.opacity *
          Math.min(b.life / 60, 1) *
          Math.min((b.maxLife - b.life) / 80, 1)

        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
        const bl = sp * 3 * b.depth

        ctx.save()
        ctx.translate(b.x, b.y)
        ctx.fillStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${alpha.toFixed(4)})`
        ctx.fillRect(-b.w / 2 - (b.vx > 0 ? bl : 0), -b.h / 2, b.w + bl, b.h)
        if (bl > 1) {
          ctx.fillStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${(alpha * 0.15).toFixed(4)})`
          ctx.fillRect(b.vx > 0 ? -b.w / 2 - bl * 1.5 : b.w / 2, -b.h / 2, bl * 1.5, b.h)
        }
        ctx.restore()
      }

      // Scanlines
      const scanAlpha = 0.012 * f
      if (scanAlpha > 0.001) {
        ctx.fillStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${scanAlpha.toFixed(4)})`
        for (let y = 0; y < H; y += 3) {
          ctx.fillRect(0, y, W, 1)
        }
      }

      // Moving scan bar (slight accent)
      const scanY = (t * 0.15) % (H + 60) - 30
      ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${(0.01 * f).toFixed(4)})`
      ctx.fillRect(0, scanY, W, 30)

      t++
      animId = requestAnimationFrame(draw)
    }

    init()
    window.addEventListener('resize', init)
    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
    }
  }, [
    factor,
    bgHex,
    bgRgb.r,
    bgRgb.g,
    bgRgb.b,
    textRgb.r,
    textRgb.g,
    textRgb.b,
    borderRgb.r,
    borderRgb.g,
    borderRgb.b,
    accentRgb.r,
    accentRgb.g,
    accentRgb.b,
  ])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: canvasOpacity,
        zIndex: 0,
      }}
    />
  )
}

const ScanlinesOverlay = ({ opacity = 0.06 }) => {
  const accentHex = AMBER[400] || '#34d399'
  const accentRgb = hexToRgb(accentHex) || { r: 52, g: 211, b: 153 }
  const stripe = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.12)`

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 10,
        opacity,
        mixBlendMode: 'overlay',
        backgroundImage: `repeating-linear-gradient(to bottom, ${stripe} 0, ${stripe} 1px, rgba(0,0,0,0) 4px, rgba(0,0,0,0) 7px)`,
      }}
    />
  )
}

const SidebarItem = ({ label, active, onClick }) => {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: "'JetBrains Mono',monospace",
        color: active ? AMBER[400] : hovered ? SLATE.textBright : SLATE.muted,
        background: active ? `${AMBER[900]}40` : hovered ? `${SLATE.elevated}` : 'transparent',
        borderLeft: active ? `2px solid ${AMBER[400]}` : '2px solid transparent',
        transition: 'all 0.15s ease',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}

function isoToLocalLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function isoToTimeLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const HighlightedSnippet = ({ text }) => {
  const s = (text || '').toString()
  if (!s) return null

  const nodes = []
  let inside = false
  let buf = ''

  const flush = (kind) => {
    if (!buf) return
    if (kind === 'hit') {
      nodes.push(
        <span key={nodes.length} style={{ color: AMBER[400] }}>
          {buf}
        </span>,
      )
    } else {
      nodes.push(<span key={nodes.length}>{buf}</span>)
    }
    buf = ''
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '[' && !inside) {
      flush('txt')
      inside = true
      continue
    }
    if (ch === ']' && inside) {
      flush('hit')
      inside = false
      continue
    }
    buf += ch
  }
  flush(inside ? 'hit' : 'txt')

  return <span>{nodes}</span>
}

const SessionRow = ({ title, preview, right, active, onClick }) => {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        padding: '9px 12px',
        borderRadius: 6,
        cursor: 'pointer',
        background: active ? `${AMBER[900]}40` : hovered ? `${SLATE.elevated}` : 'transparent',
        borderLeft: active ? `2px solid ${AMBER[400]}` : '2px solid transparent',
        transition: 'all 0.15s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div
          style={{
            flex: 1,
            fontSize: 12,
            color: active ? AMBER[400] : hovered ? SLATE.textBright : SLATE.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={title}
        >
          {title}
        </div>
        {right && (
          <div style={{ fontSize: 10, color: SLATE.muted, whiteSpace: 'nowrap' }}>{right}</div>
        )}
      </div>
      {preview && (
        <div
          style={{
            marginTop: 3,
            fontSize: 10,
            color: SLATE.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={typeof preview === 'string' ? preview : undefined}
        >
          {preview}
        </div>
      )}
    </div>
  )
}

const SearchHitRow = ({ hit, active, onClick, showTimestamp = true }) => {
  const [hovered, setHovered] = useState(false)

  const role = (hit?.role || '').toLowerCase()
  const badge = role === 'assistant' ? '⚡' : '●'
  const badgeColor = role === 'assistant' ? AMBER[500] : SLATE.textBright

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        padding: '6px 12px 6px 28px',
        borderRadius: 6,
        cursor: 'pointer',
        background: active ? `${AMBER[900]}33` : hovered ? `${SLATE.elevated}` : 'transparent',
        transition: 'all 0.15s ease',
        marginTop: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        {showTimestamp && (
          <div style={{ width: 44, fontSize: 10, color: SLATE.muted, flexShrink: 0 }}>{isoToTimeLabel(hit?.timestamp_iso)}</div>
        )}
        <div style={{ width: 14, color: badgeColor, flexShrink: 0 }}>{badge}</div>
        <div
          style={{
            flex: 1,
            fontSize: 11,
            color: SLATE.muted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={hit?.snippet}
        >
          <HighlightedSnippet text={hit?.snippet} />
        </div>
      </div>
    </div>
  )
}

const AlignmentEasterEgg = ({ toast, svgRaw, title, whisperText, fetchFromApi = true }) => {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)

  const baseWhisper = ((whisperText || '').toString().trim() || 'aligned to you…').slice(0, 80)
  const [whisper, setWhisper] = useState(baseWhisper)

  const toastText = (toast?.text || '').toString().trim()
  const toastActive = !!toastText
  const toastMs = Math.max(300, Number(toast?.ms) || 2600)
  const toastId = toast?.id || ''

  const opacity = open ? 0.75 : toastActive ? 0.75 : hovered ? 0.25 : 0.08

  const fetchWhisper = useCallback(async () => {
    try {
      const r = await fetch('/api/whisper')
      if (!r.ok) throw new Error(`http ${r.status}`)
      const data = await r.json()
      const t = (data?.text || '').toString().trim()
      setWhisper((t || baseWhisper || 'aligned to you…').slice(0, 80))
    } catch {
      setWhisper((baseWhisper || 'aligned to you…').slice(0, 80))
    }
  }, [baseWhisper])

  useEffect(() => {
    if (!open) {
      // Keep the default whisper in sync with theme changes.
      setWhisper(baseWhisper)
      return
    }

    // Always show the theme-appropriate whisper immediately.
    setWhisper(baseWhisper)

    // Optionally override with a server-provided whisper.
    if (fetchFromApi) fetchWhisper()
  }, [open, fetchWhisper, fetchFromApi, baseWhisper])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation()
        setOpen((v) => !v)
        // keep typing without needing another click
        setTimeout(() => {
          try {
            document.querySelector('.xterm-helper-textarea')?.focus()
          } catch {
            // ignore
          }
        }, 0)
      }}
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        cursor: 'pointer',
        zIndex: 12,
        opacity,
        transition: 'all 0.35s ease',
        transform: open ? 'scale(1.15)' : toastActive ? 'scale(1.1)' : 'scale(1)',
        filter: open || toastActive ? `drop-shadow(0 0 10px ${AMBER[400]}70)` : 'none',
        userSelect: 'none',
      }}
      title={title || 'the stout knows…'}
    >
      <InlineSvgIcon svgRaw={svgRaw} size={18} />

      {toastActive && (
        <div
          key={toastId}
          className="egg-toast-anim"
          style={{
            position: 'absolute',
            bottom: 24,
            right: 0,
            whiteSpace: 'nowrap',
            fontSize: 9,
            color: AMBER[400],
            textShadow: `0 0 8px ${AMBER[400]}40`,
            padding: '3px 7px',
            borderRadius: 999,
            background: `${SLATE.surface}dd`,
            border: `1px solid ${AMBER[900]}55`,
            pointerEvents: 'none',
            animation: `eggToastFade ${toastMs}ms ease-in-out forwards`,
            willChange: 'opacity, transform',
          }}
        >
          {toastText}
        </div>
      )}

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: toastActive ? 42 : 24,
            right: 0,
            whiteSpace: 'nowrap',
            fontSize: 9,
            color: AMBER[400],
            textShadow: `0 0 8px ${AMBER[400]}40`,
          }}
        >
          {whisper}
        </div>
      )}
    </div>
  )
}

const PeekDrawer = ({ loading, error, context, hit, onClose, onOpenSession }) => {
  const title = context?.session_title || hit?.session_title || hit?.session_id || 'peek'
  const sid = context?.session_id || hit?.session_id
  const model = formatModelLabel(context?.session_model || hit?.session_model)
  const messages = context?.messages || []

  return (
    <div
      style={{
        width: 460,
        flexShrink: 0,
        borderLeft: `1px solid ${SLATE.border}`,
        background: `${SLATE.surface}f2`,
        position: 'relative',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          borderBottom: `1px solid ${SLATE.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: `${SLATE.surface}ff`,
        }}
      >
        <div style={{ fontSize: 11, color: AMBER[400], fontWeight: 700 }}>peek</div>
        <div style={{ flex: 1 }} />
        {sid && (
          <div
            onClick={() => onOpenSession?.(sid)}
            style={{
              fontSize: 11,
              color: AMBER[500],
              cursor: 'pointer',
              userSelect: 'none',
            }}
            title="Open session in terminal"
          >
            open
          </div>
        )}
        <div
          onClick={onClose}
          style={{
            fontSize: 11,
            color: SLATE.muted,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          title="Close"
        >
          close
        </div>
      </div>

      <div style={{ padding: '10px 12px', overflow: 'auto', flex: 1 }}>
        <div style={{ fontSize: 12, color: SLATE.textBright, fontWeight: 600, marginBottom: 2 }} title={title}>
          {title}
        </div>
        {sid && (
          <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 10 }}>
            {sid}
            {model ? ` · ${model}` : ''}
          </div>
        )}

        {hit?.snippet && (
          <div style={{ fontSize: 11, color: SLATE.muted, marginBottom: 10 }}>
            <HighlightedSnippet text={hit.snippet} />
          </div>
        )}

        {loading && <div style={{ fontSize: 11, color: SLATE.muted }}>loading…</div>}
        {error && <div style={{ fontSize: 11, color: SLATE.danger }}>{error}</div>}

        {!loading && !error && messages.length === 0 && (
          <div style={{ fontSize: 11, color: SLATE.muted }}>no context</div>
        )}

        {!loading && !error && messages.length > 0 && (
          <div>
            {messages.map((m) => {
              const role = (m.role || '').toLowerCase()
              const isAssistant = role === 'assistant'
              const who = isAssistant ? '⚡ hermes' : '● you'
              const whoColor = isAssistant ? AMBER[500] : SLATE.textBright

              return (
                <div
                  key={m.id}
                  style={{
                    marginBottom: 12,
                    paddingLeft: 10,
                    borderLeft: m.is_target ? `2px solid ${AMBER[400]}` : '2px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: whoColor }}>{who}</span>
                    <span style={{ fontSize: 10, color: SLATE.muted }}>{isoToLocalLabel(m.timestamp_iso)}</span>
                    {m.content_truncated && <span style={{ fontSize: 10, color: AMBER[600] }}>truncated</span>}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: SLATE.text,
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.45,
                    }}
                  >
                    {m.content}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const CollapsiblePanel = ({
  title,
  open: openProp,
  onToggle,
  defaultOpen = false,
  dense = false,
  children,
}) => {
  const [openState, setOpenState] = useState(defaultOpen)
  const controlled = typeof openProp === 'boolean'
  const open = controlled ? openProp : openState

  const headerPad = dense ? '8px 10px' : '10px 12px'
  const bodyPad = dense ? '8px 10px 10px 22px' : '10px 12px 12px 22px'
  const fs = dense ? 11 : 12

  const toggle = () => {
    const next = !open
    if (!controlled) setOpenState(next)
    onToggle?.(next)
  }

  return (
    <div
      style={{
        border: `1px solid ${SLATE.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: SLATE.surface,
      }}
    >
      <div
        onClick={toggle}
        style={{
          padding: headerPad,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          userSelect: 'none',
          color: SLATE.textBright,
          fontSize: fs,
          fontWeight: 600,
          background: open ? SLATE.elevated : 'transparent',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = SLATE.elevated
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? SLATE.elevated : 'transparent'
        }}
      >
        <span style={{ color: open ? AMBER[400] : SLATE.muted }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>{title}</span>
      </div>

      {open && <div style={{ padding: bodyPad }}>{children}</div>}
    </div>
  )
}

const FALLBACK_MODEL_OPTIONS = [
  { value: 'openai/gpt-5.2', label: 'openai/gpt-5.2' },
  { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' },
  { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  { value: 'google/gemini-3-flash-preview', label: 'google/gemini-3-flash-preview' },
  { value: '__custom__', label: 'Custom model' },
]

const SettingsPanel = ({
  onClose,
  locked = false,
  defaultModel,
  onModelSaved,
  onSaved,
  uiPrefs,
  onUiPrefsChange,
}) => {
  const ui = normalizeUiPrefs(uiPrefs)

  const [openPanel, setOpenPanel] = useState(null)
  const togglePanel = (id) => {
    setOpenPanel((cur) => (cur === id ? null : id))
  }

  const initial = (defaultModel || '').trim()
  const [savedModel, setSavedModel] = useState(initial)
  const [draftModel, setDraftModel] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState({ kind: '', text: '' })
  const [forceCustomModel, setForceCustomModel] = useState(false)

  const [keyStatus, setKeyStatus] = useState({ loading: true, keys: {} })
  const [draftKeys, setDraftKeys] = useState({
    OPENROUTER_API_KEY: '',
    FIRECRAWL_API_KEY: '',
    BROWSERBASE_API_KEY: '',
    BROWSERBASE_PROJECT_ID: '',
    GITHUB_TOKEN: '',
  })

  const [agentLoading, setAgentLoading] = useState(true)
  const [agentConfigPath, setAgentConfigPath] = useState('')
  const [agentSaved, setAgentSaved] = useState(null)
  const [agentDraft, setAgentDraft] = useState(null)

  const normalizeAgentSettings = (raw) => {
    const r = raw && typeof raw === 'object' ? raw : {}
    const agent = r.agent && typeof r.agent === 'object' ? r.agent : {}
    const display = r.display && typeof r.display === 'object' ? r.display : {}
    const memory = r.memory && typeof r.memory === 'object' ? r.memory : {}
    const compression = r.compression && typeof r.compression === 'object' ? r.compression : {}
    const terminal = r.terminal && typeof r.terminal === 'object' ? r.terminal : {}

    return {
      agent: {
        max_turns: Math.max(1, Math.min(500, Number(agent.max_turns ?? 60) || 60)),
        verbose: !!agent.verbose,
        reasoning_effort: (agent.reasoning_effort || 'xhigh').toString().trim() || 'xhigh',
      },
      display: {
        compact: !!display.compact,
        tool_progress: (display.tool_progress || 'all').toString().trim() || 'all',
      },
      memory: {
        memory_enabled: memory.memory_enabled === undefined ? true : !!memory.memory_enabled,
        user_profile_enabled: memory.user_profile_enabled === undefined ? true : !!memory.user_profile_enabled,
      },
      compression: {
        enabled: compression.enabled === undefined ? true : !!compression.enabled,
        threshold_pct: Math.max(50, Math.min(99, Number(compression.threshold_pct ?? 85) || 85)),
        summary_model: (compression.summary_model || 'google/gemini-3-flash-preview').toString().trim() ||
          'google/gemini-3-flash-preview',
      },
      terminal: {
        backend: (terminal.backend || 'local').toString().trim() || 'local',
        cwd: (terminal.cwd || '.').toString().trim() || '.',
        timeout: Math.max(1, Math.min(3600, Number(terminal.timeout ?? 60) || 60)),
      },
    }
  }

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (locked) {
        if (!cancelled) {
          setAgentLoading(false)
          setAgentSaved(null)
          setAgentDraft(null)
          setAgentConfigPath('')
        }
        return
      }

      setAgentLoading(true)
      try {
        const r = await fetch('/api/settings/agent')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const normalized = normalizeAgentSettings(data)

        if (!cancelled) {
          setAgentConfigPath((data?.config_path || '').toString())
          setAgentSaved(normalized)
          setAgentDraft(normalized)
          setAgentLoading(false)
        }
      } catch {
        if (!cancelled) {
          setAgentSaved(normalizeAgentSettings({}))
          setAgentDraft(normalizeAgentSettings({}))
          setAgentLoading(false)
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [locked])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (locked) {
        if (!cancelled) setKeyStatus({ loading: false, keys: {} })
        return
      }

      try {
        const r = await fetch('/api/settings/keys')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const keys = data?.keys && typeof data.keys === 'object' ? data.keys : {}
        if (!cancelled) setKeyStatus({ loading: false, keys })
      } catch {
        if (!cancelled) setKeyStatus({ loading: false, keys: {} })
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [locked])

  const modelDirty = (draftModel || '').trim() !== (savedModel || '').trim()
  const keyUpdates = Object.entries(draftKeys).filter(([, v]) => (v || '').toString().trim())
  const agentDirty =
    !!agentSaved && !!agentDraft && JSON.stringify(agentSaved) !== JSON.stringify(agentDraft)

  const dirtyCount = (modelDirty ? 1 : 0) + keyUpdates.length + (agentDirty ? 1 : 0)
  const dirty = dirtyCount > 0

  const attemptClose = useCallback(() => {
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes?')
      if (!ok) return
    }
    onClose?.()
  }, [dirty, onClose])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') attemptClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [attemptClose])

  const doSave = async () => {
    if (locked || saving) return

    const m = (draftModel || '').trim()
    const updates = keyUpdates.map(([k, v]) => [k, (v || '').toString().trim()])

    if (!modelDirty && updates.length === 0 && !agentDirty) return

    if (modelDirty && !m) {
      setStatus({ kind: 'error', text: 'model is required' })
      return
    }

    setSaving(true)
    setStatus({ kind: '', text: '' })

    try {
      if (modelDirty) {
        const r = await fetch('/api/settings/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m }),
        })

        const data = await r.json().catch(() => ({}))
        if (!r.ok) {
          const msg = data?.error || data?.detail || 'save failed'
          setStatus({ kind: 'error', text: String(msg) })
          return
        }

        const newModel = String(data?.model || m).trim()
        setSavedModel(newModel)
        setDraftModel(newModel)
        setStatus({ kind: 'ok', text: 'saved' })
        onModelSaved?.(newModel)
      }

      if (agentDirty && agentDraft) {
        const r = await fetch('/api/settings/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(agentDraft),
        })

        const data = await r.json().catch(() => ({}))
        if (!r.ok) {
          const msg = data?.error || data?.detail || 'save failed'
          setStatus({ kind: 'error', text: String(msg) })
          return
        }

        const normalized = normalizeAgentSettings(data)
        setAgentConfigPath((data?.config_path || '').toString())
        setAgentSaved(normalized)
        setAgentDraft(normalized)
        setStatus({ kind: 'ok', text: 'saved' })
      }

      for (const [k, v] of updates) {
        const r = await fetch('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k, value: v }),
        })

        const data = await r.json().catch(() => ({}))
        if (!r.ok) {
          const msg = data?.error || data?.detail || 'save failed'
          setStatus({ kind: 'error', text: String(msg) })
          return
        }
      }

      if (updates.length) {
        setDraftKeys((prev) => {
          const next = { ...prev }
          for (const [k] of updates) next[k] = ''
          return next
        })

        // best-effort status refresh
        try {
          const r = await fetch('/api/settings/keys')
          const data = await r.json().catch(() => ({}))
          if (r.ok) {
            const keys = data?.keys && typeof data.keys === 'object' ? data.keys : {}
            setKeyStatus({ loading: false, keys })
          }
        } catch {
          // ignore
        }
      }

      setStatus({ kind: 'ok', text: 'saved' })
      onSaved?.()
      onClose?.()
    } catch {
      setStatus({ kind: 'error', text: 'save failed' })
    } finally {
      setSaving(false)
    }
  }

  const [modelOptions, setModelOptions] = useState({ loading: true, items: FALLBACK_MODEL_OPTIONS })

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const r = await fetch('/api/settings/models')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const items = Array.isArray(data?.models) ? data.models : []
        const normalized = items
          .map((m) => ({
            value: String(m?.value || '').trim(),
            label: String(m?.label || m?.value || '').trim(),
          }))
          .filter((m) => m.value && m.label)

        if (!normalized.some((m) => m.value === '__custom__')) {
          normalized.push({ value: '__custom__', label: 'Custom model' })
        }

        if (!cancelled) setModelOptions({ loading: false, items: normalized })
      } catch {
        if (!cancelled) setModelOptions({ loading: false, items: FALLBACK_MODEL_OPTIONS })
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [])

  const draftTrim = (draftModel || '').trim()
  const draftIsKnownModel = modelOptions.items.some((m) => m.value === draftTrim && m.value !== '__custom__')
  const modelSelectValue = forceCustomModel ? '__custom__' : draftIsKnownModel ? draftTrim : '__custom__'

  const statusColor =
    status.kind === 'error' ? SLATE.danger : status.kind === 'ok' ? SLATE.success : SLATE.muted

  const canSave = !locked && !saving && dirty

  const isKeySet = (name) => !!keyStatus.keys?.[name]?.set

  const setDraftKey = (name, value) => {
    setDraftKeys((prev) => ({ ...prev, [name]: value }))
    setStatus({ kind: '', text: '' })
  }

  return (
    <div
      onClick={attemptClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          borderLeft: `1px solid ${SLATE.border}`,
          background: `${SLATE.surface}f8`,
          padding: 16,
          boxShadow: `0 0 30px ${AMBER[900]}55`,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SettingsIcon size={18} />
          <div style={{ color: AMBER[400], fontWeight: 700, fontSize: 12 }}>{`settings${dirty ? ' *' : ''}`}</div>
          <div style={{ flex: 1 }} />
          <div
            onClick={attemptClose}
            style={{ fontSize: 11, color: SLATE.muted, cursor: 'pointer', userSelect: 'none' }}
            title="Close (Esc)"
          >
            close
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CollapsiblePanel
            title="Model"
            open={openPanel === 'model'}
            onToggle={() => togglePanel('model')}
          >
            <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
              This writes Hermes’ default model via <span style={{ color: AMBER[500] }}>hermes config set</span>. Only
              affects <span style={{ color: AMBER[400] }}>new sessions</span>.
            </div>

            <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ color: SLATE.muted }}>saved:</div>
                <div style={{ color: AMBER[500] }}>{savedModel || '—'}</div>
              </div>
            </div>

            <select
              value={modelSelectValue}
              onChange={(e) => {
                const v = e.target.value
                if (locked) return

                if (v === '__custom__') {
                  setForceCustomModel(true)
                } else {
                  setForceCustomModel(false)
                  if (v) setDraftModel(v)
                }

                setStatus({ kind: '', text: '' })
              }}
              disabled={locked}
              style={{
                width: '100%',
                background: SLATE.elevated,
                border: `1px solid ${SLATE.border}`,
                color: SLATE.textBright,
                padding: '10px 10px',
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 12,
                outline: 'none',
                borderRadius: 8,
                opacity: locked ? 0.5 : 1,
              }}
              title="Default model (new sessions)"
            >
              {modelOptions.items.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>

            {modelSelectValue === '__custom__' && (
              <input
                value={draftModel}
                onChange={(e) => {
                  setForceCustomModel(true)
                  setDraftModel(e.target.value)
                  setStatus({ kind: '', text: '' })
                }}
                placeholder={savedModel || 'provider/model'}
                disabled={locked}
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                  borderRadius: 8,
                  marginTop: 10,
                  opacity: locked ? 0.5 : 1,
                }}
                title="Custom model"
              />
            )}

            {modelOptions.loading && (
              <div style={{ marginTop: 10, fontSize: 10, color: SLATE.muted }}>loading model list…</div>
            )}

          </CollapsiblePanel>

          <CollapsiblePanel
            title="API-Keys"
            open={openPanel === 'keys'}
            onToggle={() => togglePanel('keys')}
          >
            <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
              Keys are written to <span style={{ color: AMBER[500] }}>~/.hermes/.env</span> via{' '}
              <span style={{ color: AMBER[500] }}>hermes config set</span>. Leave fields blank to keep existing values.
              Changes apply to <span style={{ color: AMBER[400] }}>new sessions</span>.
            </div>

            {keyStatus.loading && (
              <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 10 }}>loading key status…</div>
            )}

            <div style={{ fontSize: 10, color: SLATE.muted, letterSpacing: 0.9, textTransform: 'uppercase' }}>
              Model Provider
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>OpenRouter API Key</div>
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    fontSize: 10,
                    color: isKeySet('OPENROUTER_API_KEY') ? SLATE.success : SLATE.muted,
                  }}
                >
                  {isKeySet('OPENROUTER_API_KEY') ? '● set' : '○ not set'}
                </div>
              </div>
              <input
                type="password"
                value={draftKeys.OPENROUTER_API_KEY}
                onChange={(e) => {
                  if (locked) return
                  setDraftKey('OPENROUTER_API_KEY', e.target.value)
                }}
                placeholder={isKeySet('OPENROUTER_API_KEY') ? 'update key… (leave blank to keep)' : 'sk-or-…'}
                disabled={locked}
                autoComplete="new-password"
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                  borderRadius: 8,
                  opacity: locked ? 0.5 : 1,
                }}
              />
            </div>

            <div
              style={{
                marginTop: 14,
                fontSize: 10,
                color: SLATE.muted,
                letterSpacing: 0.9,
                textTransform: 'uppercase',
              }}
            >
              Tools
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>
                  Web Search & Scraping (Firecrawl)
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 10, color: isKeySet('FIRECRAWL_API_KEY') ? SLATE.success : SLATE.muted }}>
                  {isKeySet('FIRECRAWL_API_KEY') ? '● set' : '○ not set'}
                </div>
              </div>
              <input
                type="password"
                value={draftKeys.FIRECRAWL_API_KEY}
                onChange={(e) => {
                  if (locked) return
                  setDraftKey('FIRECRAWL_API_KEY', e.target.value)
                }}
                placeholder={isKeySet('FIRECRAWL_API_KEY') ? 'update key… (leave blank to keep)' : 'fc-…'}
                disabled={locked}
                autoComplete="new-password"
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                  borderRadius: 8,
                  opacity: locked ? 0.5 : 1,
                }}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>
                  Browser Automation (Browserbase)
                </div>
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    fontSize: 10,
                    color:
                      isKeySet('BROWSERBASE_API_KEY') && isKeySet('BROWSERBASE_PROJECT_ID')
                        ? SLATE.success
                        : isKeySet('BROWSERBASE_API_KEY') || isKeySet('BROWSERBASE_PROJECT_ID')
                          ? AMBER[500]
                          : SLATE.muted,
                  }}
                >
                  {isKeySet('BROWSERBASE_API_KEY') && isKeySet('BROWSERBASE_PROJECT_ID')
                    ? '● set'
                    : isKeySet('BROWSERBASE_API_KEY') || isKeySet('BROWSERBASE_PROJECT_ID')
                      ? '◐ partial'
                      : '○ not set'}
                </div>
              </div>

              <input
                type="password"
                value={draftKeys.BROWSERBASE_API_KEY}
                onChange={(e) => {
                  if (locked) return
                  setDraftKey('BROWSERBASE_API_KEY', e.target.value)
                }}
                placeholder={isKeySet('BROWSERBASE_API_KEY') ? 'Browserbase API key… (leave blank to keep)' : 'Browserbase API key…'}
                disabled={locked}
                autoComplete="new-password"
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                  borderRadius: 8,
                  opacity: locked ? 0.5 : 1,
                }}
              />

              <input
                type="text"
                value={draftKeys.BROWSERBASE_PROJECT_ID}
                onChange={(e) => {
                  if (locked) return
                  setDraftKey('BROWSERBASE_PROJECT_ID', e.target.value)
                }}
                placeholder={
                  isKeySet('BROWSERBASE_PROJECT_ID') ? 'Browserbase project id… (leave blank to keep)' : 'Browserbase project id…'
                }
                disabled={locked}
                autoComplete="off"
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                  borderRadius: 8,
                  marginTop: 8,
                  opacity: locked ? 0.5 : 1,
                }}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Skills Hub (GitHub Token)</div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 10, color: isKeySet('GITHUB_TOKEN') ? SLATE.success : SLATE.muted }}>
                  {isKeySet('GITHUB_TOKEN') ? '● set' : '○ not set'}
                </div>
              </div>
              <input
                type="password"
                value={draftKeys.GITHUB_TOKEN}
                onChange={(e) => {
                  if (locked) return
                  setDraftKey('GITHUB_TOKEN', e.target.value)
                }}
                placeholder={isKeySet('GITHUB_TOKEN') ? 'update token… (leave blank to keep)' : 'ghp_…'}
                disabled={locked}
                autoComplete="new-password"
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                  borderRadius: 8,
                  opacity: locked ? 0.5 : 1,
                }}
              />
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Hermes-Agent"
            open={openPanel === 'agent'}
            onToggle={() => togglePanel('agent')}
          >
            <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
              These settings write to <span style={{ color: AMBER[500] }}>~/.hermes/config.yaml</span> via{' '}
              <span style={{ color: AMBER[500] }}>hermes config set</span>. They usually affect{' '}
              <span style={{ color: AMBER[400] }}>new sessions</span>.
            </div>

            {agentConfigPath && (
              <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 10, wordBreak: 'break-all' }}>
                config: {agentConfigPath}
              </div>
            )}

            {agentLoading && <div style={{ fontSize: 10, color: SLATE.muted }}>loading agent settings…</div>}

            {!agentLoading && !agentDraft && (
              <div style={{ fontSize: 10, color: SLATE.muted }}>agent settings unavailable</div>
            )}

            {!agentLoading && agentDraft && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Max turns</div>
                  <div style={{ flex: 1 }} />
                  <input
                    type="number"
                    value={agentDraft.agent.max_turns}
                    min={1}
                    max={500}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      const v = Math.max(1, Math.min(500, Number(e.target.value) || 1))
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, agent: { ...prev.agent, max_turns: v } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{
                      width: 90,
                      background: SLATE.elevated,
                      border: `1px solid ${SLATE.border}`,
                      color: SLATE.textBright,
                      padding: '6px 8px',
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: 11,
                      outline: 'none',
                      borderRadius: 8,
                      opacity: locked ? 0.5 : 1,
                      textAlign: 'right',
                    }}
                    title="Maximum tool-calling iterations"
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Reasoning effort</div>
                  <div style={{ flex: 1 }} />
                  <select
                    value={(agentDraft.agent.reasoning_effort || 'xhigh').toString().toLowerCase()}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      const v = (e.target.value || 'xhigh').toString().toLowerCase()
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, agent: { ...prev.agent, reasoning_effort: v } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{
                      background: SLATE.elevated,
                      border: `1px solid ${SLATE.border}`,
                      color: SLATE.textBright,
                      padding: '6px 8px',
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: 11,
                      outline: 'none',
                      borderRadius: 8,
                      opacity: locked ? 0.5 : 1,
                    }}
                    title="OpenRouter reasoning effort"
                  >
                    <option value="xhigh">xhigh</option>
                    <option value="high">high</option>
                    <option value="medium">medium</option>
                    <option value="low">low</option>
                    <option value="minimal">minimal</option>
                    <option value="none">none</option>
                  </select>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Verbose</div>
                  <div style={{ flex: 1 }} />
                  <input
                    type="checkbox"
                    checked={!!agentDraft.agent.verbose}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, agent: { ...prev.agent, verbose: e.target.checked } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{ accentColor: AMBER[400], opacity: locked ? 0.5 : 1 }}
                  />
                </div>

                <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Compact output</div>
                  <div style={{ flex: 1 }} />
                  <input
                    type="checkbox"
                    checked={!!agentDraft.display.compact}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, display: { ...prev.display, compact: e.target.checked } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{ accentColor: AMBER[400], opacity: locked ? 0.5 : 1 }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Tool progress</div>
                  <div style={{ flex: 1 }} />
                  <select
                    value={(agentDraft.display.tool_progress || 'all').toString().toLowerCase()}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      const v = (e.target.value || 'all').toString().toLowerCase()
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, display: { ...prev.display, tool_progress: v } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{
                      background: SLATE.elevated,
                      border: `1px solid ${SLATE.border}`,
                      color: SLATE.textBright,
                      padding: '6px 8px',
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: 11,
                      outline: 'none',
                      borderRadius: 8,
                      opacity: locked ? 0.5 : 1,
                    }}
                    title="Rich tool progress output"
                  >
                    <option value="off">off</option>
                    <option value="new">new</option>
                    <option value="all">all</option>
                    <option value="verbose">verbose</option>
                  </select>
                </div>

                <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

                <div
                  style={{
                    fontSize: 10,
                    color: SLATE.muted,
                    letterSpacing: 0.9,
                    textTransform: 'uppercase',
                    marginBottom: 8,
                  }}
                >
                  Memory
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enable memory</div>
                  <div style={{ flex: 1 }} />
                  <input
                    type="checkbox"
                    checked={!!agentDraft.memory.memory_enabled}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, memory: { ...prev.memory, memory_enabled: e.target.checked } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{ accentColor: AMBER[400], opacity: locked ? 0.5 : 1 }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enable user profile</div>
                  <div style={{ flex: 1 }} />
                  <input
                    type="checkbox"
                    checked={!!agentDraft.memory.user_profile_enabled}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, memory: { ...prev.memory, user_profile_enabled: e.target.checked } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{ accentColor: AMBER[400], opacity: locked ? 0.5 : 1 }}
                  />
                </div>

                <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

                <div
                  style={{
                    fontSize: 10,
                    color: SLATE.muted,
                    letterSpacing: 0.9,
                    textTransform: 'uppercase',
                    marginBottom: 8,
                  }}
                >
                  Context compression
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enabled</div>
                  <div style={{ flex: 1 }} />
                  <input
                    type="checkbox"
                    checked={!!agentDraft.compression.enabled}
                    disabled={locked || saving}
                    onChange={(e) => {
                      if (locked) return
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, compression: { ...prev.compression, enabled: e.target.checked } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{ accentColor: AMBER[400], opacity: locked ? 0.5 : 1 }}
                  />
                </div>

                <div
                  style={{
                    marginTop: 10,
                    opacity: agentDraft.compression.enabled ? 1 : 0.4,
                    pointerEvents: agentDraft.compression.enabled ? 'auto' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Threshold</div>
                    <div style={{ flex: 1 }} />
                    <div style={{ fontSize: 11, color: AMBER[500] }}>{agentDraft.compression.threshold_pct}%</div>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={99}
                    step={1}
                    value={agentDraft.compression.threshold_pct}
                    onChange={(e) => {
                      if (locked) return
                      const v = Math.max(50, Math.min(99, Number(e.target.value) || 85))
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, compression: { ...prev.compression, threshold_pct: v } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    style={{ width: '100%' }}
                  />

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600, marginBottom: 6 }}>
                      Summary model
                    </div>
                    <input
                      value={agentDraft.compression.summary_model}
                      onChange={(e) => {
                        if (locked) return
                        const v = e.target.value
                        setAgentDraft((prev) => {
                          if (!prev) return prev
                          return { ...prev, compression: { ...prev.compression, summary_model: v } }
                        })
                        setStatus({ kind: '', text: '' })
                      }}
                      placeholder="google/gemini-3-flash-preview"
                      disabled={locked || saving}
                      style={{
                        width: '100%',
                        background: SLATE.elevated,
                        border: `1px solid ${SLATE.border}`,
                        color: SLATE.textBright,
                        padding: '10px 10px',
                        fontFamily: "'JetBrains Mono',monospace",
                        fontSize: 12,
                        outline: 'none',
                        borderRadius: 8,
                        opacity: locked ? 0.5 : 1,
                      }}
                    />
                  </div>
                </div>

                <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

                <div
                  style={{
                    fontSize: 10,
                    color: SLATE.muted,
                    letterSpacing: 0.9,
                    textTransform: 'uppercase',
                    marginBottom: 8,
                  }}
                >
                  Terminal tool
                </div>

                <div>
                  <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600, marginBottom: 6 }}>
                    Working dir
                  </div>
                  <input
                    value={agentDraft.terminal.cwd}
                    onChange={(e) => {
                      if (locked) return
                      const v = e.target.value
                      setAgentDraft((prev) => {
                        if (!prev) return prev
                        return { ...prev, terminal: { ...prev.terminal, cwd: v } }
                      })
                      setStatus({ kind: '', text: '' })
                    }}
                    placeholder="."
                    disabled={locked || saving}
                    style={{
                      width: '100%',
                      background: SLATE.elevated,
                      border: `1px solid ${SLATE.border}`,
                      color: SLATE.textBright,
                      padding: '10px 10px',
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: 12,
                      outline: 'none',
                      borderRadius: 8,
                      opacity: locked ? 0.5 : 1,
                    }}
                  />

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Timeout (s)</div>
                    <div style={{ flex: 1 }} />
                    <input
                      type="number"
                      value={agentDraft.terminal.timeout}
                      min={1}
                      max={3600}
                      disabled={locked || saving}
                      onChange={(e) => {
                        if (locked) return
                        const v = Math.max(1, Math.min(3600, Number(e.target.value) || 1))
                        setAgentDraft((prev) => {
                          if (!prev) return prev
                          return { ...prev, terminal: { ...prev.terminal, timeout: v } }
                        })
                        setStatus({ kind: '', text: '' })
                      }}
                      style={{
                        width: 110,
                        background: SLATE.elevated,
                        border: `1px solid ${SLATE.border}`,
                        color: SLATE.textBright,
                        padding: '6px 8px',
                        fontFamily: "'JetBrains Mono',monospace",
                        fontSize: 11,
                        outline: 'none',
                        borderRadius: 8,
                        opacity: locked ? 0.5 : 1,
                        textAlign: 'right',
                      }}
                    />
                  </div>

                  <div style={{ marginTop: 8, fontSize: 10, color: SLATE.muted }}>
                    backend: <span style={{ color: AMBER[500] }}>{agentDraft.terminal.backend}</span>
                  </div>
                </div>
              </>
            )}
          </CollapsiblePanel>

          <CollapsiblePanel
            title="UI"
            open={openPanel === 'ui'}
            onToggle={() => togglePanel('ui')}
          >
            <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
              UI preferences are stored in this browser (localStorage) and apply instantly.
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>App name</div>
              <div style={{ flex: 1 }} />
              <input
                type="text"
                value={ui.appName}
                placeholder={DEFAULT_UI_PREFS.appName}
                maxLength={64}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    appName: e.target.value,
                  }))
                }}
                style={{
                  width: 220,
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '6px 8px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11,
                  outline: 'none',
                  borderRadius: 8,
                }}
              />
            </div>

            <div style={{ marginTop: 6, fontSize: 10, color: SLATE.muted, lineHeight: 1.4 }}>
              Shown in the sidebar header and browser tab title. Leave empty to use{' '}
              <span style={{ color: AMBER[500] }}>{DEFAULT_UI_PREFS.appName}</span>.
            </div>

            <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Theme</div>
              <div style={{ flex: 1 }} />
              <select
                value={ui.theme}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    theme: e.target.value,
                  }))
                }}
                style={{
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '6px 8px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11,
                  outline: 'none',
                  borderRadius: 8,
                }}
                title="UI theme"
              >
                {THEME_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Background effect</div>
              <div style={{ flex: 1 }} />
              <input
                type="checkbox"
                checked={!!ui.particles.enabled}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    particles: { ...prev.particles, enabled: e.target.checked },
                  }))
                }}
                style={{ accentColor: AMBER[400] }}
              />
            </div>

            <div
              style={{
                marginTop: 10,
                opacity: ui.particles.enabled ? 1 : 0.4,
                pointerEvents: ui.particles.enabled ? 'auto' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Intensity</div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 11, color: AMBER[500] }}>{ui.particles.intensity}%</div>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                step={1}
                value={ui.particles.intensity}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    particles: { ...prev.particles, intensity: Number(e.target.value) },
                  }))
                }}
                style={{ width: '100%' }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 10,
                opacity: ui.particles.enabled ? 1 : 0.4,
                pointerEvents: ui.particles.enabled ? 'auto' : 'none',
              }}
            >
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Effect</div>
              <div style={{ flex: 1 }} />
              <select
                value={ui.background?.effect || 'auto'}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    background: { ...(prev.background || {}), effect: e.target.value },
                  }))
                }}
                style={{
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '6px 8px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11,
                  outline: 'none',
                  borderRadius: 8,
                }}
                title="Background effect"
              >
                <option value="auto">theme default</option>
                <option value="particles">particles</option>
                <option value="matrix-rain">matrix rain</option>
                <option value="nous-crt">nous crt</option>
                <option value="samaritan">samaritan</option>
              </select>
            </div>

            <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Show timestamps</div>
              <div style={{ flex: 1 }} />
              <input
                type="checkbox"
                checked={!!ui.timestamps.enabled}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    timestamps: { ...prev.timestamps, enabled: e.target.checked },
                  }))
                }}
                style={{ accentColor: AMBER[400] }}
              />
            </div>

            <div
              style={{
                marginTop: 12,
                fontSize: 10,
                color: SLATE.muted,
                letterSpacing: 0.9,
                textTransform: 'uppercase',
              }}
            >
              Terminal
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Cursor style</div>
                <div style={{ flex: 1 }} />
                <select
                  value={ui.terminal.cursorStyle}
                  onChange={(e) => {
                    onUiPrefsChange?.((prev) => ({
                      ...prev,
                      terminal: { ...prev.terminal, cursorStyle: e.target.value },
                    }))
                  }}
                  style={{
                    background: SLATE.elevated,
                    border: `1px solid ${SLATE.border}`,
                    color: SLATE.textBright,
                    padding: '6px 8px',
                    fontFamily: "'JetBrains Mono',monospace",
                    fontSize: 11,
                    outline: 'none',
                    borderRadius: 8,
                  }}
                  title="xterm cursor style"
                >
                  <option value="bar">bar</option>
                  <option value="block">block</option>
                  <option value="underline">underline</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Cursor blink</div>
                <div style={{ flex: 1 }} />
                <input
                  type="checkbox"
                  checked={!!ui.terminal.cursorBlink}
                  onChange={(e) => {
                    onUiPrefsChange?.((prev) => ({
                      ...prev,
                      terminal: { ...prev.terminal, cursorBlink: e.target.checked },
                    }))
                  }}
                  style={{ accentColor: AMBER[400] }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <div
                onClick={() => onUiPrefsChange?.(DEFAULT_UI_PREFS)}
                style={{
                  padding: '8px 10px',
                  border: `1px solid ${SLATE.border}`,
                  background: SLATE.elevated,
                  color: SLATE.muted,
                  cursor: 'pointer',
                  fontSize: 11,
                  borderRadius: 8,
                  userSelect: 'none',
                }}
                title="Reset UI settings"
              >
                reset UI
              </div>
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Video FX (recording)"
            open={openPanel === 'videoFx'}
            onToggle={() => togglePanel('videoFx')}
          >
            <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
              Extra CRT/glitch post-processing that sits on top of the <span style={{ color: AMBER[500] }}>whole interface</span>.
              Stored locally in your browser (useful for OBS browser sources).
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enable</div>
              <div style={{ flex: 1 }} />
              <input
                type="checkbox"
                checked={!!ui.videoFx.enabled}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    videoFx: { ...(prev.videoFx || {}), enabled: e.target.checked },
                  }))
                }}
                style={{ accentColor: AMBER[400] }}
              />
            </div>

            <div
              style={{
                marginTop: 10,
                opacity: ui.videoFx.enabled ? 1 : 0.45,
                pointerEvents: ui.videoFx.enabled ? 'auto' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Intensity</div>
                <div style={{ flex: 1 }} />
                <div style={{ fontSize: 11, color: AMBER[500] }}>{ui.videoFx.intensity}%</div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={ui.videoFx.intensity}
                onChange={(e) => {
                  onUiPrefsChange?.((prev) => ({
                    ...prev,
                    videoFx: { ...(prev.videoFx || {}), intensity: Number(e.target.value) },
                  }))
                }}
                style={{ width: '100%' }}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Glitch pulses</div>
                <div style={{ flex: 1 }} />
                <input
                  type="checkbox"
                  checked={!!ui.videoFx.glitchPulses}
                  onChange={(e) => {
                    onUiPrefsChange?.((prev) => ({
                      ...prev,
                      videoFx: { ...(prev.videoFx || {}), glitchPulses: e.target.checked },
                    }))
                  }}
                  style={{ accentColor: AMBER[400] }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <div
                  onClick={() =>
                    onUiPrefsChange?.((prev) => ({
                      ...prev,
                      videoFx: { ...DEFAULT_UI_PREFS.videoFx },
                    }))
                  }
                  style={{
                    padding: '8px 10px',
                    border: `1px solid ${SLATE.border}`,
                    background: SLATE.elevated,
                    color: SLATE.muted,
                    cursor: 'pointer',
                    fontSize: 11,
                    borderRadius: 8,
                    userSelect: 'none',
                  }}
                  title="Reset Video FX settings"
                >
                  reset video fx
                </div>
              </div>
            </div>
          </CollapsiblePanel>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: statusColor }}>
              {locked
                ? 'login required'
                : saving
                  ? 'saving…'
                  : status.text || (dirty ? 'unsaved changes' : 'saved')}
            </div>
            <div style={{ flex: 1 }} />
            <div
              onClick={doSave}
              style={{
                padding: '9px 12px',
                border: `1px solid ${canSave ? AMBER[700] : SLATE.border}`,
                background: canSave ? `${AMBER[900]}55` : SLATE.elevated,
                color: canSave ? AMBER[400] : SLATE.muted,
                cursor: canSave ? 'pointer' : 'default',
                fontSize: 12,
                userSelect: 'none',
                borderRadius: 8,
                opacity: canSave ? 1 : 0.5,
              }}
              title={dirty ? 'Save settings' : 'No changes'}
            >
              save{dirtyCount ? ` (${dirtyCount})` : ''}
            </div>
          </div>

          <div style={{ fontSize: 10, color: SLATE.muted, textAlign: 'right' }}>
            hermelinChat Version: {HERMELINCHAT_VERSION}
          </div>
        </div>
      </div>
    </div>
  )
}


function buildWsUrl(resumeId, opts = {}) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams()

  if (resumeId) params.set('resume', resumeId)

  const cols = Number(opts?.cols || 0)
  const rows = Number(opts?.rows || 0)
  if (cols > 0) params.set('cols', String(cols))
  if (rows > 0) params.set('rows', String(rows))

  const themeId = String(opts?.themeId || '').trim()
  if (themeId) params.set('ui_theme', themeId)

  const q = params.toString()
  return `${proto}://${window.location.host}/ws/pty${q ? `?${q}` : ''}`
}

// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = new RegExp('\\u001b\\[[0-9;]*[a-zA-Z]', 'g')
// eslint-disable-next-line no-control-regex
const ANSI_OSC_RE = new RegExp('\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)', 'g')

function stripAnsi(s) {
  // Best-effort ANSI escape stripping for parsing session IDs from terminal output.
  // (We still render the raw bytes to xterm; this is only for metadata detection.)
  return (s || '').replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '')
}

function TerminalPane({
  resumeId,
  spawnNonce,
  onConnectionChange,
  onSessionId,
  onControlMessage,
  themeId = DEFAULT_THEME_ID,
  cursorStyle = DEFAULT_UI_PREFS.terminal.cursorStyle,
  cursorBlink = DEFAULT_UI_PREFS.terminal.cursorBlink,
}) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)

  const [termReady, setTermReady] = useState(false)

  const themeIdRef = useRef(themeId)
  useEffect(() => {
    themeIdRef.current = themeId
  }, [themeId])

  const onSessionIdRef = useRef(onSessionId)
  useEffect(() => {
    onSessionIdRef.current = onSessionId
  }, [onSessionId])

  const onControlMessageRef = useRef(onControlMessage)
  useEffect(() => {
    onControlMessageRef.current = onControlMessage
  }, [onControlMessage])


  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false

    const start = async () => {
      // Wait for webfonts before opening xterm, otherwise it can measure the grid
      // using fallback font metrics and keep subtly-wrong geometry.
      try {
        if (document?.fonts?.load) {
          await document.fonts.load('13px "JetBrains Mono"')
        }
        if (document?.fonts?.ready) {
          await document.fonts.ready
        }
      } catch {
        // ignore
      }

      if (disposed) return

      const term = new Terminal({
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        lineHeight: 1,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 1,
        scrollback: 10000,
        // PTY already handles newline translation; forcing convertEol can confuse TUIs.
        convertEol: false,
        allowTransparency: true,
        // Needed for term.unicode.* (Unicode11Addon)
        allowProposedApi: true,
        theme: {
          // Transparent terminal so the ParticleField (and grain) can show through.
          // NOTE: allowTransparency must be true for this to work.
          background: 'rgba(0,0,0,0)',
          foreground: SLATE.textBright,
          cursor: AMBER[400],
          selectionBackground: `${AMBER[700]}44`,
        },
      })

      // Windows Terminal-like clipboard shortcuts:
      // - Ctrl/Cmd+C copies selection (when something is selected)
      // - Ctrl/Cmd+V pastes (browser handles paste into xterm textarea)
      const copyTextToClipboard = async (text) => {
        const t = (text || '').toString()
        if (!t) return

        // Async Clipboard API (requires HTTPS or localhost)
        try {
          if (window.isSecureContext && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(t)
            return
          }
        } catch {
          // ignore
        }

        // Fallback for http://<ip>: execCommand('copy')
        try {
          const ta = document.createElement('textarea')
          ta.value = t
          ta.setAttribute('readonly', 'true')
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          ta.style.left = '-9999px'
          ta.style.top = '-9999px'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
        } catch {
          // ignore
        }
      }

      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true

        const key = (ev.key || '').toLowerCase()
        const ctrlOrMeta = ev.ctrlKey || ev.metaKey

        // Ctrl/Cmd+C: copy selection instead of sending ^C
        if (ctrlOrMeta && key === 'c' && term.hasSelection()) {
          ev.preventDefault()
          ev.stopPropagation()
          void copyTextToClipboard(term.getSelection())
          term.clearSelection()
          setTimeout(() => {
            try {
              term.focus()
            } catch {
              // ignore
            }
          }, 0)
          return false
        }

        // Ctrl/Cmd+V: let the browser paste; just don't forward ^V to the PTY.
        if (ctrlOrMeta && key === 'v') {
          return false
        }

        return true
      })

      // Better Unicode width handling (fixes misaligned completions for emoji/symbols).
      try {
        const unicode11 = new Unicode11Addon()
        term.loadAddon(unicode11)
        term.unicode.activeVersion = '11'
      } catch {
        // ignore
      }

      const fit = new FitAddon()
      term.loadAddon(fit)

      term.open(container)
      try {
        fit.fit()
      } catch {
        // ignore
      }

      // Second fit on next frame: gives the browser a beat to settle layout,
      // and helps avoid subtle off-by-one geometry in Firefox.
      requestAnimationFrame(() => {
        if (disposed) return
        try {
          fit.fit()
          term.refresh(0, Math.max(0, term.rows - 1))
        } catch {
          // ignore
        }
      })

      if (disposed) {
        try {
          term.dispose()
        } catch {
          // ignore
        }
        return
      }

      termRef.current = term
      fitRef.current = fit
      setTermReady(true)
    }

    start()

    return () => {
      disposed = true
      try {
        termRef.current?.dispose()
      } catch {
        // ignore
      }
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!termReady) return
    const term = termRef.current
    if (!term) return

    const cs = (cursorStyle || '').toString().toLowerCase()
    const style = CURSOR_STYLE_VALUES.includes(cs) ? cs : DEFAULT_UI_PREFS.terminal.cursorStyle

    try {
      term.options.cursorStyle = style
    } catch {
      // ignore
    }

    try {
      term.options.cursorBlink = !!cursorBlink
    } catch {
      // ignore
    }
  }, [termReady, cursorStyle, cursorBlink])

  useEffect(() => {
    if (!termReady) return
    const term = termRef.current
    if (!term) return

    try {
      term.options.theme = {
        // Keep transparent so the ParticleField (and grain) can show through.
        background: 'rgba(0,0,0,0)',
        foreground: SLATE.textBright,
        cursor: AMBER[400],
        selectionBackground: `${AMBER[700]}44`,
      }
    } catch {
      // ignore
    }
  }, [termReady, themeId])

  useEffect(() => {
    if (!termReady) return
    const term = termRef.current
    const fit = fitRef.current
    const container = containerRef.current
    if (!term || !fit || !container) return

    // Tear down previous WS
    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch {
        // ignore
      }
      wsRef.current = null
    }

    term.reset()
    term.clear()

    // NOTE: xterm is opened only after webfonts are ready (see init effect above),
    // so fit/proposeDimensions should be stable here.
    let cancelled = false
    let ws = null
    let ro = null
    let resizeTimer = null
    let onDataDisposable = null

    const encoder = new TextEncoder()

    // Try to detect the Hermes session ID from the terminal output so the UI can
    // auto-select the correct session in the sidebar/topbar.
    const decoder = new TextDecoder('utf-8')
    let detectTail = ''
    let lastDetectedSid = null

    const maybeDetectSessionId = (text) => {
      const cb = onSessionIdRef.current
      if (!text || !cb) return
      detectTail = (detectTail + text).slice(-6000)
      const clean = stripAnsi(detectTail)
      const m = clean.match(/Session:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]{6})/i)
      const sid = m?.[1] || null
      if (sid && sid !== lastDetectedSid) {
        lastDetectedSid = sid
        cb(sid)
      }
    }

    const sendResize = () => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    // Debounce resize events so dragging the window edge doesn't spam fit() and
    // trigger ResizeObserver loop warnings.
    const scheduleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        sendResize()
      }, 50)
    }

    const start = () => {
      if (cancelled) return

      // IMPORTANT: spawn the backend PTY with the *real* cols/rows from xterm.
      // Otherwise Rich will read the default PTY width (e.g. 120 cols) and render
      // the banner/tools list as if the terminal were wider than the viewport.
      let initialCols = term.cols
      let initialRows = term.rows
      try {
        fit.fit()
        const proposed = fit.proposeDimensions?.()
        if (proposed?.cols) initialCols = proposed.cols
        if (proposed?.rows) initialRows = proposed.rows
      } catch {
        // ignore
      }
      if (cancelled) return

      const wsUrl = buildWsUrl(resumeId, {
        cols: initialCols,
        rows: initialRows,
        themeId: themeIdRef.current,
      })
      ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ro = new ResizeObserver(() => scheduleResize())
      ro.observe(container)
      window.addEventListener('resize', scheduleResize)

      onDataDisposable = term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encoder.encode(data))
        }
      })

      ws.onopen = () => {
        onConnectionChange?.(true)
        // initial fit + resize
        setTimeout(sendResize, 10)
      }

      ws.onclose = () => {
        onConnectionChange?.(false)
      }

      ws.onerror = () => {
        onConnectionChange?.(false)
      }

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(ev.data)
          term.write(u8)
          try {
            maybeDetectSessionId(decoder.decode(u8, { stream: true }))
          } catch {
            // ignore
          }
          return
        }
        if (typeof ev.data === 'string') {
          try {
            const payload = JSON.parse(ev.data)
            const handler = onControlMessageRef.current
            if (payload && typeof payload === 'object' && payload.type && handler?.(payload)) {
              return
            }
          } catch {
            // not a control message
          }
          term.write(ev.data)
          maybeDetectSessionId(ev.data)
        }
      }
    }

    start()

    return () => {
      cancelled = true
      try {
        ro?.disconnect()
      } catch {
        // ignore
      }
      try {
        window.removeEventListener('resize', scheduleResize)
      } catch {
        // ignore
      }
      try {
        if (resizeTimer) clearTimeout(resizeTimer)
      } catch {
        // ignore
      }
      try {
        onDataDisposable?.dispose()
      } catch {
        // ignore
      }
      try {
        ws?.close()
      } catch {
        // ignore
      }

      wsRef.current = null
    }
  }, [termReady, resumeId, spawnNonce, onConnectionChange])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: '12px 12px 36px 12px',
        zIndex: 5,
        boxSizing: 'border-box',
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
        }}
      />
    </div>
  )
}

export default function App() {
  const [sessions, setSessions] = useState([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [uiPrefs, setUiPrefs] = useState(() => {
    const prefs = loadUiPrefs()
    setActiveThemeId(prefs.theme)
    return prefs
  })

  const activeTheme = useMemo(() => {
    const id = normalizeThemeId(uiPrefs.theme)
    return THEMES[id] || THEMES[DEFAULT_THEME_ID]
  }, [uiPrefs.theme])

  const bgEffectPref = uiPrefs.background?.effect || 'auto'
  const themeBgKind = (activeTheme?.background?.kind || 'particles').toString()
  const effectiveBgKind = bgEffectPref === 'auto' ? themeBgKind : bgEffectPref

  const videoFxPrefs = uiPrefs.videoFx || DEFAULT_UI_PREFS.videoFx
  const videoFxIntensity = clampNum(videoFxPrefs.intensity ?? DEFAULT_UI_PREFS.videoFx.intensity, 0, 100)
  const videoFxEnabled = !!videoFxPrefs.enabled && videoFxIntensity > 0
  const videoFxFactor = videoFxEnabled ? videoFxIntensity / 100 : 0
  const videoFxGlitchPulses = videoFxEnabled && !!videoFxPrefs.glitchPulses

  const [videoFxGlitchNow, setVideoFxGlitchNow] = useState(false)
  const [videoFxGlitchSeed, setVideoFxGlitchSeed] = useState(0)

  const appNameLabel = useMemo(() => {
    const s = (uiPrefs.appName || '').toString().trim()
    return s || DEFAULT_UI_PREFS.appName
  }, [uiPrefs.appName])

  useEffect(() => {
    if (typeof document === 'undefined') return

    try {
      const icons = activeTheme?.icons || {}
      const desired =
        Array.isArray(icons.favicons) && icons.favicons.length
          ? icons.favicons
          : [{ rel: 'icon', href: icons.faviconHref || '/favicon.svg' }]

      const entries = desired.filter((e) => e && typeof e === 'object' && e.href)
      if (!entries.length) return

      // Remove any previous theme-managed icons.
      document.querySelectorAll('link[data-hermelin-theme-icon="1"]').forEach((el) => el.remove())

      const applyLink = (el, cfg) => {
        el.setAttribute('data-hermelin-theme-icon', '1')
        el.setAttribute('rel', cfg.rel || 'icon')
        if (cfg.type) el.setAttribute('type', cfg.type)
        else el.removeAttribute('type')
        if (cfg.sizes) el.setAttribute('sizes', cfg.sizes)
        else el.removeAttribute('sizes')
        el.setAttribute('href', cfg.href)
      }

      // Reuse the existing <link rel="icon"> from index.html (first load) if present.
      let base =
        document.querySelector('link[rel="icon"]') ||
        document.querySelector('link[rel="shortcut icon"]') ||
        document.querySelector('link[rel~="icon"]')

      if (!base) {
        base = document.createElement('link')
        document.head.appendChild(base)
      }

      applyLink(base, entries[0])

      for (const cfg of entries.slice(1)) {
        const el = document.createElement('link')
        applyLink(el, cfg)
        document.head.appendChild(el)
      }
    } catch {
      // ignore
    }
  }, [activeTheme])

  useEffect(() => {
    if (typeof document === 'undefined') return
    try {
      document.title = appNameLabel
    } catch {
      // ignore
    }
  }, [appNameLabel])

  const updateUiPrefs = useCallback((updater) => {
    setUiPrefs((prev) => {
      const base = normalizeUiPrefs(prev)
      const nextRaw = typeof updater === 'function' ? updater(base) : updater
      const next = normalizeUiPrefs(nextRaw)
      setActiveThemeId(next.theme)
      return next
    })
  }, [])

  useEffect(() => {
    saveUiPrefs(uiPrefs)
  }, [uiPrefs])

  // Optional "pulse" glitches (brief jitters) used for screen recordings.
  useEffect(() => {
    if (!videoFxGlitchPulses) {
      setVideoFxGlitchNow(false)
      return
    }

    let cancelled = false
    let timer = null
    let offTimer = null

    const schedule = () => {
      if (cancelled) return

      // Higher intensity => slightly more frequent pulses.
      const minDelay = Math.max(650, 2200 - 1200 * videoFxFactor)
      const maxDelay = Math.max(minDelay + 250, 4600 - 2600 * videoFxFactor)
      const delay = minDelay + Math.random() * (maxDelay - minDelay)

      timer = setTimeout(() => {
        if (cancelled) return

        if (offTimer) {
          clearTimeout(offTimer)
          offTimer = null
        }

        setVideoFxGlitchSeed(Math.random() * 10000)
        setVideoFxGlitchNow(true)

        const dur = 60 + Math.random() * (120 + 140 * videoFxFactor)
        offTimer = setTimeout(() => {
          if (!cancelled) setVideoFxGlitchNow(false)
        }, dur)

        schedule()
      }, delay)
    }

    schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (offTimer) clearTimeout(offTimer)
      setVideoFxGlitchNow(false)
    }
  }, [videoFxGlitchPulses, videoFxFactor])


  // Terminal connection mode:
  // - ptyResumeId=null means "start a fresh Hermes session"
  // - ptyResumeId=<id> means "spawn hermes --resume <id>"
  const [ptyResumeId, setPtyResumeId] = useState(null)
  const [ptySpawnNonce, setPtySpawnNonce] = useState(0)

  // What session the UI considers "active" (sidebar highlight + topbar label).
  // For new sessions, we discover this from terminal output / DB after spawn.
  const [activeSessionId, setActiveSessionId] = useState(null)

  const [connected, setConnected] = useState(false)
  const [newSessionStartedAt, setNewSessionStartedAt] = useState(null)

  // When the user explicitly starts a new session, snapshot the current session IDs.
  // This lets us reliably auto-highlight the *new* session once it shows up in /api/sessions,
  // even if session-id detection from terminal output is delayed or missed.
  const newSessionBaselineRef = useRef(null) // Set<string> | null

  // Keep some state in refs so callbacks passed to TerminalPane can stay stable
  // (and not cause a WS reconnect on every render).
  const ptyResumeIdRef = useRef(ptyResumeId)
  useEffect(() => {
    ptyResumeIdRef.current = ptyResumeId
  }, [ptyResumeId])

  const activeSessionIdRef = useRef(activeSessionId)
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
  }, [activeSessionId])

  const handleConnectionChange = useCallback((isUp) => {
    setConnected(isUp)
    if (isUp && ptyResumeIdRef.current === null) {
      setNewSessionStartedAt(Date.now() / 1000)
    }
  }, [])

  const handleDetectedSessionId = useCallback((sid) => {
    if (!sid) return
    if (ptyResumeIdRef.current !== null) return
    if (activeSessionIdRef.current === sid) return
    activeSessionIdRef.current = sid
    setActiveSessionId(sid)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    // keep typing without needing another click
    setTimeout(() => {
      try {
        document.querySelector('.xterm-helper-textarea')?.focus()
      } catch {
        // ignore
      }
    }, 0)
  }, [])

  const [eggToast, setEggToast] = useState(null) // { id, text, ms }
  const eggToastTimerRef = useRef(null)

  const showEggToast = useCallback((text, ms = 2600) => {
    const t = (text || '').toString().trim()
    if (!t) return

    const id =
      globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`

    setEggToast({ id, text: t, ms })

    if (eggToastTimerRef.current) {
      clearTimeout(eggToastTimerRef.current)
      eggToastTimerRef.current = null
    }
    eggToastTimerRef.current = setTimeout(() => {
      setEggToast(null)
      eggToastTimerRef.current = null
    }, ms)
  }, [])

  useEffect(() => {
    return () => {
      if (eggToastTimerRef.current) clearTimeout(eggToastTimerRef.current)
    }
  }, [])

  const [auth, setAuth] = useState({ loading: true, enabled: false, authenticated: false })
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [expandedSearchSessions, setExpandedSearchSessions] = useState({})

  const [peekOpen, setPeekOpen] = useState(false)
  const [peekLoading, setPeekLoading] = useState(false)
  const [peekError, setPeekError] = useState('')
  const [peekContext, setPeekContext] = useState(null)
  const [peekHit, setPeekHit] = useState(null)

  const [artifactTabs, setArtifactTabs] = useState([])
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false)
  const [artifactPanelPinned, setArtifactPanelPinned] = useState(false)
  const [artifactPanelDismissed, setArtifactPanelDismissed] = useState(false)
  const [artifactPanelWidth, setArtifactPanelWidth] = useState(() => loadArtifactPanelWidth())
  const [activeArtifactId, setActiveArtifactId] = useState(null)
  const artifactTabsRef = useRef([])

  useEffect(() => {
    artifactTabsRef.current = artifactTabs
  }, [artifactTabs])

  useEffect(() => {
    const t = setTimeout(() => {
      saveArtifactPanelWidth(artifactPanelWidth)
    }, 150)
    return () => clearTimeout(t)
  }, [artifactPanelWidth])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleResize = () => {
      setArtifactPanelWidth((prev) => clampArtifactPanelWidth(prev))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const [runtimeInfo, setRuntimeInfo] = useState({ loading: true, default_model: null, spawn_cwd: null })

  const refreshAuth = async () => {
    try {
      const r = await fetch('/api/auth/me')
      const data = await r.json()
      setAuth({
        loading: false,
        enabled: !!data.auth_enabled,
        authenticated: !!data.authenticated,
      })
    } catch {
      setAuth({ loading: false, enabled: false, authenticated: false })
    }
  }

  useEffect(() => {
    refreshAuth()
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (!auth.authenticated) {
        if (!cancelled) setRuntimeInfo({ loading: false, default_model: null, spawn_cwd: null })
        return
      }

      try {
        const r = await fetch('/api/info')
        if (r.status === 401) {
          if (!cancelled) setAuth((a) => ({ ...a, authenticated: false }))
          return
        }
        const data = await r.json()
        if (!cancelled) {
          setRuntimeInfo({
            loading: false,
            default_model: data.default_model || null,
            spawn_cwd: data.spawn_cwd || null,
          })
        }
      } catch {
        if (!cancelled) setRuntimeInfo({ loading: false, default_model: null, spawn_cwd: null })
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [auth.authenticated])

  useEffect(() => {
    let cancelled = false
    const q = (searchQuery || '').trim()

    if (!auth.authenticated) {
      setSearchResults([])
      setSearching(false)
      return () => {
        cancelled = true
      }
    }

    if (!q) {
      setSearchResults([])
      setSearching(false)
      return () => {
        cancelled = true
      }
    }

    setSearching(true)
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=25`, { signal: ctrl.signal })
        if (r.status === 401) {
          if (!cancelled) setAuth((a) => ({ ...a, authenticated: false }))
          return
        }
        const data = await r.json()
        if (!cancelled) setSearchResults(data.results || [])
      } catch {
        if (!cancelled) setSearchResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(t)
      try {
        ctrl.abort()
      } catch {
        // ignore
      }
    }
  }, [searchQuery, auth.authenticated])

  useEffect(() => {
    const q = (searchQuery || '').trim()
    if (!q) {
      setExpandedSearchSessions({})
      return
    }

    const sessionIds = Array.from(new Set((searchResults || []).map((r) => r.session_id)))
    setExpandedSearchSessions((prev) => {
      const next = {}
      for (const id of sessionIds) {
        next[id] = prev[id] ?? true
      }
      return next
    })
  }, [searchQuery, searchResults])

  const searchGroups = useMemo(() => {
    const groups = new Map()

    for (const r of searchResults || []) {
      const sid = r.session_id
      if (!sid) continue

      if (!groups.has(sid)) {
        groups.set(sid, {
          session_id: sid,
          title: r.session_title || sid,
          model: formatModelLabel(r.session_model || null),
          hits: [],
        })
      }
      groups.get(sid).hits.push(r)
    }

    const out = Array.from(groups.values())
    for (const g of out) {
      g.hits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    }

    out.sort((a, b) => {
      const at = a.hits[0]?.timestamp || 0
      const bt = b.hits[0]?.timestamp || 0
      return bt - at
    })

    return out
  }, [searchResults])

  const closePeek = () => {
    setPeekOpen(false)
    setPeekLoading(false)
    setPeekError('')
    setPeekContext(null)
    setPeekHit(null)
  }

  const normalizeArtifacts = useCallback((items) => {
    const list = Array.isArray(items) ? items : []
    return list
      .filter((item) => item && typeof item === 'object' && item.id)
      .map((item) => ({ ...item, id: String(item.id), type: String(item.type || 'unknown').toLowerCase() }))
      .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0))
  }, [])

  const applyArtifacts = useCallback(
    (items, options = {}) => {
      const openOnChange = options.openOnChange !== false
      const next = normalizeArtifacts(items)
      const prev = artifactTabsRef.current || []
      const prevById = new Map(prev.map((item) => [item.id, item]))
      const nextById = new Map(next.map((item) => [item.id, item]))

      let hasAddOrUpdate = next.length > 0 && prev.length === 0
      for (const item of next) {
        const prevItem = prevById.get(item.id)
        if (!prevItem || Number(prevItem?.timestamp || 0) !== Number(item?.timestamp || 0)) {
          hasAddOrUpdate = true
          break
        }
      }
      const hasNewIds = next.some((item) => !prevById.has(item.id))

      artifactTabsRef.current = next
      setArtifactTabs(next)
      setActiveArtifactId((current) => {
        if (current && nextById.has(current)) return current
        return next[0]?.id || null
      })

      if (!next.length) {
        // Keep panel state as-is when there are no artifacts.
        //
        // Otherwise, opening the panel manually will immediately collapse again
        // on the next refresh tick (because the artifacts list is still empty).
        return
      }

      if (openOnChange && hasAddOrUpdate && (!artifactPanelDismissed || hasNewIds)) {
        setArtifactPanelDismissed(false)
        setArtifactPanelOpen(true)
        closePeek()
      }
    },
    [artifactPanelDismissed, normalizeArtifacts],
  )

  const refreshArtifacts = useCallback(
    async (options = {}) => {
      if (!auth.authenticated) return
      try {
        const r = await fetch('/api/artifacts')
        if (r.status === 401) {
          setAuth((a) => ({ ...a, authenticated: false }))
          return
        }
        const data = await r.json()
        applyArtifacts(data, options)
      } catch {
        // ignore artifact refresh failures
      }
    },
    [auth.authenticated, applyArtifacts],
  )

  const deleteArtifactTab = useCallback(
    async (artifactId) => {
      if (!artifactId || !auth.authenticated) return
      try {
        await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE' })
      } catch {
        // ignore
      } finally {
        refreshArtifacts({ openOnChange: false })
      }
    },
    [auth.authenticated, refreshArtifacts],
  )

  const handleArtifactControlMessage = useCallback(
    (payload) => {
      if (!payload || typeof payload !== 'object') return false

      if (payload.type === 'artifact') {
        const artifact = payload.payload
        if (!artifact || typeof artifact !== 'object' || !artifact.id) return true
        const current = artifactTabsRef.current || []
        const next = [artifact, ...current.filter((item) => item.id !== artifact.id)]
        applyArtifacts(next, { openOnChange: true })
        return true
      }

      if (payload.type === 'artifact_list' && Array.isArray(payload.payload)) {
        applyArtifacts(payload.payload, { openOnChange: true })
        return true
      }

      if (payload.type === 'artifact_focus') {
        const info = payload.payload || {}
        const id = info.tab_id || info.id || info.artifact_id || null
        if (!id) return true

        setActiveArtifactId(String(id))
        setArtifactPanelDismissed(false)
        setArtifactPanelOpen(true)
        closePeek()
        return true
      }

      if (payload.type === 'artifact_close') {
        const info = payload.payload || {}

        if (info.action === 'close_all') {
          // close_panel() semantics: hide the panel (like the user clicked X)
          // and clear any in-memory tabs.
          applyArtifacts([], { openOnChange: false })
          setArtifactPanelDismissed(true)
          setArtifactPanelOpen(false)
          return true
        }

        const id = info.id || info.tab_id
        if (id) {
          const next = (artifactTabsRef.current || []).filter((item) => item.id !== id)
          applyArtifacts(next, { openOnChange: false })
          return true
        }
      }

      if (payload.type === 'artifact_bridge_command') {
        const command = payload.payload || {}
        const artifactId = command.artifact_id || command.artifactId || command.id || command.tab_id || null

        if (artifactId) {
          setActiveArtifactId(String(artifactId))
          setArtifactPanelDismissed(false)
          setArtifactPanelOpen(true)
          closePeek()
        }

        if (typeof window !== 'undefined') {
          const store = (window.__hermesArtifactBridgeCommands = window.__hermesArtifactBridgeCommands || {})
          const key = artifactId ? String(artifactId) : '__global__'
          const queue = Array.isArray(store[key]) ? store[key] : []
          store[key] = [...queue, command]
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('hermes-artifact-command', { detail: command }))
          }, 30)
        }

        return true
      }

      return false
    },
    [applyArtifacts],
  )

  const closeArtifactPanel = useCallback(() => {
    setArtifactPanelDismissed(true)
    setArtifactPanelOpen(false)
  }, [])

  const startNewSession = () => {
    if (!auth.authenticated) return

    // Snapshot current session IDs so our "new session" auto-select logic won't
    // accidentally re-select a recent previous session.
    newSessionBaselineRef.current = new Set((sessions || []).map((s) => s?.id).filter(Boolean))

    setSearchQuery('')
    ptyResumeIdRef.current = null
    activeSessionIdRef.current = null
    setPtyResumeId(null)
    setActiveSessionId(null)
    setPtySpawnNonce((n) => n + 1)
    setNewSessionStartedAt(Date.now() / 1000)
    closePeek()
  }

  useEffect(() => {
    if (!auth.authenticated) {
      closePeek()
      setArtifactTabs([])
      setActiveArtifactId(null)
      setArtifactPanelDismissed(false)
      setArtifactPanelOpen(false)
    }
  }, [auth.authenticated])

  const openPeek = async (hit) => {
    if (!auth.authenticated) return
    if (!hit?.id) return

    setArtifactPanelOpen(false)
    setPeekOpen(true)
    setPeekHit(hit)
    setPeekLoading(true)
    setPeekError('')
    setPeekContext(null)

    try {
      const r = await fetch(`/api/messages/context?message_id=${encodeURIComponent(hit.id)}&before=3&after=3`)
      if (r.status === 401) {
        setAuth((a) => ({ ...a, authenticated: false }))
        return
      }
      if (!r.ok) {
        setPeekError('not found')
        return
      }
      const data = await r.json()
      setPeekContext(data)
    } catch {
      setPeekError('peek failed')
    } finally {
      setPeekLoading(false)
    }
  }

  const doLogin = async () => {
    setLoginError('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!r.ok) {
        setLoginError('invalid password')
        return
      }
      setPassword('')
      await refreshAuth()
    } catch {
      setLoginError('login failed')
    }
  }

  const doLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      setConnected(false)
      setSearchQuery('')
      setSearchResults([])
      ptyResumeIdRef.current = null
      activeSessionIdRef.current = null
      setPtyResumeId(null)
      setPtySpawnNonce(0)
      setActiveSessionId(null)
      setNewSessionStartedAt(null)
      closePeek()
      setArtifactTabs([])
      setActiveArtifactId(null)
      setArtifactPanelDismissed(false)
      setArtifactPanelOpen(false)
      await refreshAuth()
    }
  }

  useEffect(() => {
    let cancelled = false
    let intervalId = null

    if (!auth.authenticated) {
      return () => {
        cancelled = true
      }
    }

    const tick = async (options = {}) => {
      if (cancelled) return
      await refreshArtifacts(options)
    }

    void tick({ openOnChange: true })
    intervalId = setInterval(() => {
      void tick({ openOnChange: true })
    }, 1500)

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [auth.authenticated, refreshArtifacts])

  useEffect(() => {
    let cancelled = false

    if (!auth.authenticated) {
      setSessions([])
      return () => {
        cancelled = true
      }
    }

    const load = async () => {
      try {
        const r = await fetch('/api/sessions?limit=50')
        if (r.status === 401) {
          if (!cancelled) setAuth((a) => ({ ...a, authenticated: false }))
          return
        }
        const data = await r.json()
        if (!cancelled) setSessions(data.sessions || [])
      } catch {
        if (!cancelled) setSessions([])
      }
    }

    load()
    const t = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [auth.authenticated])

  // Keep the active session in sync when explicitly resuming a session.
  useEffect(() => {
    if (ptyResumeId) setActiveSessionId(ptyResumeId)
  }, [ptyResumeId])

  // Once we know which session we're in, we no longer need the "new session started" timestamp.
  // Also clear any baseline snapshot captured during an explicit "New session" action.
  useEffect(() => {
    if (!activeSessionId) return
    setNewSessionStartedAt(null)
    newSessionBaselineRef.current = null
  }, [activeSessionId])

  const activeSessionMissing = useMemo(() => {
    if (!activeSessionId) return false
    return !sessions.some((s) => s.id === activeSessionId)
  }, [sessions, activeSessionId])

  // If we have an activeSessionId but it hasn't shown up in the sidebar yet,
  // poll quickly for a short time (Hermes may only write state.db after the first message).
  useEffect(() => {
    if (!auth.authenticated) return
    if (!activeSessionId) return
    if (!activeSessionMissing) return

    let cancelled = false
    let tries = 0
    let timer = null

    const tick = async () => {
      tries += 1
      try {
        const r = await fetch('/api/sessions?limit=50')
        if (r.status === 401) {
          if (!cancelled) setAuth((a) => ({ ...a, authenticated: false }))
          if (timer) clearInterval(timer)
          return
        }
        const data = await r.json()
        if (!cancelled) setSessions(data.sessions || [])
        const hasIt = (data.sessions || []).some((s) => s.id === activeSessionId)
        if (hasIt || tries >= 15) {
          if (timer) clearInterval(timer)
        }
      } catch {
        if (tries >= 15) {
          if (timer) clearInterval(timer)
        }
      }
    }

    tick()
    timer = setInterval(tick, 1000)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [auth.authenticated, activeSessionId, activeSessionMissing])

  // Fallback: if we started a new PTY session and haven't detected a session ID yet,
  // poll the DB for a session that started around that time.
  useEffect(() => {
    if (!auth.authenticated) return
    if (!connected) return
    if (ptyResumeId !== null) return
    if (activeSessionId !== null) return
    if (!newSessionStartedAt) return

    let cancelled = false
    let tries = 0
    let timer = null

    const tick = async () => {
      tries += 1
      try {
        const r = await fetch('/api/sessions?limit=50')
        if (r.status === 401) {
          if (!cancelled) setAuth((a) => ({ ...a, authenticated: false }))
          if (timer) clearInterval(timer)
          return
        }
        const data = await r.json()
        const list = data.sessions || []
        if (!cancelled) setSessions(list)

        const baseline = newSessionBaselineRef.current
        const candidate = baseline
          ? list.find((s) => s?.id && !baseline.has(s.id))
          : list.find((s) => (s.started_at || 0) >= newSessionStartedAt - 10)

        if (candidate?.id) {
          activeSessionIdRef.current = candidate.id
          setActiveSessionId(candidate.id)
          if (timer) clearInterval(timer)
          return
        }
      } catch {
        // ignore
      }

      if (tries >= 20) {
        if (timer) clearInterval(timer)
      }
    }

    tick()
    timer = setInterval(tick, 1000)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [auth.authenticated, connected, ptyResumeId, activeSessionId, newSessionStartedAt])

  const grouped = useMemo(() => {
    const out = { Today: [], Yesterday: [], Earlier: [] }
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000

    for (const s of sessions) {
      const ts = (s.started_at || 0) * 1000
      if (ts >= startOfToday) out.Today.push(s)
      else if (ts >= startOfYesterday) out.Yesterday.push(s)
      else out.Earlier.push(s)
    }
    return out
  }, [sessions])

  const activeSession = useMemo(() => {
    if (!activeSessionId) return null
    return sessions.find((s) => s.id === activeSessionId) || null
  }, [sessions, activeSessionId])

  const currentModelRaw = activeSession?.model || runtimeInfo.default_model || null
  const currentModel = formatModelLabel(currentModelRaw)
  const currentCwd = runtimeInfo.spawn_cwd || null

  const locked = !auth.loading && auth.enabled && !auth.authenticated

  const videoFxFilter = useMemo(() => {
    if (!videoFxEnabled || videoFxFactor <= 0) return 'none'

    const f = videoFxFactor
    const contrast = 1 + 0.16 * f + (videoFxGlitchNow ? 0.08 * f : 0)
    const saturate = 1 + 0.22 * f + (videoFxGlitchNow ? 0.14 * f : 0)
    const brightness = 1 + 0.06 * f

    const dx = 0.6 + 1.1 * f
    const a1 = 0.06 + 0.10 * f
    const a2 = 0.05 + 0.08 * f

    let s = `contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)}) brightness(${brightness.toFixed(3)})`
    s += ` drop-shadow(${dx.toFixed(2)}px 0 0 rgba(255,50,120,${a1.toFixed(3)}))`
    s += ` drop-shadow(${(-dx).toFixed(2)}px 0 0 rgba(0,220,255,${a2.toFixed(3)}))`

    if (videoFxGlitchNow) {
      s += ` hue-rotate(${(3 + 7 * f).toFixed(1)}deg)`
    }

    return s
  }, [videoFxEnabled, videoFxFactor, videoFxGlitchNow])

  const videoFxTransform = useMemo(() => {
    if (!videoFxEnabled || videoFxFactor <= 0) return 'none'
    if (!videoFxGlitchNow) return 'translateZ(0)'

    const seed = Number(videoFxGlitchSeed || 0)
    const frac = (x) => x - Math.floor(x)

    const r1 = frac(seed * 1.37 + 0.11)
    const r2 = frac(seed * 2.11 + 0.31)
    const r3 = frac(seed * 3.93 + 0.71)

    const jx = Math.round((r1 - 0.5) * 10 * videoFxFactor)
    const jy = Math.round((r2 - 0.5) * 6 * videoFxFactor)
    const skew = (r3 - 0.5) * 0.9 * videoFxFactor

    return `translate3d(${jx}px, ${jy}px, 0) skewX(${skew}deg)`
  }, [videoFxEnabled, videoFxFactor, videoFxGlitchNow, videoFxGlitchSeed])

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: SLATE.bg,
        position: 'relative',
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        color: SLATE.textBright,
        overflow: 'hidden',
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: ${SLATE.border}; border-radius: 2px }
        ::-webkit-scrollbar-thumb:hover { background: ${SLATE.muted} }
        ::selection { background: ${AMBER[700]}44 }

        /* xterm: make viewport/screen transparent so our ParticleField shows through */
        .xterm, .xterm .xterm-viewport, .xterm .xterm-screen {
          background-color: transparent !important;
        }
        .xterm canvas {
          background-color: transparent !important;
        }
        .xterm .composition-view {
          background: transparent !important;
        }
      `}</style>

      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          filter: videoFxFilter,
          transform: videoFxTransform,
          willChange: videoFxEnabled ? 'filter, transform' : undefined,
        }}
      >

      {/* Sidebar */}
      <div
        style={{
          width: sidebarCollapsed ? 64 : 290,
          flexShrink: 0,
          background: SLATE.surface,
          borderRight: `1px solid ${SLATE.border}`,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          zIndex: 2,
          overflow: 'hidden',
          transition: 'width 0.25s ease',
        }}
      >
        <div
          style={{
            padding: sidebarCollapsed ? '14px 8px 12px' : '14px 14px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
            borderBottom: `1px solid ${SLATE.border}`,
          }}
        >
          {!sidebarCollapsed && (
            <div
              title={appNameLabel}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: SLATE.text,
                opacity: 0.68,
                letterSpacing: '0.02em',
                userSelect: 'none',
                maxWidth: 200,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {appNameLabel}
            </div>
          )}

          {sidebarCollapsed ? (
            <div
              onClick={() => setSidebarCollapsed(false)}
              title="Expand sidebar"
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: SLATE.muted,
                userSelect: 'none',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = AMBER[400])}
              onMouseLeave={(e) => (e.currentTarget.style.color = SLATE.muted)}
            >
              <SidebarDockIcon expand />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                onClick={() => setSettingsOpen(true)}
                title="Settings"
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: SLATE.muted,
                  userSelect: 'none',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = AMBER[400])}
                onMouseLeave={(e) => (e.currentTarget.style.color = SLATE.muted)}
              >
                <SettingsIcon />
              </div>
              <div
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse sidebar"
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: SLATE.muted,
                  userSelect: 'none',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = AMBER[400])}
                onMouseLeave={(e) => (e.currentTarget.style.color = SLATE.muted)}
              >
                <SidebarDockIcon />
              </div>
            </div>
          )}
        </div>

        {sidebarCollapsed && (
          <div
            style={{
              padding: '12px 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              onClick={startNewSession}
              title={auth.authenticated ? 'New session' : 'Login required'}
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: auth.authenticated ? 'pointer' : 'default',
                color: SLATE.muted,
                background: 'transparent',
                border: '1px solid transparent',
                opacity: auth.authenticated ? 1 : 0.35,
                transition: 'all 0.15s ease',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                if (!auth.authenticated) return
                e.currentTarget.style.background = SLATE.elevated
                e.currentTarget.style.borderColor = SLATE.border
                e.currentTarget.style.color = AMBER[400]
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.borderColor = 'transparent'
                e.currentTarget.style.color = SLATE.muted
              }}
            >
              <PlusIcon size={18} />
            </div>

            <div
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: SLATE.muted,
                background: 'transparent',
                border: '1px solid transparent',
                transition: 'all 0.15s ease',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = SLATE.elevated
                e.currentTarget.style.borderColor = SLATE.border
                e.currentTarget.style.color = AMBER[400]
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.borderColor = 'transparent'
                e.currentTarget.style.color = SLATE.muted
              }}
            >
              <SettingsIcon size={18} />
            </div>
          </div>
        )}

        {!sidebarCollapsed && (
          <>
            <div style={{ padding: '10px 10px 6px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 10px',
              borderRadius: 6,
              background: SLATE.elevated,
              border: `1px solid ${SLATE.border}`,
              fontSize: 12,
              color: SLATE.muted,
              opacity: auth.authenticated ? 1 : 0.45,
            }}
          >
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={auth.authenticated ? 'Search messages' : 'Login to search'}
              disabled={!auth.authenticated}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: SLATE.textBright,
                fontSize: 12,
                fontFamily: "'JetBrains Mono',monospace",
              }}
            />
            {searching && <span style={{ color: AMBER[500], fontSize: 11 }}>…</span>}
            {!!searchQuery && auth.authenticated && (
              <span
                onClick={() => setSearchQuery('')}
                style={{
                  cursor: 'pointer',
                  color: SLATE.muted,
                  fontSize: 11,
                  userSelect: 'none',
                }}
                title="Clear"
              >
                clear
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '4px 6px', opacity: auth.authenticated ? 1 : 0.4 }}>
          <div
            style={{
              padding: '10px 8px 4px',
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: SLATE.muted,
            }}
          >
            Active
          </div>
          <SidebarItem
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <PlusIcon size={14} />
                <span>New session</span>
              </span>
            }
            active={activeSessionId === null}
            onClick={startNewSession}
          />

          {auth.authenticated &&
            ((searchQuery || '').trim() ? (
              <div>
                <div
                  style={{
                    padding: '14px 8px 4px',
                    fontSize: 10,
                    fontWeight: 600,

                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: SLATE.muted,
                  }}
                >
                  Search results
                </div>

                {searchResults.length === 0 && !searching && (
                  <div style={{ padding: '8px 12px', fontSize: 11, color: SLATE.muted }}>No results</div>
                )}

                {searchGroups.map((g) => {
                  const isOpen = !!expandedSearchSessions[g.session_id]
                  const top = g.hits[0]

                  return (
                    <div key={g.session_id} style={{ marginBottom: 6 }}>
                      <SessionRow
                        title={`${isOpen ? '▾' : '▸'} ${g.title}`}
                        preview={
                          <span>
                            <span style={{ color: SLATE.muted }}>{g.hits.length} hits</span>
                            {g.model && <span style={{ color: SLATE.muted }}>{` · ${g.model}`}</span>}
                            {top?.snippet && (
                              <>
                                <span style={{ color: SLATE.muted }}> · </span>
                                <HighlightedSnippet text={top.snippet} />
                              </>
                            )}
                          </span>
                        }
                        right={uiPrefs.timestamps.enabled ? isoToTimeLabel(top?.timestamp_iso) : null}
                        active={activeSessionId === g.session_id || peekHit?.session_id === g.session_id}
                        onClick={() =>
                          setExpandedSearchSessions((prev) => ({
                            ...prev,
                            [g.session_id]: !isOpen,
                          }))
                        }
                      />

                      {isOpen && (
                        <div style={{ marginTop: 2 }}>
                          {g.hits.map((hit) => (
                            <SearchHitRow
                              key={hit.id}
                              hit={hit}
                              active={peekHit?.id === hit.id}
                              showTimestamp={uiPrefs.timestamps.enabled}
                              onClick={() => openPeek(hit)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              ['Today', 'Yesterday', 'Earlier'].map((k) => {
                const list = grouped[k]
                if (!list || list.length === 0) return null
                return (
                  <div key={k}>
                    <div
                      style={{
                        padding: '14px 8px 4px',
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        color: SLATE.muted,
                      }}
                    >
                      {k}
                    </div>
                    {list.map((s) => (
                      <SessionRow
                        key={s.id}
                        title={s.title || s.id}
                        right={uiPrefs.timestamps.enabled ? isoToTimeLabel(s.started_at_iso) : null}
                        active={activeSessionId === s.id}
                        onClick={() => {
                          setSearchQuery('')
                          if (ptyResumeId === null && activeSessionId === s.id) {
                            closePeek()
                            return
                          }
                          ptyResumeIdRef.current = s.id
                          activeSessionIdRef.current = s.id
                          setPtyResumeId(s.id)
                          setActiveSessionId(s.id)
                          setNewSessionStartedAt(null)
                          closePeek()
                        }}
                      />
                    ))}
                  </div>
                )
              })
            ))}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderTop: `1px solid ${SLATE.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            justifyContent: 'flex-start',
          }}
        >
          {auth.enabled && auth.authenticated && (
            <div
              onClick={doLogout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: AMBER[500],
                cursor: 'pointer',
                userSelect: 'none',
              }}
              title="Logout"
            >
              <LogoutIcon size={14} />
              logout
            </div>
          )}
        </div>
          </>
        )}

        {sidebarCollapsed && <div style={{ flex: 1 }} />}

        {sidebarCollapsed && (
          <div
            style={{
              padding: '10px 0',
              borderTop: `1px solid ${SLATE.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}
          >
            {auth.enabled && auth.authenticated && (
              <div
                onClick={doLogout}
                title="Logout"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: AMBER[500],
                  background: 'transparent',
                  border: '1px solid transparent',
                  transition: 'all 0.15s ease',
                  userSelect: 'none',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = SLATE.elevated
                  e.currentTarget.style.borderColor = SLATE.border
                  e.currentTarget.style.color = AMBER[400]
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderColor = 'transparent'
                  e.currentTarget.style.color = AMBER[500]
                }}
              >
                <LogoutIcon size={18} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          // Critical for xterm sizing inside flex layouts:
          // allow the main pane to shrink instead of overflowing (which makes
          // FitAddon calculate cols for a wider-than-visible element).
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {uiPrefs.particles.enabled && uiPrefs.particles.intensity > 0 && (
          effectiveBgKind === 'matrix-rain' ? (
            <MatrixRainField intensity={uiPrefs.particles.intensity} config={activeTheme?.background?.matrixRain} />
          ) : effectiveBgKind === 'nous-crt' ? (
            <NousCRTField intensity={uiPrefs.particles.intensity} />
          ) : effectiveBgKind === 'samaritan' ? (
            <SamaritanField intensity={uiPrefs.particles.intensity} />
          ) : (
            <ParticleField intensity={uiPrefs.particles.intensity} />
          )
        )}

        {activeTheme?.background?.overlay?.kind === 'scanlines' ? (
          <ScanlinesOverlay opacity={activeTheme?.background?.overlay?.opacity ?? 0.06} />
        ) : activeTheme?.background?.overlay?.kind === 'grain' ? (
          <GrainOverlay opacity={activeTheme?.background?.overlay?.opacity ?? 0.03} />
        ) : null}

        <div
          style={{
            height: 40,
            flexShrink: 0,
            borderBottom: `1px solid ${SLATE.border}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: 10,
            background: `${SLATE.surface}ee`,
            position: 'relative',
            zIndex: 5,
            backdropFilter: 'blur(8px)',
          }}
        >
          <InlineSvgIcon svgRaw={activeTheme?.icons?.topbarSvgRaw} size={activeTheme?.icons?.topbarSize ?? 18} />
          <span style={{ fontSize: 11, color: SLATE.muted }}>session:</span>
          <span style={{ fontSize: 11, color: SLATE.muted }}>
            {auth.loading
              ? 'auth…'
              : locked
                ? 'login required'
                : activeSessionId
                  ? activeSessionId
                  : 'new session'}
          </span>

          <span style={{ color: SLATE.muted, fontSize: 11 }}>·</span>
          <span style={{ fontSize: 11, color: SLATE.muted }}>model:</span>
          <span style={{ fontSize: 11, color: AMBER[500] }}>
            {runtimeInfo.loading ? '…' : currentModel || '—'}
          </span>

          <span style={{ color: SLATE.muted, fontSize: 11 }}>·</span>
          <span style={{ fontSize: 11, color: SLATE.muted }}>cwd:</span>
          <span
            style={{
              fontSize: 11,
              color: SLATE.muted,
              maxWidth: 520,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={currentCwd || ''}
          >
            {runtimeInfo.loading ? '…' : currentCwd || '—'}
          </span>

          <div style={{ flex: 1 }} />
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: connected ? SLATE.success : SLATE.muted,
              boxShadow: `0 0 6px ${connected ? SLATE.success : SLATE.muted}`,
              transition: 'background 0.3s ease',
            }}
          />
          <span style={{ fontSize: 11, color: SLATE.muted }}>PTY</span>
        </div>

        <div style={{ flex: 1, display: 'flex', position: 'relative', minWidth: 0, minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0 }}>
            {auth.authenticated ? (
              <>
                <TerminalPane
                  resumeId={ptyResumeId}
                  spawnNonce={ptySpawnNonce}
                  themeId={uiPrefs.theme}
                  cursorStyle={uiPrefs.terminal.cursorStyle}
                  cursorBlink={uiPrefs.terminal.cursorBlink}
                  onConnectionChange={handleConnectionChange}
                  onSessionId={handleDetectedSessionId}
                  onControlMessage={handleArtifactControlMessage}
                />
                <AlignmentEasterEgg
                  toast={eggToast}
                  svgRaw={activeTheme?.icons?.alignmentSvgRaw}
                  title={activeTheme?.icons?.alignmentTitle}
                  whisperText={activeTheme?.icons?.alignmentWhisperText}
                  fetchFromApi={activeTheme?.icons?.alignmentFetchWhisper ?? true}
                />
              </>
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 5,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: SLATE.muted,
                  fontSize: 12,
                }}
              >
                {auth.loading ? 'checking auth…' : locked ? 'locked' : 'disconnected'}
              </div>
            )}

            {!artifactPanelOpen && auth.authenticated && (
              <div
                onClick={() => {
                  setArtifactPanelDismissed(false)
                  setArtifactPanelOpen(true)
                  closePeek()
                }}
                title="Open panel"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: SLATE.surface,
                  border: `1px solid ${SLATE.border}`,
                  borderRight: 'none',
                  borderRadius: '8px 0 0 8px',
                  padding: '12px 7px',
                  cursor: 'pointer',
                  color: SLATE.muted,
                  zIndex: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  userSelect: 'none',
                  boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = AMBER[400]
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = SLATE.muted
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span
                  style={{
                    fontSize: 9,
                    writingMode: 'vertical-rl',
                    textOrientation: 'mixed',
                    letterSpacing: '0.04em',
                    userSelect: 'none',
                  }}
                >
                  {`${artifactTabs.length} artifact${artifactTabs.length === 1 ? '' : 's'}`}
                </span>
              </div>
            )}
          </div>

          {artifactPanelOpen ? (
            <ArtifactPanel
              width={artifactPanelWidth}
              onResizeWidth={(nextWidth) => setArtifactPanelWidth(clampArtifactPanelWidth(nextWidth))}
              artifacts={artifactTabs}
              activeArtifactId={activeArtifactId}
              pinned={artifactPanelPinned}
              onSelectArtifact={setActiveArtifactId}
              onClose={closeArtifactPanel}
              onRefresh={() => refreshArtifacts({ openOnChange: false })}
              onTogglePinned={() => setArtifactPanelPinned((value) => !value)}
              onDeleteArtifact={deleteArtifactTab}
            />
          ) : null}

          {!artifactPanelOpen && peekOpen && (
            <PeekDrawer
              loading={peekLoading}
              error={peekError}
              context={peekContext}
              hit={peekHit}
              onClose={closePeek}
              onOpenSession={(sid) => {
                if (!sid) return
                if (ptyResumeId === null && activeSessionId === sid) {
                  closePeek()
                  return
                }
                ptyResumeIdRef.current = sid
                activeSessionIdRef.current = sid
                setPtyResumeId(sid)
                setActiveSessionId(sid)
                setNewSessionStartedAt(null)
                closePeek()
              }}
            />
          )}
        </div>

        {/* Login overlay */}
        {locked && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 50,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(6px)',
            }}
          >
            <div
              style={{
                width: 360,
                border: `1px solid ${SLATE.border}`,
                background: SLATE.surface,
                padding: 16,
                boxShadow: `0 0 30px ${AMBER[900]}55`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <InvertelinSmall size={18} href={activeTheme?.icons?.faviconHref} />
                <div style={{ color: AMBER[400], fontWeight: 700, fontSize: 12 }}>Login required</div>
              </div>

              <div style={{ color: SLATE.muted, fontSize: 11, marginBottom: 12 }}>
                This UI can spawn a real Hermes terminal. Please authenticate.
              </div>

              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doLogin()
                }}
                placeholder="Password"
                autoFocus
                style={{
                  width: '100%',
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '10px 10px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12,
                  outline: 'none',
                }}
              />

              {loginError && <div style={{ color: SLATE.danger, fontSize: 11, marginTop: 8 }}>{loginError}</div>}

              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <div
                  onClick={doLogin}
                  style={{
                    padding: '9px 12px',
                    border: `1px solid ${AMBER[700]}`,
                    background: `${AMBER[900]}55`,
                    color: AMBER[400],
                    cursor: 'pointer',
                    fontSize: 12,
                    userSelect: 'none',
                  }}
                >
                  unlock
                </div>
                <div
                  onClick={refreshAuth}
                  style={{
                    padding: '9px 12px',
                    border: `1px solid ${SLATE.border}`,
                    background: SLATE.elevated,
                    color: SLATE.muted,
                    cursor: 'pointer',
                    fontSize: 12,
                    userSelect: 'none',
                  }}
                >
                  retry
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {settingsOpen && (
        <SettingsPanel
          onClose={closeSettings}
          locked={locked}
          defaultModel={formatModelLabel(runtimeInfo.default_model)}
          onModelSaved={(m) => {
            setRuntimeInfo((prev) => ({
              ...prev,
              loading: false,
              default_model: m || null,
            }))
          }}
          uiPrefs={uiPrefs}
          onUiPrefsChange={updateUiPrefs}
          onSaved={() => showEggToast('settings saved')}
        />
      )}
      </div>

      <VideoFxOverlay
        enabled={videoFxEnabled}
        intensity={videoFxIntensity}
        glitchNow={videoFxGlitchNow}
        glitchSeed={videoFxGlitchSeed}
      />
    </div>
  )
}

