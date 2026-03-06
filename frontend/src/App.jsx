import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import STOUT_MASCOT_RAW from './assets/stout-mascot.svg?raw'

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

// ─── PARTICLE FIELD ────────────────────────────────────────────────
const ParticleField = () => {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let animId
    let particles = []

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800
      canvas.height = canvas.parentElement?.offsetHeight || 600
      particles = Array.from({ length: 60 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        o: Math.random() * 0.15 + 0.03,
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
      // connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < 120) {
            ctx.beginPath()
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            ctx.strokeStyle = `rgba(245,183,49,${0.04 * (1 - d / 120)})`
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
  }, [])

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
        opacity: 0.5,
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
            color: active ? AMBER[400] : SLATE.textBright,
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

const SearchHitRow = ({ hit, active, onClick }) => {
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
        <div style={{ width: 44, fontSize: 10, color: SLATE.muted, flexShrink: 0 }}>{isoToTimeLabel(hit?.timestamp_iso)}</div>
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

const AlignmentEasterEgg = () => {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [whisper, setWhisper] = useState('aligned to you…')

  const opacity = open ? 0.75 : hovered ? 0.25 : 0.08

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
        transform: open ? 'scale(1.15)' : 'scale(1)',
        filter: open ? `drop-shadow(0 0 10px ${AMBER[400]}70)` : 'none',
        userSelect: 'none',
      }}
      title="the stout knows…"
    >
      <StoutMascot size={18} />
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 24,
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

function buildWsUrl(resumeId) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams()
  if (resumeId) params.set('resume', resumeId)
  const q = params.toString()
  return `${proto}://${window.location.host}/ws/pty${q ? `?${q}` : ''}`
}

function stripAnsi(s) {
  // Best-effort ANSI escape stripping for parsing session IDs from terminal output.
  // (We still render the raw bytes to xterm; this is only for metadata detection.)
  return (s || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
}

function TerminalPane({ resumeId, spawnNonce, onConnectionChange, onSessionId }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
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

    const wsUrl = buildWsUrl(resumeId)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    const encoder = new TextEncoder()

    // Try to detect the Hermes session ID from the terminal output so the UI can
    // auto-select the correct session in the sidebar/topbar.
    const decoder = new TextDecoder('utf-8')
    let detectTail = ''
    let lastDetectedSid = null

    const maybeDetectSessionId = (text) => {
      if (!text || !onSessionId) return
      detectTail = (detectTail + text).slice(-6000)
      const clean = stripAnsi(detectTail)
      const m = clean.match(/Session:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]{6})/i)
      const sid = m?.[1] || null
      if (sid && sid !== lastDetectedSid) {
        lastDetectedSid = sid
        onSessionId(sid)
      }
    }

    const sendResize = () => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const ro = new ResizeObserver(() => sendResize())
    ro.observe(container)

    const onDataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
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
        term.write(ev.data)
        maybeDetectSessionId(ev.data)
      }
    }

    return () => {
      try {
        ro.disconnect()
      } catch {
        // ignore
      }
      try {
        onDataDisposable.dispose()
      } catch {
        // ignore
      }
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }, [resumeId, spawnNonce, onConnectionChange])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        padding: '12px 12px 12px 12px',
        zIndex: 5,
      }}
    />
  )
}

export default function App() {
  const [sessions, setSessions] = useState([])

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

  useEffect(() => {
    if (!auth.authenticated) {
      closePeek()
    }
  }, [auth.authenticated])

  const openPeek = async (hit) => {
    if (!auth.authenticated) return
    if (!hit?.id) return

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
      await refreshAuth()
    }
  }

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
          width: 290,
          flexShrink: 0,
          background: SLATE.surface,
          borderRight: `1px solid ${SLATE.border}`,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          zIndex: 2,
        }}
      >
        <div
          style={{
            padding: '14px 14px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${SLATE.border}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <InvertelinSmall size={20} />
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: AMBER[400],
                letterSpacing: '0.02em',
              }}
            >
              hermelinChat
            </span>
          </div>
          <div style={{ fontSize: 11, color: SLATE.muted }}>{locked ? 'locked' : 'sessions'}</div>
        </div>

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
            label="New session"
            active={activeSessionId === null}
            onClick={() => {
              if (!auth.authenticated) return
              setSearchQuery('')
              ptyResumeIdRef.current = null
              activeSessionIdRef.current = null
              setPtyResumeId(null)
              setActiveSessionId(null)
              setPtySpawnNonce((n) => n + 1)
              setNewSessionStartedAt(Date.now() / 1000)
              closePeek()
            }}
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
                        right={isoToTimeLabel(top?.timestamp_iso)}
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
                        preview={s.preview || s.model}
                        right={isoToTimeLabel(s.started_at_iso)}
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
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: connected ? SLATE.success : SLATE.muted,
                boxShadow: `0 0 8px ${connected ? SLATE.success : SLATE.muted}`,
              }}
            />
            <div style={{ fontSize: 11, color: SLATE.muted }}>{connected ? 'connected' : locked ? 'locked' : 'disconnected'}</div>
          </div>

          {auth.enabled && auth.authenticated && (
            <div
              onClick={doLogout}
              style={{
                fontSize: 11,
                color: AMBER[500],
                cursor: 'pointer',
                userSelect: 'none',
              }}
              title="Logout"
            >
              logout
            </div>
          )}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        <ParticleField />
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
          <InvertelinSmall size={18} />
          <span style={{ fontSize: 12, fontWeight: 600, color: AMBER[400] }}>hermes</span>
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

        <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            {auth.authenticated ? (
              <>
                <TerminalPane
                  resumeId={ptyResumeId}
                  spawnNonce={ptySpawnNonce}
                  onConnectionChange={handleConnectionChange}
                  onSessionId={handleDetectedSessionId}
                />
                <AlignmentEasterEgg />
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
          </div>

          {peekOpen && (
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
    </div>
  )
}
