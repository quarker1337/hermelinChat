import { AMBER, SLATE } from '../../theme/index'
import { SidebarDockIcon, SettingsIcon } from '../shared/icons'
import { useUiPrefsStore } from '../../stores/ui-prefs'

interface SidebarHeaderProps {
  collapsed: boolean
  onToggleCollapse: () => void
  onOpenSettings: () => void
  updateAvailable?: boolean
}

export const SidebarHeader = ({
  collapsed,
  onToggleCollapse,
  onOpenSettings,
  updateAvailable = false,
}: SidebarHeaderProps) => {
  const appNameLabel = useUiPrefsStore((s) => s.appNameLabel)

  return (
    <div
      style={{
        padding: collapsed ? '14px 8px 12px' : '14px 14px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between',
        borderBottom: `1px solid ${SLATE.border}`,
      }}
    >
      {!collapsed && (
        <div
          title={appNameLabel}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: SLATE.text,
            opacity: 0.68,
            letterSpacing: '0.02em',
            userSelect: 'none',
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {appNameLabel}
        </div>
      )}

      {collapsed ? (
        <button
          className="hm-btn"
          onClick={onToggleCollapse}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
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
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="hm-btn"
            onClick={onOpenSettings}
            aria-label="Settings"
            title="Settings"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: SLATE.muted,
              userSelect: 'none',
              position: 'relative',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = AMBER[400])}
            onMouseLeave={(e) => (e.currentTarget.style.color = SLATE.muted)}
          >
            <SettingsIcon />
            {updateAvailable && (
              <div style={{
                position: 'absolute',
                top: -2,
                right: -2,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: AMBER[400],
              }} />
            )}
          </button>
          <button
            className="hm-btn"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
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
          </button>
        </div>
      )}
    </div>
  )
}
