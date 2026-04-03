import { AMBER, SLATE } from '../../theme/index.js'
import { HighlightedSnippet } from '../shared/HighlightedSnippet'
import { formatModelLabel, isoToLocalLabel } from '../../utils/formatting'
import type { SearchHit, PeekContext } from '../../types'

interface PeekDrawerProps {
  loading: boolean
  error: string
  context: PeekContext | null
  hit: SearchHit | null
  onClose: () => void
  onOpenSession?: (sid: string) => void
}

export const PeekDrawer = ({
  loading,
  error,
  context,
  hit,
  onClose,
  onOpenSession,
}: PeekDrawerProps) => {
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
