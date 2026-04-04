import { useState } from 'react'
import { AMBER, SLATE, hexToRgb } from '../../theme/index'

interface SessionRowProps {
  title: string
  preview?: React.ReactNode
  subtitle?: string | null
  subtitleTitle?: string
  right?: React.ReactNode | null
  active?: boolean
  onClick?: () => void
  onMenu?: (e: React.MouseEvent) => void
  menuOpen?: boolean
}

export const SessionRow = ({
  title,
  preview,
  subtitle,
  subtitleTitle,
  right,
  active = false,
  onClick,
  onMenu,
  menuOpen = false,
}: SessionRowProps) => {
  const [hovered, setHovered] = useState(false)
  const hasMenu = typeof onMenu === 'function'
  const showMenu = hasMenu && (hovered || menuOpen)
  const hasSubtitle = subtitle !== undefined && subtitle !== null && subtitle !== ''
  const subtitleMutedRgb = hexToRgb(SLATE.muted)
  const subtitleColor = subtitleMutedRgb
    ? `rgba(${subtitleMutedRgb.r}, ${subtitleMutedRgb.g}, ${subtitleMutedRgb.b}, 0.72)`
    : SLATE.muted

  const renderMenuButton = () => {
    if (!hasMenu) return null
    return (
      <div
        onClick={(e) => {
          e.stopPropagation()
          onMenu?.(e)
        }}
        title="Session actions"
        style={{
          width: 22,
          height: 18,
          borderRadius: 6,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: SLATE.muted,
          background: 'transparent',
          border: '1px solid transparent',
          opacity: showMenu ? 1 : 0,
          pointerEvents: showMenu ? 'auto' : 'none',
          transition: 'opacity 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
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
          e.currentTarget.style.color = SLATE.muted
        }}
      >
        ⋯
      </div>
    )
  }

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
      {hasSubtitle ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                color: active ? AMBER[400] : hovered ? SLATE.textBright : SLATE.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={title}
            >
              {title}
            </div>
            <div
              style={{
                marginTop: 3,
                fontSize: 10,
                color: subtitleColor,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={subtitleTitle || subtitle || undefined}
            >
              {subtitle}
            </div>
          </div>

          {(right || hasMenu) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {right && <div style={{ fontSize: 10, color: SLATE.muted, whiteSpace: 'nowrap' }}>{right}</div>}
              {renderMenuButton()}
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div
              style={{
                flex: 1,
                fontSize: 12,
                color: active ? AMBER[400] : hovered ? SLATE.textBright : SLATE.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={title}
            >
              {title}
            </div>

            {(right || hasMenu) && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexShrink: 0 }}>
                {right && <div style={{ fontSize: 10, color: SLATE.muted, whiteSpace: 'nowrap' }}>{right}</div>}
                {renderMenuButton()}
              </div>
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
        </>
      )}
    </div>
  )
}
