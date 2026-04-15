import { useState } from 'react'
import { AMBER, SLATE } from '../../theme/index'
import { useAuthStore } from '../../stores/auth'
import { useSearchStore } from '../../stores/search'
import { useUiPrefsStore } from '../../stores/ui-prefs'
import { LogoutIcon, PlusIcon, SettingsIcon } from '../shared/icons'
import { SidebarHeader } from './SidebarHeader'
import { SessionList } from './SessionList'
import { SearchPanel } from './SearchPanel'
import { PeekDrawer } from './PeekDrawer'
import type { Session, SessionMenu } from '../../types'

interface SidebarProps {
  onOpenSettings: () => void
  onOpenSessionMenu: (session: Session, e: React.MouseEvent) => void
  onResumeSession: (session: Session) => void
  onNewSession: () => void
  sessionMenu: SessionMenu | null
  updateAvailable?: boolean
}

export const Sidebar = ({
  onOpenSettings,
  onOpenSessionMenu,
  onResumeSession,
  onNewSession,
  sessionMenu,
  updateAvailable = false,
}: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(false)

  const auth = useAuthStore()
  const { query, setQuery, searching, closePeek, openPeek, peek } = useSearchStore()
  const prefs = useUiPrefsStore((s) => s.prefs)

  const searchActive = !!(query || '').trim()

  return (
    <>
      <div
        style={{
          width: collapsed ? 64 : 290,
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
        <SidebarHeader
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          onOpenSettings={onOpenSettings}
          updateAvailable={updateAvailable}
        />

        {/* Collapsed icon strip */}
        {collapsed && (
          <div
            style={{
              padding: '12px 0',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <button
              className="hm-btn"
              onClick={onNewSession}
              aria-label={auth.authenticated ? 'New session' : 'Login required'}
              title={auth.authenticated ? 'New session' : 'Login required'}
              disabled={!auth.authenticated}
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
            </button>

            <button
              className="hm-btn"
              onClick={onOpenSettings}
              aria-label="Settings"
              title="Settings"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: SLATE.muted,
                background: 'transparent',
                border: '1px solid transparent',
                transition: 'all 0.15s ease',
                userSelect: 'none',
                position: 'relative',
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
              {updateAvailable && (
                <div style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: AMBER[400],
                }} />
              )}
            </button>
          </div>
        )}

        {/* Expanded content */}
        {!collapsed && (
          <>
            {/* Search input */}
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
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
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
                {!!query && auth.authenticated && (
                  <span
                    onClick={() => setQuery('')}
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

            {/* Session list or search results */}
            {auth.authenticated && searchActive ? (
              <div style={{ flex: 1, overflow: 'auto', padding: '4px 6px' }}>
                <SearchPanel />
              </div>
            ) : (
              <SessionList
                authenticated={auth.authenticated}
                onNewSession={onNewSession}
                onResumeSession={onResumeSession}
                onOpenSessionMenu={onOpenSessionMenu}
                sessionMenu={sessionMenu}
              />
            )}

            {/* Auth section */}
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
                  onClick={() => auth.logout()}
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

        {/* Collapsed spacer + logout */}
        {collapsed && <div style={{ flex: 1 }} />}

        {collapsed && (
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
                onClick={() => auth.logout()}
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

      {/* Peek Drawer — rendered adjacent to sidebar in the flex row */}
      {peek.open && (
        <PeekDrawer
          loading={peek.loading}
          error={peek.error}
          context={peek.context}
          hit={peek.hit}
          onClose={closePeek}
          onOpenSession={(sid) => {
            const s = { id: sid } as Session
            onResumeSession(s)
            closePeek()
          }}
        />
      )}
    </>
  )
}
