import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'

import { buildWsUrl, stripAnsi } from './utils'
import { handleControlMessage } from '../artifacts/bridge'
import { useArtifactStore } from '../../stores/artifacts'
import { useTerminalStore } from '../../stores/terminal'
import { useUiPrefsStore } from '../../stores/ui-prefs'
import { AMBER, SLATE } from '../../theme/index'
import { CURSOR_STYLE_VALUES, DEFAULT_UI_PREFS } from '../../utils/ui-prefs'

// ---------------------------------------------------------------------------
// Terminal output queue
// ---------------------------------------------------------------------------

type TerminalWriteQueueReason = 'overflow' | 'write-timeout' | 'write-error'

type TerminalWriteQueueOptions = {
  maxPendingBytes?: number
  maxPendingItems?: number
  writeTimeoutMs?: number
  onBackpressureLimit?: (reason: TerminalWriteQueueReason) => void
}

type QueuedTerminalWrite = {
  data: string | Uint8Array
  size: number
}

type TerminalWritable = {
  write(data: string | Uint8Array, callback?: () => void): void
}

function terminalWriteSize(data: string | Uint8Array): number {
  return typeof data === 'string' ? data.length : data.byteLength
}

function positiveQueueNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const TERMINAL_MOUSE_MODE_IDS = new Set([
  // X10 / VT200 / button-event / any-event mouse reporting.
  '9',
  '1000',
  '1001',
  '1002',
  '1003',
  // Mouse encoding / wheel variants commonly paired with the modes above.
  '1005',
  '1006',
  '1007',
  '1015',
  '1016',
])

export function stripTerminalMouseModeSequences(text: string): string {
  if (!text || !text.includes('\u001b[?')) return text

  return text.replace(/\u001b\[\?([0-9;]*)([hl])/g, (sequence, params: string, final: string) => {
    const modeIds = params.split(';').filter(Boolean)
    if (modeIds.length === 0) return sequence

    const keep = modeIds.filter((modeId) => !TERMINAL_MOUSE_MODE_IDS.has(modeId))
    if (keep.length === modeIds.length) return sequence
    if (keep.length === 0) return ''

    return `\u001b[?${keep.join(';')}${final}`
  })
}

function splitTrailingIncompletePrivateModeSequence(text: string): readonly [string, string] {
  const idx = text.lastIndexOf('\u001b[?')
  if (idx < 0) return [text, '']

  const tail = text.slice(idx)
  if (/^\u001b\[\?[0-9;]*$/.test(tail)) {
    return [text.slice(0, idx), tail]
  }

  return [text, '']
}

export function createTerminalMouseModeFilter() {
  let pendingPrivateMode = ''
  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()

  const filterText = (text: string) => {
    const combined = pendingPrivateMode + text
    const [complete, pending] = splitTrailingIncompletePrivateModeSequence(combined)
    pendingPrivateMode = pending
    return stripTerminalMouseModeSequences(complete)
  }

  return {
    filter(data: string | Uint8Array): string | Uint8Array {
      if (typeof data === 'string') return filterText(data)
      return encoder.encode(filterText(decoder.decode(data, { stream: true })))
    },
    flush(): string {
      const text = pendingPrivateMode + decoder.decode()
      pendingPrivateMode = ''
      return stripTerminalMouseModeSequences(text)
    },
  }
}

export function createTerminalWriteQueue(term: TerminalWritable, options: TerminalWriteQueueOptions = {}) {
  const maxPendingBytes = positiveQueueNumber(options.maxPendingBytes, 4 * 1024 * 1024)
  const maxPendingItems = positiveQueueNumber(options.maxPendingItems, 2048)
  const writeTimeoutMs = positiveQueueNumber(options.writeTimeoutMs, 5000)

  const pending: QueuedTerminalWrite[] = []
  let pendingBytes = 0
  let writing = false
  let writingBytes = 0
  let disposed = false
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  const clearWriteTimer = () => {
    if (writeTimer !== null) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
  }

  const fail = (reason: TerminalWriteQueueReason) => {
    if (disposed) return
    disposed = true
    writing = false
    writingBytes = 0
    pending.length = 0
    pendingBytes = 0
    clearWriteTimer()
    options.onBackpressureLimit?.(reason)
  }

  const nextBatch = (): QueuedTerminalWrite | null => {
    const first = pending.shift()
    if (first === undefined) return null
    pendingBytes = Math.max(0, pendingBytes - first.size)

    if (typeof first.data === 'string') {
      let out = first.data
      let size = first.size
      while (pending.length && typeof pending[0].data === 'string' && out.length < 65536) {
        const chunk = pending.shift() as QueuedTerminalWrite
        pendingBytes = Math.max(0, pendingBytes - chunk.size)
        out += chunk.data as string
        size += chunk.size
      }
      return { data: out, size }
    }

    const chunks: Uint8Array[] = [first.data]
    let total = first.data.byteLength
    while (pending.length && pending[0].data instanceof Uint8Array && total < 65536) {
      const chunk = pending.shift() as QueuedTerminalWrite
      pendingBytes = Math.max(0, pendingBytes - chunk.size)
      chunks.push(chunk.data as Uint8Array)
      total += chunk.size
    }

    if (chunks.length === 1) return first

    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { data: merged, size: total }
  }

  const drain = () => {
    if (disposed || writing) return
    const batch = nextBatch()
    if (batch === null) return

    writing = true
    writingBytes = batch.size
    clearWriteTimer()
    writeTimer = setTimeout(() => {
      fail('write-timeout')
    }, writeTimeoutMs)

    try {
      term.write(batch.data, () => {
        if (disposed) return
        clearWriteTimer()
        writing = false
        writingBytes = 0
        drain()
      })
    } catch {
      fail('write-error')
    }
  }

  return {
    enqueue(data: string | Uint8Array) {
      if (disposed) return false
      if (typeof data === 'string' && data.length === 0) return true
      if (data instanceof Uint8Array && data.byteLength === 0) return true

      const size = terminalWriteSize(data)
      if (
        size > maxPendingBytes
        || pending.length >= maxPendingItems
        || pendingBytes + writingBytes + size > maxPendingBytes
      ) {
        fail('overflow')
        return false
      }

      pending.push({ data, size })
      pendingBytes += size
      drain()
      return true
    },
    clear() {
      pending.length = 0
      pendingBytes = 0
    },
    dispose() {
      disposed = true
      pending.length = 0
      pendingBytes = 0
      writingBytes = 0
      clearWriteTimer()
    },
    size() {
      return pending.length + (writing ? 1 : 0)
    },
    bytes() {
      return pendingBytes + writingBytes
    },
  }
}

export function createSessionIdDetector(onDetected: (sid: string) => void) {
  let detectTail = ''
  let lastDetectedSid: string | null = null

  return (text: string) => {
    if (!text || lastDetectedSid) return null
    detectTail = (detectTail + text).slice(-6000)
    const clean = stripAnsi(detectTail)
    if (!clean.includes('Session:')) return null

    const match = clean.match(/Session:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]{6})/i)
    const sid = match?.[1] || null
    if (!sid || sid === lastDetectedSid) return null

    lastDetectedSid = sid
    onDetected(sid)
    return sid
  }
}

// ---------------------------------------------------------------------------
// TerminalPane
//
// Manages the xterm.js Terminal instance, FitAddon, and WebSocket connection
// to the backend PTY. Everything is tightly coupled so this stays as one file.
// ---------------------------------------------------------------------------

function TerminalPane() {
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
    let removeCopyListener: (() => void) | null = null

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
        // Full-screen TUIs usually enable terminal mouse reporting. We strip
        // those sequences from PTY output below so plain drag selects text like
        // classic Hermes chat. Keep the xterm modifier escape hatch enabled for
        // any custom commands that still manage to enter mouse mode.
        macOptionClickForcesSelection: true,
        theme: {
          // Transparent terminal so the ParticleField (and grain) can show through.
          // NOTE: allowTransparency must be true for this to work.
          background: 'rgba(0,0,0,0)',
          foreground: SLATE.textBright,
          cursor: AMBER[400],
          selectionBackground: `${AMBER[700]}44`,
        },
      })

      const refocusTerminalSoon = () => {
        setTimeout(() => {
          try {
            term.focus()
          } catch {
            // ignore
          }
        }, 0)
      }

      // Windows Terminal-like clipboard shortcuts:
      // - Ctrl/Cmd+C copies selection (when something is selected)
      // - Ctrl/Cmd+V pastes (browser handles paste into xterm textarea)
      const copyTextToClipboard = async (text: string) => {
        const t = (text || '').toString()
        if (!t) return false

        // Async Clipboard API (requires HTTPS or localhost)
        try {
          if (window.isSecureContext && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(t)
            return true
          }
        } catch {
          // ignore and fall back
        }

        // Fallback for http://<ip>: use a real copy command against a temporary
        // textarea. Firefox/LAN installs can reject navigator.clipboard even
        // when the shortcut came from an actual user gesture.
        const ta = document.createElement('textarea')
        try {
          ta.value = t
          ta.setAttribute('readonly', 'true')
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          ta.style.left = '-9999px'
          ta.style.top = '-9999px'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          return document.execCommand('copy')
        } catch {
          return false
        } finally {
          try {
            if (ta.parentNode) ta.parentNode.removeChild(ta)
          } catch {
            // ignore
          }
        }
      }

      const copySelectionToClipboard = () => {
        const selectedText = term.getSelection()
        if (!selectedText) return false

        // First prefer the browser's real copy event. The handler below writes
        // xterm's virtual selection into event.clipboardData, which is more
        // reliable than async clipboard calls in Firefox or over plain HTTP.
        let copiedByNativeCopyEvent = false
        try {
          copiedByNativeCopyEvent = document.execCommand('copy')
        } catch {
          copiedByNativeCopyEvent = false
        }

        if (!copiedByNativeCopyEvent) {
          void copyTextToClipboard(selectedText)
        }

        term.clearSelection()
        refocusTerminalSoon()
        return true
      }

      const handleTerminalCopy = (ev: ClipboardEvent) => {
        const selectedText = term.getSelection()
        if (!selectedText) return

        const clipboardData = ev.clipboardData
        if (!clipboardData) return

        try {
          clipboardData.setData('text/plain', selectedText)
          ev.preventDefault()
        } catch {
          // If direct clipboardData write fails, let the key handler fallback run.
        }
      }
      container.addEventListener('copy', handleTerminalCopy)
      removeCopyListener = () => container.removeEventListener('copy', handleTerminalCopy)

      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true

        const key = (ev.key || '').toLowerCase()
        const ctrlOrMeta = ev.ctrlKey || ev.metaKey

        // Ctrl/Cmd+C: copy selection instead of sending ^C. Without a selection,
        // keep normal terminal behavior so Ctrl+C still interrupts the PTY.
        if (ctrlOrMeta && key === 'c' && term.hasSelection()) {
          ev.preventDefault()
          ev.stopPropagation()
          copySelectionToClipboard()
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
        removeCopyListener?.()
        removeCopyListener = null
      } catch {
        // ignore
      }
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
    let outputBackpressureClosed = false
    const closeForOutputBackpressure = (reason: 'overflow' | 'write-timeout' | 'write-error') => {
      if (outputBackpressureClosed) return
      outputBackpressureClosed = true
      try {
        term.write(`\r\n\u001b[31mTerminal output ${reason}; disconnected to protect the browser.\u001b[0m\r\n`)
      } catch {
        // ignore
      }
      try {
        ws?.close(4000, 'terminal output backlog')
      } catch {
        // ignore
      }
    }
    let writeQueue: ReturnType<typeof createTerminalWriteQueue> | null = createTerminalWriteQueue(term, {
      onBackpressureLimit: closeForOutputBackpressure,
    })
    const realtimeToken = `${spawnNonce}:${resumeId ?? ''}:${Date.now()}:${Math.random()}`

    const isCurrentSocket = () => !cancelled && !!ws && ws === wsRef.current

    const encoder = new TextEncoder()

    // Try to detect the Hermes session ID from the terminal output so the UI can
    // auto-select the correct session in the sidebar/topbar.
    const decoder = new TextDecoder('utf-8')
    const terminalMouseModeFilter = createTerminalMouseModeFilter()
    const maybeDetectSessionId = createSessionIdDetector((sid) => {
      const cb = onDetectedSessionIdRef.current
      if (cb) cb(sid)
    })

    const sendResize = () => {
      if (!isCurrentSocket()) return
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
        if (isCurrentSocket() && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encoder.encode(data))
        }
      })

      const connectionNonce = spawnNonce

      ws.onopen = () => {
        if (!isCurrentSocket()) return
        onConnectionChange(true, connectionNonce)
        useArtifactStore.getState().setRealtimeUpdatesActive(true, realtimeToken)
        // initial fit + resize
        setTimeout(sendResize, 10)
      }

      ws.onclose = () => {
        if (!isCurrentSocket()) return
        onConnectionChange(false, connectionNonce)
        useArtifactStore.getState().setRealtimeUpdatesActive(false, realtimeToken)
      }

      ws.onerror = () => {
        if (!isCurrentSocket()) return
        onConnectionChange(false, connectionNonce)
        useArtifactStore.getState().setRealtimeUpdatesActive(false, realtimeToken)
      }

      ws.onmessage = (ev: MessageEvent) => {
        if (!isCurrentSocket()) return
        if (ev.data instanceof ArrayBuffer) {
          const u8 = new Uint8Array(ev.data)
          const filteredOutput = terminalMouseModeFilter.filter(u8)
          if (filteredOutput instanceof Uint8Array && filteredOutput.byteLength > 0) {
            writeQueue?.enqueue(filteredOutput)
          }
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
          const filteredOutput = terminalMouseModeFilter.filter(ev.data)
          if (typeof filteredOutput === 'string' && filteredOutput.length > 0) {
            writeQueue?.enqueue(filteredOutput)
          }
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
        writeQueue?.dispose()
        writeQueue = null
      } catch {
        // ignore
      }
      try {
        useArtifactStore.getState().setRealtimeUpdatesActive(false, realtimeToken)
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

export default memo(TerminalPane)
