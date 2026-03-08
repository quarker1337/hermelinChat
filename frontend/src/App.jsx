import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import STOUT_MASCOT_RAW from './assets/stout-mascot.svg?raw'
import HERMILIN_NOT_FLIPPED_RAW from './assets/hermilin-not-flipped.svg?raw'
import ArtifactPanel from './components/ArtifactPanel.jsx'

// ─── NOUS / HERMELIN PALETTE ───────────────────────────────────────
const AMBER = {
  300: '#ffd480',
  400: '#f5b731',
  500: '#e0a020',
  600: '#c48a18',
  700: '#9a6c12',
  800: '#6b4a0e',
  900: '#3d2a08',
}

const SLATE = {
  bg: '#08080a',
  surface: '#0e0e12',
  elevated: '#16161d',
  border: '#232330',
  muted: '#55556a',
  text: '#b8b8cc',
  textBright: '#e8e8f0',
  accent: '#f5b731',
  danger: '#e84057',
  success: '#38c878',
}

// ─── UI PREFS (LOCAL) ───────────────────────────────────────────────
// Stored in localStorage and applied instantly (no backend required).
const UI_PREFS_STORAGE_KEY = 'hermilinChat.uiPrefs'

const CURSOR_STYLE_VALUES = ['bar', 'block', 'underline']

// First tagged release of the hermilinChat UI.
const HERMILINCHAT_VERSION = '0.10'

const DEFAULT_UI_PREFS = {
  particles: {
    enabled: true,
    // 50..100 (50 matches the old look)
    intensity: 75,
  },
  timestamps: {
    enabled: true,
  },
  terminal: {
    cursorStyle: 'bar',
    cursorBlink: true,
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
  const ts = r.timestamps && typeof r.timestamps === 'object' ? r.timestamps : {}
  const term = r.terminal && typeof r.terminal === 'object' ? r.terminal : {}

  const cursorStyleRaw = term.cursorStyle ?? DEFAULT_UI_PREFS.terminal.cursorStyle
  const cursorStyleStr = String(cursorStyleRaw || '').toLowerCase()
  const cursorStyle = CURSOR_STYLE_VALUES.includes(cursorStyleStr)
    ? cursorStyleStr
    : DEFAULT_UI_PREFS.terminal.cursorStyle

  return {
    particles: {
      enabled: p.enabled === undefined ? DEFAULT_UI_PREFS.particles.enabled : !!p.enabled,
      intensity: clampNum(p.intensity ?? DEFAULT_UI_PREFS.particles.intensity, 50, 100),
    },
    timestamps: {
      enabled: ts.enabled === undefined ? DEFAULT_UI_PREFS.timestamps.enabled : !!ts.enabled,
    },
    terminal: {
      cursorStyle,
      cursorBlink: term.cursorBlink === undefined ? DEFAULT_UI_PREFS.terminal.cursorBlink : !!term.cursorBlink,
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

// Small inline version for headers
// Reuses the app favicon (yellow circle + hermelin face)
const InvertelinSmall = ({ size = 22 }) => (
  <img
    src="/favicon.svg"
    width={size}
    height={size}
    alt=""
    draggable={false}
    style={{ display: 'block' }}
  />
)

const STOUT_MASCOT_SVG = STOUT_MASCOT_RAW
  .replace('<svg ', '<svg width="100%" height="100%" style="display:block" ')
  .replace(/fill="black"/g, 'fill="currentColor"')

const StoutMascot = ({ size = 18, color = AMBER[400] }) => {
  const w = Math.round(size * (370 / 238))
  return (
    <span
      style={{
        display: 'inline-block',
        width: w,
        height: size,
        color,
        lineHeight: 0,
      }}
      dangerouslySetInnerHTML={{ __html: STOUT_MASCOT_SVG }}
    />
  )
}

const HERMILIN_NOT_FLIPPED_SVG = HERMILIN_NOT_FLIPPED_RAW
  .replace('<svg ', '<svg width="100%" height="100%" style="display:block" ')
  .replace(/fill="black"/g, 'fill="currentColor"')

const HermilinNotFlipped = ({ size = 18, color = AMBER[400] }) => {
  const w = Math.round(size * (370 / 238))
  return (
    <span
      style={{
        display: 'inline-block',
        width: w,
        height: size,
        color,
        lineHeight: 0,
      }}
      dangerouslySetInnerHTML={{ __html: HERMILIN_NOT_FLIPPED_SVG }}
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
        ctx.fillStyle = `rgba(245,183,49,${p.o})`
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
            ctx.strokeStyle = `rgba(245,183,49,${connBase * (1 - d / 120)})`
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
  }, [factor])

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

const GrainOverlay = () => (
  <div
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      pointerEvents: 'none',
      zIndex: 10,
      opacity: 0.03,
      mixBlendMode: 'overlay',
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
    }}
  />
)

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

const AlignmentEasterEgg = ({ toast }) => {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [whisper, setWhisper] = useState('aligned to you…')

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
      setWhisper(t || 'aligned to you…')
    } catch {
      setWhisper('aligned to you…')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setWhisper('…')
    fetchWhisper()
  }, [open, fetchWhisper])

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
      title="the stout knows…"
    >
      <StoutMascot size={18} />

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
  const model = context?.session_model || hit?.session_model
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
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Particle background</div>
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
            hermilinChat Version: {HERMILINCHAT_VERSION}
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
  cursorStyle = DEFAULT_UI_PREFS.terminal.cursorStyle,
  cursorBlink = DEFAULT_UI_PREFS.terminal.cursorBlink,
}) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)

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

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 1,
      scrollback: 10000,
      convertEol: true,
      allowTransparency: true,
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

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    return () => {
      try {
        term.dispose()
      } catch {
        // ignore
      }
    }
  }, [])

  useEffect(() => {
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
  }, [cursorStyle, cursorBlink])

  useEffect(() => {
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

    // Webfonts (JetBrains Mono) load async. If we spawn the PTY before the font
    // is ready, fit/proposeDimensions can compute a cols/rows value based on
    // fallback font metrics, causing Rich to render the banner at the wrong
    // width. We therefore wait for fonts before the initial WS connect.
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

    const start = async () => {
      try {
        // Trigger the actual font load so document.fonts.ready includes it.
        if (document?.fonts?.load) {
          await document.fonts.load('13px "JetBrains Mono"')
        }
        if (document?.fonts?.ready) {
          await document.fonts.ready
        }
      } catch {
        // ignore
      }
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

      const wsUrl = buildWsUrl(resumeId, { cols: initialCols, rows: initialRows })
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
  }, [resumeId, spawnNonce, onConnectionChange])

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

  const [uiPrefs, setUiPrefs] = useState(() => loadUiPrefs())

  const updateUiPrefs = useCallback((updater) => {
    setUiPrefs((prev) => {
      const base = normalizeUiPrefs(prev)
      const next = typeof updater === 'function' ? updater(base) : updater
      return normalizeUiPrefs(next)
    })
  }, [])

  useEffect(() => {
    saveUiPrefs(uiPrefs)
  }, [uiPrefs])


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
  const [activeArtifactId, setActiveArtifactId] = useState(null)
  const artifactTabsRef = useRef([])
  const artifactEverSeenRef = useRef(false)

  useEffect(() => {
    artifactTabsRef.current = artifactTabs
    if (artifactTabs.length > 0) artifactEverSeenRef.current = true
  }, [artifactTabs])

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
    try {
      document.title = 'hermilinChat'
    } catch {
      // ignore
    }
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
          model: r.session_model || null,
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
        setArtifactPanelDismissed(false)
        if (!artifactPanelPinned) setArtifactPanelOpen(false)
        return
      }

      if (openOnChange && hasAddOrUpdate && (!artifactPanelDismissed || hasNewIds)) {
        setArtifactPanelDismissed(false)
        setArtifactPanelOpen(true)
        closePeek()
      }
    },
    [artifactPanelDismissed, artifactPanelPinned, normalizeArtifacts],
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

      if (payload.type === 'artifact_close') {
        const info = payload.payload || {}
        if (info.action === 'close_all') {
          applyArtifacts([], { openOnChange: false })
          return true
        }
        const id = info.id || info.tab_id
        if (id) {
          const next = (artifactTabsRef.current || []).filter((item) => item.id !== id)
          applyArtifacts(next, { openOnChange: false })
          return true
        }
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
  useEffect(() => {
    if (activeSessionId) setNewSessionStartedAt(null)
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

        const candidate = list.find((s) => (s.started_at || 0) >= newSessionStartedAt - 10)
        if (candidate?.id) {
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

  const currentModel = activeSession?.model || runtimeInfo.default_model || null
  const currentCwd = runtimeInfo.spawn_cwd || null

  const locked = !auth.loading && auth.enabled && !auth.authenticated

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: SLATE.bg,
        display: 'flex',
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
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: SLATE.text,
                opacity: 0.68,
                letterSpacing: '0.02em',
                userSelect: 'none',
              }}
            >
              hermilinChat
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
          <ParticleField intensity={uiPrefs.particles.intensity} />
        )}
        <GrainOverlay />

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
          <HermilinNotFlipped size={18} />
          <span style={{ fontSize: 11, color: SLATE.muted }}>session:</span>
          <span style={{ color: SLATE.muted, fontSize: 11 }}>·</span>
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
                  cursorStyle={uiPrefs.terminal.cursorStyle}
                  cursorBlink={uiPrefs.terminal.cursorBlink}
                  onConnectionChange={handleConnectionChange}
                  onSessionId={handleDetectedSessionId}
                  onControlMessage={handleArtifactControlMessage}
                />
                <AlignmentEasterEgg toast={eggToast} />
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

            {!artifactPanelOpen && auth.authenticated && (artifactTabs.length > 0 || artifactEverSeenRef.current) && (
              <div
                onClick={() => {
                  setArtifactPanelDismissed(false)
                  setArtifactPanelOpen(true)
                  closePeek()
                }}
                title="Open artifact panel"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: SLATE.surface,
                  border: `1px solid ${SLATE.border}`,
                  borderRight: 'none',
                  borderRadius: '6px 0 0 6px',
                  padding: '12px 6px',
                  cursor: 'pointer',
                  color: SLATE.muted,
                  zIndex: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  userSelect: 'none',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                <span style={{ fontSize: 8, writingMode: 'vertical-lr', letterSpacing: '0.1em', textTransform: 'uppercase' }}>PANEL</span>
              </div>
            )}
          </div>

          {artifactPanelOpen ? (
            <ArtifactPanel
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
                <InvertelinSmall size={18} />
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
          defaultModel={runtimeInfo.default_model}
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
  )
}

