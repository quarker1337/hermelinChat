import { useEffect, useMemo, useRef, useState } from 'react'

import DOMPurify from 'dompurify'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github-dark.css'

import { AMBER, SLATE, formatTimestamp, getActiveTheme, levelColor, semanticColor } from '../../theme/index'

const HLJS_LANGS = [
  ['bash', bash],
  ['css', css],
  ['go', go],
  ['javascript', javascript],
  ['json', json],
  ['python', python],
  ['rust', rust],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
]

for (const [name, loader] of HLJS_LANGS) {
  try {
    if (!hljs.getLanguage(name)) {
      hljs.registerLanguage(name, loader)
    }
  } catch {
    // ignore
  }
}

// -----------------------------------------------------------------------------
// Runner gateway helpers
//
// Iframe artifacts sometimes point to localhost (127.0.0.1) which breaks when the
// operator browser is on a different machine. hermelinChat exposes these runners
// via a same-origin proxy under /r/{tab_id}/_t/{token}/...
// -----------------------------------------------------------------------------

const RUNNER_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])

// tab_id -> { token, expiresAt, basePath } OR { pending: Promise<...> }
const runnerTokenCache = new Map()

function parseLocalRunnerSrc(src) {
  if (!src || typeof src !== 'string') return null
  try {
    const u = new URL(src)
    const host = String(u.hostname || '').toLowerCase()
    if (!RUNNER_LOCAL_HOSTS.has(host)) return null
    return {
      path: u.pathname || '/',
      search: u.search || '',
      hash: u.hash || '',
    }
  } catch {
    return null
  }
}

async function mintRunnerToken(tabId) {
  const now = Date.now() / 1000
  const cached = runnerTokenCache.get(tabId)

  if (cached && cached.token && cached.expiresAt && cached.basePath) {
    if (cached.expiresAt - now > 20) {
      return cached
    }
  }

  if (cached && cached.pending) {
    return await cached.pending
  }

  const pending = (async () => {
    const r = await fetch(`/api/runners/${encodeURIComponent(tabId)}/token`, { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

    const out = {
      token: String(data?.token || ''),
      expiresAt: Number(data?.expires_at || 0),
      basePath: String(data?.base_path || ''),
    }

    if (!out.token || !out.basePath) throw new Error('invalid runner token response')

    runnerTokenCache.set(tabId, out)
    return out
  })()

  runnerTokenCache.set(tabId, { pending })

  try {
    return await pending
  } catch (err) {
    runnerTokenCache.delete(tabId)
    throw err
  }
}

function ArtifactEmpty({ title, detail }) {
  return (
    <div
      style={{
        padding: '18px 16px',
        color: SLATE.muted,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: SLATE.textBright, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div>{detail}</div>
    </div>
  )
}

function JsonPreview({ value }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '12px 14px',
        color: SLATE.text,
        fontSize: 11,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function normalizeColumnsAndRows(data) {
  const columns = Array.isArray(data?.columns) ? data.columns.map((col) => String(col)) : []
  const rawRows = Array.isArray(data?.rows) ? data.rows : []

  if (!columns.length && rawRows.length && rawRows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    const inferredColumns = Array.from(
      rawRows.reduce((set, row) => {
        Object.keys(row).forEach((key) => set.add(key))
        return set
      }, new Set()),
    )
    return {
      columns: inferredColumns,
      rows: rawRows.map((row) => inferredColumns.map((key) => row?.[key] ?? '')),
    }
  }

  return {
    columns,
    rows: rawRows.map((row) => {
      if (Array.isArray(row)) return row
      if (row && typeof row === 'object') return columns.map((key) => row?.[key] ?? '')
      return [String(row ?? '')]
    }),
  }
}

function TableArtifact({ artifact }) {
  const data = artifact?.data || {}
  const { columns, rows } = normalizeColumnsAndRows(data)
  const highlightRules = data?.highlight_rules && typeof data.highlight_rules === 'object' ? data.highlight_rules : {}

  if (!columns.length) {
    return <ArtifactEmpty title="Invalid table artifact" detail="Expected data.columns and data.rows." />
  }

  return (
    <div style={{ padding: '12px 14px' }}>
      <div
        style={{
          border: `1px solid ${SLATE.border}`,
          borderRadius: 6,
          overflow: 'hidden',
          background: `${SLATE.surface}cc`,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
            padding: '7px 10px',
            background: SLATE.elevated,
            fontSize: 9,
            color: SLATE.muted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            borderBottom: `1px solid ${SLATE.border}`,
          }}
        >
          {columns.map((column) => (
            <span key={column} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {column}
            </span>
          ))}
        </div>

        {rows.map((row, rowIndex) => (
          <div
            key={`${artifact?.id || 'table'}-row-${rowIndex}`}
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
              gap: 8,
              padding: '6px 10px',
              alignItems: 'center',
              borderBottom: `1px solid ${SLATE.border}20`,
              fontSize: 11,
            }}
          >
            {columns.map((column, columnIndex) => {
              const cell = row?.[columnIndex] ?? ''
              const semantic = highlightRules?.[column]?.[String(cell)]
              const color = semantic ? semanticColor(semantic) : SLATE.text
              const background = semantic === 'danger' ? `${SLATE.danger}10` : semantic === 'success' ? `${SLATE.success}10` : semantic === 'warning' ? `${AMBER[900]}35` : 'transparent'
              return (
                <span
                  key={`${artifact?.id || 'table'}-${rowIndex}-${column}`}
                  title={String(cell)}
                  style={{
                    color,
                    background,
                    borderRadius: 4,
                    padding: semantic ? '2px 6px' : 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {String(cell)}
                </span>
              )
            })}
          </div>
        ))}
      </div>

      {data?.summary ? (
        <div style={{ marginTop: 10, fontSize: 10, color: SLATE.muted }}>{String(data.summary)}</div>
      ) : null}
    </div>
  )
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// ---------------------------------------------------------------------------
// Markdown rendering (marked + highlight.js)
// ---------------------------------------------------------------------------

const MARKDOWN_LANG_ALIASES = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  html: 'xml',
}

function normalizeMarkdownLanguage(lang) {
  const raw = String(lang || '').trim().toLowerCase()
  if (!raw) return ''
  return MARKDOWN_LANG_ALIASES[raw] || raw
}

function sanitizeUrl(href) {
  const raw = String(href || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return ''
  return raw
}

const MARKDOWN_RENDERER = new marked.Renderer()

MARKDOWN_RENDERER.html = ({ text }) => {
  // Disallow raw HTML passthrough.
  return escapeHtml(text)
}

MARKDOWN_RENDERER.link = function ({ href, title, tokens }) {
  const inner = this.parser.parseInline(tokens)
  const safe = sanitizeUrl(href)
  if (!safe) return inner

  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(safe)}"${titleAttr} target="_blank" rel="noreferrer noopener">${inner}</a>`
}

MARKDOWN_RENDERER.image = ({ href, title, text }) => {
  const safe = sanitizeUrl(href)
  const alt = escapeHtml(text || '')
  if (!safe) return alt

  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<img src="${escapeHtml(safe)}" alt="${alt}"${titleAttr} loading="lazy" />`
}

MARKDOWN_RENDERER.code = ({ text, lang }) => {
  const language = normalizeMarkdownLanguage(lang)
  let highlighted = ''

  if (language && hljs.getLanguage(language)) {
    try {
      highlighted = hljs.highlight(text, { language }).value
    } catch {
      highlighted = escapeHtml(text)
    }
  } else {
    highlighted = escapeHtml(text)
  }

  const className = language ? `language-${language}` : ''
  return `<pre><code class="hljs ${className}">${highlighted}</code></pre>`
}

function markdownToHtml(markdown) {
  const source = String(markdown || '')
  try {
    return marked.parse(source, {
      renderer: MARKDOWN_RENDERER,
      gfm: true,
      breaks: false,
      headerIds: false,
      mangle: false,
    })
  } catch {
    return `<pre><code>${escapeHtml(source)}</code></pre>`
  }
}

function MarkdownArtifact({ artifact }) {
  const content = String(artifact?.data?.content || '')
  const html = useMemo(() => markdownToHtml(content), [content])

  if (!content) {
    return <ArtifactEmpty title="Invalid markdown artifact" detail="Expected data.content." />
  }

  return (
    <div
      style={{
        padding: '14px 16px',
        color: SLATE.text,
        fontSize: 12,
        lineHeight: 1.65,
      }}
    >
      <style>{`
        .artifact-markdown h1, .artifact-markdown h2, .artifact-markdown h3, .artifact-markdown h4, .artifact-markdown h5, .artifact-markdown h6 {
          color: ${SLATE.textBright};
          margin: 0 0 10px;
          line-height: 1.25;
        }
        .artifact-markdown h1 { font-size: 22px; }
        .artifact-markdown h2 { font-size: 18px; }
        .artifact-markdown h3 { font-size: 15px; }
        .artifact-markdown h4 { font-size: 13px; }
        .artifact-markdown p { margin: 0 0 12px; }
        .artifact-markdown ul, .artifact-markdown ol { margin: 0 0 12px 18px; padding: 0; }
        .artifact-markdown li { margin: 0 0 6px; }
        .artifact-markdown hr { border: 0; border-top: 1px solid ${SLATE.border}; margin: 14px 0; opacity: 0.55; }
        .artifact-markdown a { color: ${SLATE.info}; text-decoration: underline; text-underline-offset: 2px; }
        .artifact-markdown a:hover { color: ${AMBER[300]}; }

        .artifact-markdown code {
          font-family: 'JetBrains Mono', monospace;
          background: ${SLATE.elevated};
          border: 1px solid ${SLATE.border};
          color: ${AMBER[400]};
          padding: 1px 4px;
          border-radius: 4px;
        }

        .artifact-markdown pre {
          margin: 0 0 12px;
          background: ${SLATE.elevated};
          border: 1px solid ${SLATE.border};
          padding: 10px 12px;
          border-radius: 6px;
          overflow: auto;
        }

        .artifact-markdown pre code {
          background: transparent;
          border: 0;
          padding: 0;
          color: ${SLATE.text};
        }

        .artifact-markdown pre code.hljs {
          background: transparent;
        }

        .artifact-markdown table {
          width: 100%;
          border-collapse: collapse;
          margin: 0 0 12px;
        }
        .artifact-markdown th, .artifact-markdown td {
          border: 1px solid ${SLATE.border};
          padding: 6px 8px;
          font-size: 11px;
          vertical-align: top;
        }
        .artifact-markdown th {
          background: ${SLATE.elevated};
          color: ${SLATE.textBright};
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .artifact-markdown tbody tr:nth-child(even) {
          background: ${SLATE.surface}80;
        }

        .artifact-markdown blockquote {
          margin: 0 0 12px;
          padding: 0 0 0 12px;
          border-left: 2px solid ${AMBER[600]};
          color: ${SLATE.muted};
        }

        .artifact-markdown img {
          max-width: 100%;
          border: 1px solid ${SLATE.border};
          border-radius: 6px;
        }
      `}</style>
      <div className="artifact-markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
    </div>
  )
}

function HtmlLikeFrame({ srcDoc, src, title, artifactId }) {
  const iframeRef = useRef(null)
  const targetOrigin = src ? window.location.origin : '*'
  const activeTheme = getActiveTheme()
  const themeMessage = useMemo(
    () => ({
      type: 'hermes:artifact-theme',
      artifactId: artifactId || null,
      theme: {
        id: activeTheme?.id || null,
        label: activeTheme?.label || null,
        colors: {
          bg: SLATE.bg || '#0c0f0e',
          surface: SLATE.surface || '#111514',
          elevated: SLATE.elevated || '#1a201f',
          border: SLATE.border || '#243230',
          muted: SLATE.muted || '#5a7a72',
          text: SLATE.text || '#b8d4cb',
          textBright: SLATE.textBright || '#e2f0ea',
          accent: SLATE.accent || AMBER[400] || '#4dffa1',
          accentSoft: AMBER[300] || SLATE.accent || '#b7ffd6',
          accentMuted: AMBER[500] || SLATE.accent || '#2da565',
          accentStrong: AMBER[700] || AMBER[600] || SLATE.accent || '#1a6b3f',
          success: SLATE.success || AMBER[400] || '#4dffa1',
          warning: AMBER[400] || SLATE.accent || '#f0c040',
          danger: SLATE.danger || '#ff7070',
        },
      },
    }),
    [
      artifactId,
      activeTheme?.id,
      activeTheme?.label,
      SLATE.bg,
      SLATE.surface,
      SLATE.elevated,
      SLATE.border,
      SLATE.muted,
      SLATE.text,
      SLATE.textBright,
      SLATE.accent,
      SLATE.success,
      SLATE.danger,
      AMBER[300],
      AMBER[400],
      AMBER[500],
      AMBER[600],
      AMBER[700],
    ],
  )

  useEffect(() => {
    const removeQueuedCommand = (targetArtifactId, commandId) => {
      if (typeof window === 'undefined' || !targetArtifactId || !commandId) return
      const store = window.__hermesArtifactBridgeCommands
      if (!store || typeof store !== 'object') return
      const key = String(targetArtifactId)
      const queue = Array.isArray(store[key]) ? store[key] : []
      store[key] = queue.filter((item) => {
        const itemId = item?.command_id || item?.commandId || null
        return itemId !== commandId
      })
    }

    const postCommandToIframe = (command) => {
      const frame = iframeRef.current
      const target = frame?.contentWindow
      if (!target || !command || typeof command !== 'object') return false
      const targetArtifactId = command.artifact_id || command.artifactId || command.id || command.tab_id || artifactId || null
      if (targetArtifactId && artifactId && String(targetArtifactId) !== String(artifactId)) return false
      target.postMessage(
        {
          type: 'hermes:artifact-command',
          artifactId: artifactId || targetArtifactId || null,
          channel: command.channel || 'strudel',
          command: command.command || command.action || '',
          requestId: command.request_id || command.requestId || command.command_id || command.commandId || null,
          payload: command.payload && typeof command.payload === 'object' ? command.payload : {},
        },
        targetOrigin,
      )
      const commandId = command.command_id || command.commandId || null
      removeQueuedCommand(targetArtifactId || artifactId, commandId)
      return true
    }

    const flushQueuedCommands = () => {
      if (typeof window === 'undefined') return
      const store = window.__hermesArtifactBridgeCommands
      if (!store || typeof store !== 'object') return
      const keys = artifactId ? [String(artifactId)] : ['__global__']
      keys.forEach((key) => {
        const queue = Array.isArray(store[key]) ? [...store[key]] : []
        queue.forEach((cmd) => {
          postCommandToIframe(cmd)
        })
      })
    }

    const handleWindowMessage = (event) => {
      const frame = iframeRef.current
      const target = frame?.contentWindow
      if (!target || event.source !== target) return
      if (src && event.origin !== window.location.origin) return
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'hermes:artifact-event') return
      const channel = String(data.channel || 'strudel')
      const eventName = String(data.event || '').trim()
      if (!eventName) return
      const payload = data.payload && typeof data.payload === 'object' ? data.payload : {}
      const requestId = data.requestId || data.request_id || null
      void fetch('/api/artifacts/bridge/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_id: artifactId || data.artifactId || data.artifact_id || null,
          channel,
          event: eventName,
          request_id: requestId,
          payload,
        }),
      }).catch(() => {
        // ignore relay failures for now
      })
    }

    const handleBridgeCommand = (event) => {
      const command = event?.detail
      if (!command || typeof command !== 'object') return
      postCommandToIframe(command)
    }

    window.addEventListener('message', handleWindowMessage)
    window.addEventListener('hermes-artifact-command', handleBridgeCommand)
    const timer = window.setTimeout(flushQueuedCommands, 0)

    return () => {
      window.removeEventListener('message', handleWindowMessage)
      window.removeEventListener('hermes-artifact-command', handleBridgeCommand)
      window.clearTimeout(timer)
    }
  }, [artifactId])

  useEffect(() => {
    const target = iframeRef.current?.contentWindow
    if (!target) return
    target.postMessage(themeMessage, targetOrigin)
  }, [themeMessage])

  return (
    <div style={{ padding: '12px 14px', height: '100%', minHeight: 360, boxSizing: 'border-box' }}>
      <iframe
        title={title}
        src={src || undefined}
        srcDoc={srcDoc || undefined}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        ref={iframeRef}
        onLoad={() => {
          try {
            const store = window.__hermesArtifactBridgeCommands
            const key = artifactId ? String(artifactId) : '__global__'
            const queue = store && typeof store === 'object' && Array.isArray(store[key]) ? [...store[key]] : []
            const target = iframeRef.current?.contentWindow
            if (!target) return
            target.postMessage(themeMessage, targetOrigin)
            queue.forEach((command) => {
              target.postMessage(
                {
                  type: 'hermes:artifact-command',
                  artifactId: artifactId || command.artifact_id || command.artifactId || null,
                  channel: command.channel || 'strudel',
                  command: command.command || command.action || '',
                  requestId: command.request_id || command.requestId || command.command_id || command.commandId || null,
                  payload: command.payload && typeof command.payload === 'object' ? command.payload : {},
                },
                targetOrigin,
              )
            })
            if (store && typeof store === 'object') {
              store[key] = []
            }
          } catch {
            // ignore
          }
        }}
        style={{
          width: '100%',
          minHeight: 360,
          height: '100%',
          border: `1px solid ${SLATE.border}`,
          borderRadius: 6,
          background: '#fff',
        }}
      />
    </div>
  )
}

function HtmlArtifact({ artifact }) {
  const data = artifact?.data || {}
  const html = typeof data?.html === 'string' ? data.html : typeof data?.srcdoc === 'string' ? data.srcdoc : ''
  if (!html) {
    return <ArtifactEmpty title="Invalid html artifact" detail="Expected data.html or data.srcdoc." />
  }
  return <HtmlLikeFrame title={artifact?.title || 'HTML artifact'} srcDoc={html} artifactId={artifact?.id || ''} />
}

function IframeArtifact({ artifact }) {
  const data = artifact?.data || {}
  const rawSrc = typeof data?.src === 'string' ? data.src : ''
  const srcDoc = typeof data?.srcdoc === 'string' ? data.srcdoc : ''
  const tabId = typeof artifact?.id === 'string' ? artifact.id : ''

  const isLocalRunner = useMemo(() => parseLocalRunnerSrc(rawSrc), [rawSrc])

  const [resolved, setResolved] = useState({ key: '', src: '' })
  const [error, setError] = useState({ key: '', msg: '' })

  const runnerKey = `${tabId || ''}:${rawSrc || ''}`
  const resolvedSrc = resolved?.key === runnerKey ? resolved.src : ''
  const errorMsg = error?.key === runnerKey ? error.msg : ''

  useEffect(() => {
    let cancelled = false

    if (!isLocalRunner || !tabId) {
      return () => {
        cancelled = true
      }
    }

    ;(async () => {
      try {
        const tok = await mintRunnerToken(tabId)
        const proxied = `${tok.basePath}${isLocalRunner.path}${isLocalRunner.search}${isLocalRunner.hash}`
        if (!cancelled) {
          setResolved({ key: runnerKey, src: proxied })
          setError({ key: runnerKey, msg: '' })
        }
      } catch (err) {
        const msg = err?.message ? String(err.message) : String(err)
        if (!cancelled) setError({ key: runnerKey, msg })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tabId, rawSrc, isLocalRunner, runnerKey])

  if (!rawSrc && !srcDoc) {
    return <ArtifactEmpty title="Invalid iframe artifact" detail="Expected data.src or data.srcdoc." />
  }

  if (isLocalRunner) {
    if (errorMsg) {
      return (
        <ArtifactEmpty
          title="Runner proxy unavailable"
          detail={`Failed to mint runner token for ${tabId || 'runner'}: ${errorMsg}`}
        />
      )
    }

    if (!resolvedSrc) {
      return <ArtifactEmpty title="Loading runner..." detail="Preparing secure proxy URL for this iframe runner." />
    }

    return <HtmlLikeFrame title={artifact?.title || 'Iframe runner'} src={resolvedSrc} srcDoc={srcDoc} artifactId={artifact?.id || ''} />
  }

  return <HtmlLikeFrame title={artifact?.title || 'Iframe artifact'} src={rawSrc} srcDoc={srcDoc} artifactId={artifact?.id || ''} />
}

function LogsArtifact({ artifact }) {
  const [filter, setFilter] = useState('all')
  const scrollRef = useRef(null)
  const data = useMemo(() => (artifact?.data && typeof artifact.data === 'object' ? artifact.data : {}), [artifact])
  const lines = useMemo(() => (Array.isArray(data?.lines) ? data.lines : []), [data])
  const follow = data?.follow !== false

  const filtered = useMemo(() => {
    if (filter === 'all') return lines
    return lines.filter((line) => String(line?.level || '').toLowerCase() === filter)
  }, [lines, filter])

  useEffect(() => {
    if (!follow) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [follow, filtered.length])

  if (!lines.length) {
    return <ArtifactEmpty title="No log lines" detail="Expected data.lines to contain log entries." />
  }

  const filters = ['all', 'error', 'warn', 'info', 'debug']

  return (
    <div
      style={{
        padding: '12px 14px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexShrink: 0 }}>
        {filters.map((name) => {
          const active = filter === name
          return (
            <button
              key={name}
              type="button"
              onClick={() => setFilter(name)}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                border: `1px solid ${active ? AMBER[600] : SLATE.border}`,
                background: active ? `${AMBER[900]}50` : 'transparent',
                color: active ? AMBER[400] : SLATE.muted,
                fontSize: 10,
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {name}
            </button>
          )
        })}
        <div style={{ flex: 1 }} />
        {follow ? <span style={{ fontSize: 10, color: SLATE.success }}>follow</span> : null}
      </div>

      <div
        ref={scrollRef}
        style={{
          border: `1px solid ${SLATE.border}`,
          borderRadius: 6,
          overflow: 'auto',
          flex: 1,
          minHeight: 0,
          background: `${SLATE.surface}cc`,
        }}
      >
        {filtered.map((line, index) => {
          const level = String(line?.level || '').toUpperCase()
          const source = line?.source || line?.src || line?.unit || ''
          const message = line?.msg || line?.message || ''
          return (
            <div
              key={`${artifact?.id || 'logs'}-${index}`}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                lineHeight: 1.6,
                borderBottom: `1px solid ${SLATE.border}10`,
                background: level === 'ERROR' ? `${SLATE.danger}08` : level === 'WARN' || level === 'WARNING' ? `${AMBER[900]}15` : 'transparent',
                display: 'flex',
                gap: 8,
              }}
            >
              <span style={{ color: SLATE.muted, flexShrink: 0 }}>{String(line?.ts || line?.time || '')}</span>
              <span style={{ color: levelColor(level), fontWeight: 600, flexShrink: 0, width: 48, fontSize: 10 }}>{level || 'INFO'}</span>
              {source ? (
                <span style={{ color: SLATE.purple, flexShrink: 0, minWidth: 80, fontSize: 10 }}>{String(source)}</span>
              ) : null}
              <span style={{ color: SLATE.text, wordBreak: 'break-word' }}>{String(message)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function chartSeriesData(data) {
  const xAxis = Array.isArray(data?.x_axis) ? data.x_axis : []
  const series = Array.isArray(data?.series) ? data.series : []
  const count = Math.max(xAxis.length, ...series.map((item) => Array.isArray(item?.values) ? item.values.length : 0), 0)
  const numericValues = series.flatMap((item) => (Array.isArray(item?.values) ? item.values : []).map((v) => Number(v)).filter((v) => Number.isFinite(v)))
  const min = numericValues.length ? Math.min(...numericValues, 0) : 0
  const max = numericValues.length ? Math.max(...numericValues, 1) : 1
  return { xAxis, series, count, min, max }
}

function ChartArtifact({ artifact }) {
  const data = useMemo(() => (artifact?.data && typeof artifact.data === 'object' ? artifact.data : {}), [artifact])
  const chartType = String(data?.chart_type || 'line').toLowerCase()
  const { xAxis, series, count, min, max } = useMemo(() => chartSeriesData(data), [data])

  if (!series.length || count <= 0) {
    return <ArtifactEmpty title="Invalid chart artifact" detail="Expected data.series and optionally data.x_axis." />
  }

  const width = 760
  const height = 300
  const pad = { top: 18, right: 16, bottom: 34, left: 34 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const range = max - min || 1

  const xForIndex = (index) => pad.left + (count <= 1 ? innerWidth / 2 : (index / (count - 1)) * innerWidth)
  const yForValue = (value) => pad.top + innerHeight - (((Number(value) - min) / range) * innerHeight)

  const xTickStep = Math.max(1, Math.ceil(count / 6))
  const yTicks = 4

  const renderLineSeries = (item) => {
    const values = Array.isArray(item?.values) ? item.values : []
    const color = item?.color || AMBER[400]
    const points = values.map((value, index) => `${xForIndex(index)},${yForValue(value)}`).join(' ')
    if (!points) return null

    if (chartType === 'area') {
      const areaPoints = `${xForIndex(0)},${pad.top + innerHeight} ${points} ${xForIndex(values.length - 1)},${pad.top + innerHeight}`
      return (
        <g key={item?.name || color}>
          <polyline points={areaPoints} fill={`${color}26`} stroke="none" />
          <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )
    }

    return <polyline key={item?.name || color} points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  }

  const renderBarSeries = () => {
    const barSeries = series
    const groups = Math.max(1, barSeries.length)
    const slotWidth = innerWidth / Math.max(1, count)
    const barWidth = Math.max(6, Math.min(26, (slotWidth * 0.72) / groups))
    return barSeries.flatMap((item, seriesIndex) => {
      const color = item?.color || AMBER[400]
      const values = Array.isArray(item?.values) ? item.values : []
      return values.map((value, index) => {
        const v = Number(value)
        if (!Number.isFinite(v)) return null
        const xBase = pad.left + index * slotWidth + (slotWidth - groups * barWidth) / 2
        const x = xBase + seriesIndex * barWidth
        const y = yForValue(v)
        const h = Math.max(2, pad.top + innerHeight - y)
        return <rect key={`${item?.name || 'series'}-${index}`} x={x} y={y} width={barWidth - 1} height={h} rx="2" fill={color} opacity="0.92" />
      })
    })
  }

  return (
    <div style={{ padding: '12px 14px' }}>
      {data?.title ? <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600, marginBottom: 10 }}>{String(data.title)}</div> : null}
      <div
        style={{
          border: `1px solid ${SLATE.border}`,
          borderRadius: 6,
          overflow: 'hidden',
          background: `${SLATE.surface}cc`,
          padding: '10px 10px 6px',
        }}
      >
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="300" role="img">
          <rect x="0" y="0" width={width} height={height} fill="transparent" />

          {Array.from({ length: yTicks + 1 }).map((_, index) => {
            const y = pad.top + (innerHeight / yTicks) * index
            const tickValue = max - (range / yTicks) * index
            return (
              <g key={`y-${index}`}>
                <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke={`${SLATE.border}aa`} strokeWidth="1" />
                <text x={pad.left - 8} y={y + 4} fill={SLATE.muted} fontSize="10" textAnchor="end">
                  {Math.round(tickValue)}
                </text>
              </g>
            )
          })}

          {Array.from({ length: count }).map((_, index) => {
            if (index % xTickStep !== 0 && index !== count - 1) return null
            const x = xForIndex(index)
            const label = xAxis[index] ?? String(index + 1)
            return (
              <g key={`x-${index}`}>
                <line x1={x} y1={pad.top} x2={x} y2={pad.top + innerHeight} stroke={`${SLATE.border}55`} strokeWidth="1" />
                <text x={x} y={height - 10} fill={SLATE.muted} fontSize="10" textAnchor="middle">
                  {String(label)}
                </text>
              </g>
            )
          })}

          {chartType === 'bar' ? renderBarSeries() : series.map(renderLineSeries)}
        </svg>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '4px 4px 0' }}>
          {series.map((item, index) => {
            const color = item?.color || AMBER[400]
            const name = item?.name || `series ${index + 1}`
            return (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: SLATE.text }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                <span>{String(name)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function markerBounds(markers) {
  const lats = markers.map((marker) => Number(marker?.lat)).filter((v) => Number.isFinite(v))
  const lngs = markers.map((marker) => Number(marker?.lng)).filter((v) => Number.isFinite(v))
  if (!lats.length || !lngs.length) return null
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  }
}

function MapArtifact({ artifact }) {
  const data = artifact?.data || {}
  const floorPlan = typeof data?.floor_plan === 'string' ? data.floor_plan : typeof data?.svg === 'string' ? data.svg : ''

  if (floorPlan) {
    return <HtmlLikeFrame title={artifact?.title || 'Map artifact'} srcDoc={floorPlan} />
  }

  const markers = Array.isArray(data?.markers) ? data.markers : []
  const bounds = markerBounds(markers)
  if (!markers.length || !bounds) {
    return <ArtifactEmpty title="Invalid map artifact" detail="Expected data.markers or data.floor_plan." />
  }

  const latRange = bounds.maxLat - bounds.minLat || 1
  const lngRange = bounds.maxLng - bounds.minLng || 1

  return (
    <div style={{ padding: '12px 14px' }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 10',
          background: `linear-gradient(180deg, ${SLATE.elevated}, ${SLATE.surface})`,
          borderRadius: 8,
          border: `1px solid ${SLATE.border}`,
          overflow: 'hidden',
        }}
      >
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
          {Array.from({ length: 12 }).map((_, index) => (
            <line key={`v-${index}`} x1={`${index * 9}%`} y1="0" x2={`${index * 9}%`} y2="100%" stroke={SLATE.muted} strokeWidth="0.5" />
          ))}
          {Array.from({ length: 8 }).map((_, index) => (
            <line key={`h-${index}`} x1="0" y1={`${index * 12.5}%`} x2="100%" y2={`${index * 12.5}%`} stroke={SLATE.muted} strokeWidth="0.5" />
          ))}
        </svg>

        {markers.map((marker, index) => {
          const lat = Number(marker?.lat)
          const lng = Number(marker?.lng)
          const left = ((lng - bounds.minLng) / lngRange) * 100
          const top = 100 - ((lat - bounds.minLat) / latRange) * 100
          const color = marker?.color || AMBER[400]
          return (
            <div
              key={`${artifact?.id || 'map'}-${index}`}
              style={{
                position: 'absolute',
                left: `${left}%`,
                top: `${top}%`,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
              }}
              title={`${marker?.label || 'marker'} (${lat}, ${lng})`}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: `0 0 10px ${color}66`,
                  border: `2px solid ${SLATE.surface}`,
                }}
              />
              {marker?.label ? (
                <span
                  style={{
                    fontSize: 10,
                    color: SLATE.textBright,
                    background: `${SLATE.surface}dd`,
                    border: `1px solid ${SLATE.border}`,
                    borderRadius: 4,
                    padding: '2px 6px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {String(marker.label)}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 10, color: SLATE.muted }}>
        <span title={formatTimestamp(artifact?.timestamp)}>updated {formatTimestamp(artifact?.timestamp) || 'unknown'}</span>
        {data?.center ? <span>{`center ${data.center.lat}, ${data.center.lng}`}</span> : null}
      </div>
    </div>
  )
}

export default function ArtifactRenderer({ artifact }) {
  const type = String(artifact?.type || '').toLowerCase()

  if (!artifact || typeof artifact !== 'object') {
    return <ArtifactEmpty title="No artifact selected" detail="Choose an artifact tab to inspect its content." />
  }

  switch (type) {
    case 'table':
      return <TableArtifact artifact={artifact} />
    case 'markdown':
      return <MarkdownArtifact artifact={artifact} />
    case 'html':
      return <HtmlArtifact artifact={artifact} />
    case 'iframe':
      return <IframeArtifact artifact={artifact} />
    case 'logs':
      return <LogsArtifact artifact={artifact} />
    case 'chart':
      return <ChartArtifact artifact={artifact} />
    case 'map':
      return <MapArtifact artifact={artifact} />
    default:
      return (
        <div>
          <ArtifactEmpty title="Unsupported artifact type" detail={`Type '${type || 'unknown'}' does not have a renderer yet.`} />
          <JsonPreview value={artifact} />
        </div>
      )
  }
}
