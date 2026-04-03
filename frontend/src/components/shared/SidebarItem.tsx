import { useState } from 'react'
import { AMBER, SLATE } from '../../theme/index.js'

interface SidebarItemProps {
  label: string
  active?: boolean
  onClick?: () => void
}

export const SidebarItem = ({ label, active, onClick }: SidebarItemProps) => {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: "'JetBrains Mono',monospace",
        color: active ? AMBER[400] : hovered ? SLATE.textBright : SLATE.muted,
        background: active ? `${AMBER[900]}40` : hovered ? `${SLATE.elevated}` : 'transparent',
        borderLeft: active ? `2px solid ${AMBER[400]}` : '2px solid transparent',
        transition: 'all 0.15s ease',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  )
}
