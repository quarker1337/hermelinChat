import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'

import { buildWsUrl, stripAnsi } from './utils'
import { handleControlMessage } from '../artifacts/bridge'
import { useTerminalStore } from '../../stores/terminal'
import { useUiPrefsStore } from '../../stores/ui-prefs'
import { AMBER, SLATE } from '../../theme/index'
import { CURSOR_STYLE_VALUES, DEFAULT_UI_PREFS } from '../../utils/ui-prefs'

// ---------------------------------------------------------------------------
// TerminalPane
//
// Manages the xterm.js Terminal instance, FitAddon, and WebSocket connection
// to the backend PTY. Everything is tightly coupled so this stays as one file.
// ---------------------------------------------------------------------------

export default function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const [termReady, setTermReady] = useState(false)

  // ── Store reads ──────────────────────────────────────────────────────────
  const spawnNonce = useTerminalStore((s) => s.spawnNonce)
  const onConnectionChange = useTerminalStore((s) => s.onConnectionChange)
  const onDetectedSessionId = useTerminalStore((s) => s.onDetectedSessionId)
  const terminalState = useTerminalStore((s) => s.state)

  const prefs = useUiPrefsStore((s) => s.prefs)
  const themeId = prefs.theme
  const cursorStyle = prefs.terminal?.cursorStyle ?? DEFAULT_UI_PREFS.terminal.cursorStyle
  const cursorBlink = prefs.terminal?.cursorBlink ?? DEFAULT_UI_PREFS.terminal.cursorBlink

  // Derive resumeId from terminal state
  const resumeId =
    (terminalState.phase === 'connecting' || terminalState.phase === 'connected')
      ? (terminalState as { resumeId: string | null }).resumeId ?? null
      : null

  // ── Stable refs for callbacks (avoids stale closures in WS lifecycle) ───
  const themeIdRef = useRef(themeId)
  useEffect(() => {
    themeIdRef.current = themeId
  }, [themeId])

  const onDetectedSessionIdRef = useRef(onDetectedSessionId)
  useEffect(() => {
    onDetectedSessionIdRef.current = onDetectedSessionId
  }, [onDetectedSessionId])

  // ── Init: open xterm once ────────────────────────────────────────────────
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
      const copyTextToClipboard = async (text: string) => {
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

  // ── Cursor style/blink update ────────────────────────────────────────────
  useEffect(() => {
    if (!termReady) return
    const term = termRef.current
    if (!term) return

    const cs = (cursorStyle || '').toString().toLowerCase()
    const style = CURSOR_STYLE_VALUES.includes(cs) ? cs : DEFAULT_UI_PREFS.terminal.cursorStyle

    try {
      term.options.cursorStyle = style as 'bar' | 'block' | 'underline'
    } catch {
      // ignore
    }

    try {
      term.options.cursorBlink = !!cursorBlink
    } catch {
      // ignore
    }
  }, [termReady, cursorStyle, cursorBlink])

  // ── Theme color update ───────────────────────────────────────────────────
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

  // ── WebSocket lifecycle ──────────────────────────────────────────────────
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
    let ws: WebSocket | null = null
    let ro: ResizeObserver | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let onDataDisposable: { dispose(): void } | null = null

    const encoder = new TextEncoder()

    // Try to detect the Hermes session ID from the terminal output so the UI can
    // auto-select the correct session in the sidebar/topbar.
    const decoder = new TextDecoder('utf-8')
    let detectTail = ''
    let lastDetectedSid: string | null = null

    const maybeDetectSessionId = (text: string) => {
      const cb = onDetectedSessionIdRef.current
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

      const connectionNonce = spawnNonce

      ws.onopen = () => {
        onConnectionChange(true, connectionNonce)
        // initial fit + resize
        setTimeout(sendResize, 10)
      }

      ws.onclose = () => {
        onConnectionChange(false, connectionNonce)
      }

      ws.onerror = () => {
        onConnectionChange(false, connectionNonce)
      }

      ws.onmessage = (ev: MessageEvent) => {
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
            const payload = JSON.parse(ev.data) as unknown
            if (
              payload &&
              typeof payload === 'object' &&
              (payload as Record<string, unknown>).type &&
              handleControlMessage(payload)
            ) {
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
