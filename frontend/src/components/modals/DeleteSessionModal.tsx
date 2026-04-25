import { useState } from 'react'
import { AMBER, SLATE } from '../../theme/index'

interface DeleteSessionModalProps {
  session: { id: string; title: string }
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

export const DeleteSessionModal = ({ session, onDelete, onClose }: DeleteSessionModalProps) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const close = () => {
    if (busy) return
    onClose()
  }

  const doDelete = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onDelete(session.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg || 'delete failed')
      setBusy(false)
    }
  }

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          border: `1px solid ${SLATE.border}`,
          background: SLATE.surface,
          padding: 16,
          boxShadow: `0 0 30px ${AMBER[900]}55`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ color: SLATE.danger, fontWeight: 700, fontSize: 12 }}>Delete session</div>
          <div style={{ flex: 1 }} />
          <div
            onClick={close}
            style={{
              fontSize: 11,
              color: SLATE.muted,
              cursor: busy ? 'default' : 'pointer',
              userSelect: 'none',
              opacity: busy ? 0.4 : 1,
            }}
            title="Close"
          >
            close
          </div>
        </div>

        <div style={{ color: SLATE.muted, fontSize: 11, marginBottom: 10, lineHeight: 1.45 }}>
          This will permanently delete the session from Hermes history. This cannot be undone.
        </div>

        <div style={{ color: SLATE.muted, fontSize: 11, marginBottom: 10 }}>
          Session: <span style={{ color: AMBER[500] }}>{session.id}</span>
        </div>

        <div
          style={{
            color: SLATE.textBright,
            fontSize: 11,
            padding: '10px 10px',
            border: `1px solid ${SLATE.border}`,
            background: SLATE.elevated,
            marginBottom: 10,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={session.title}
        >
          {session.title}
        </div>

        {error && <div style={{ color: SLATE.danger, fontSize: 11, marginTop: 8 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 12, justifyContent: 'flex-end' }}>
          <div
            onClick={close}
            style={{
              padding: '9px 12px',
              border: `1px solid ${SLATE.border}`,
              background: SLATE.elevated,
              color: SLATE.muted,
              cursor: busy ? 'default' : 'pointer',
              fontSize: 12,
              userSelect: 'none',
              opacity: busy ? 0.4 : 1,
            }}
          >
            cancel
          </div>
          <div
            onClick={doDelete}
            style={{
              padding: '9px 12px',
              border: `1px solid ${SLATE.danger}`,
              background: `${SLATE.danger}22`,
              color: SLATE.danger,
              cursor: busy ? 'default' : 'pointer',
              fontSize: 12,
              userSelect: 'none',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'deleting…' : 'delete'}
          </div>
        </div>
      </div>
    </div>
  )
}
