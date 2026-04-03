import { SLATE } from '../../theme/index.js'
import type { SessionMenu } from '../../types'

interface SessionContextMenuProps {
  menu: SessionMenu
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}

export const SessionContextMenu = ({
  menu,
  onRename,
  onDelete,
  onClose,
}: SessionContextMenuProps) => {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: menu.top,
          left: menu.left,
          width: 180,
          border: `1px solid ${SLATE.border}`,
          background: SLATE.surface,
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
        }}
      >
        <div
          onClick={onRename}
          style={{
            padding: '10px 12px',
            fontSize: 12,
            color: SLATE.textBright,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = SLATE.elevated
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          Change title
        </div>
        <div
          onClick={onDelete}
          style={{
            padding: '10px 12px',
            fontSize: 12,
            color: SLATE.danger,
            cursor: 'pointer',
            userSelect: 'none',
            borderTop: `1px solid ${SLATE.border}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = SLATE.elevated
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
        >
          Delete
        </div>
      </div>
    </div>
  )
}
