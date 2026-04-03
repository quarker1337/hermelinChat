import { useState } from 'react'
import { AMBER, SLATE } from '../../theme/index.js'
import { HighlightedSnippet } from '../shared/HighlightedSnippet'
import { isoToTimeLabel } from '../../utils/formatting'
import type { SearchHit } from '../../types'

interface SearchHitRowProps {
  hit: SearchHit
  active?: boolean
  onClick?: () => void
  showTimestamp?: boolean
}

export const SearchHitRow = ({
  hit,
  active = false,
  onClick,
  showTimestamp = true,
}: SearchHitRowProps) => {
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
          <HighlightedSnippet text={hit?.snippet || ''} />
        </div>
      </div>
    </div>
  )
}
