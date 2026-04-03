import { useState, type ReactNode } from 'react'
import { AMBER, SLATE } from '../../theme/index'

interface CollapsiblePanelProps {
  title: string
  open?: boolean
  onToggle?: (next: boolean) => void
  defaultOpen?: boolean
  dense?: boolean
  children?: ReactNode
}

export const CollapsiblePanel = ({
  title,
  open: openProp,
  onToggle,
  defaultOpen = false,
  dense = false,
  children,
}: CollapsiblePanelProps) => {
  const [openState, setOpenState] = useState(defaultOpen)
  const controlled = typeof openProp === 'boolean'
  const open = controlled ? openProp : openState

  const headerPad = dense ? '8px 10px' : '10px 12px'
  const bodyPad = dense ? '8px 10px 10px 22px' : '10px 12px 12px 22px'
  const fs = dense ? 11 : 12

  const toggle = () => {
    const next = !open
    if (!controlled) setOpenState(next)
    onToggle?.(next)
  }

  return (
    <div
      style={{
        border: `1px solid ${SLATE.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: SLATE.surface,
      }}
    >
      <div
        onClick={toggle}
        style={{
          padding: headerPad,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          userSelect: 'none',
          color: SLATE.textBright,
          fontSize: fs,
          fontWeight: 600,
          background: open ? SLATE.elevated : 'transparent',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = SLATE.elevated
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? SLATE.elevated : 'transparent'
        }}
      >
        <span style={{ color: open ? AMBER[400] : SLATE.muted }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>{title}</span>
      </div>

      {open && <div style={{ padding: bodyPad }}>{children}</div>}
    </div>
  )
}
