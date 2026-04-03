import { AMBER, SLATE } from '../../theme/index.js'
import { useSessionStore } from '../../stores/sessions'
import { useSearchStore } from '../../stores/search'
import { useUiPrefsStore } from '../../stores/ui-prefs'
import { isoToRelativeLabel, isoToLocalLabel } from '../../utils/formatting'
import { PlusIcon } from '../shared/icons'
import { SidebarItem } from '../shared/SidebarItem'
import { SessionRow } from './SessionRow'
import type { Session, SessionMenu } from '../../types'

interface SessionListProps {
  authenticated: boolean
  onNewSession: () => void
  onResumeSession: (session: Session) => void
  onOpenSessionMenu: (session: Session, e: React.MouseEvent) => void
  sessionMenu: SessionMenu | null
}

export const SessionList = ({
  authenticated,
  onNewSession,
  onResumeSession,
  onOpenSessionMenu,
  sessionMenu,
}: SessionListProps) => {
  const { grouped, activeSessionId } = useSessionStore()
  const { setQuery, closePeek } = useSearchStore()
  const prefs = useUiPrefsStore((s) => s.prefs)

  const groups = ['Today', 'Yesterday', 'Earlier'] as const

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '4px 6px', opacity: authenticated ? 1 : 0.4 }}>
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
        onClick={onNewSession}
      />

      {authenticated &&
        groups.map((k) => {
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
                  subtitle={prefs.timestamps.enabled ? isoToRelativeLabel(s.started_at_iso) : null}
                  subtitleTitle={prefs.timestamps.enabled ? isoToLocalLabel(s.started_at_iso) : undefined}
                  active={activeSessionId === s.id}
                  menuOpen={sessionMenu?.session_id === s.id}
                  onMenu={(e) => onOpenSessionMenu(s, e)}
                  onClick={() => {
                    setQuery('')
                    onResumeSession(s)
                    closePeek()
                  }}
                />
              ))}
            </div>
          )
        })}
    </div>
  )
}
