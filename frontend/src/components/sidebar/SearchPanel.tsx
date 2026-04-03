import { AMBER, SLATE } from '../../theme/index.js'
import { useSearchStore } from '../../stores/search'
import { useUiPrefsStore } from '../../stores/ui-prefs'
import { isoToTimeLabel } from '../../utils/formatting'
import { HighlightedSnippet } from '../shared/HighlightedSnippet'
import { SessionRow } from './SessionRow'
import { SearchHitRow } from './SearchHitRow'

export const SearchPanel = () => {
  const { query, results, searching, groups, expandedSessions, toggleSession, openPeek, peek } =
    useSearchStore()
  const prefs = useUiPrefsStore((s) => s.prefs)
  const peekHit = peek.hit

  return (
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

      {results.length === 0 && !searching && (
        <div style={{ padding: '8px 12px', fontSize: 11, color: SLATE.muted }}>No results</div>
      )}

      {groups.map((g) => {
        const isOpen = !!expandedSessions[g.session_id]
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
              right={prefs.timestamps.enabled ? isoToTimeLabel(top?.timestamp_iso) : null}
              active={peekHit?.session_id === g.session_id}
              onClick={() => toggleSession(g.session_id)}
            />

            {isOpen && (
              <div style={{ marginTop: 2 }}>
                {g.hits.map((hit) => (
                  <SearchHitRow
                    key={hit.id}
                    hit={hit}
                    active={peekHit?.id === hit.id}
                    showTimestamp={prefs.timestamps.enabled}
                    onClick={() => openPeek(hit)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
