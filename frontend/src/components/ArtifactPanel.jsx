import ArtifactRenderer from './artifacts/ArtifactRenderer.jsx'
import { AMBER, SLATE, formatTimeAgo, formatTimestamp } from './artifacts/theme.js'

function IconButton({ title, onClick, children, active = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 2,
        border: 0,
        background: 'transparent',
        color: active ? AMBER[400] : SLATE.muted,
      }}
    >
      {children}
    </button>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

function PinIcon({ pinned }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 17v5" />
      <path d="M5 17h14" />
      <path d="M15 3.36C15 2.61 14.39 2 13.64 2H10.36C9.61 2 9 2.61 9 3.36V6l-3 5h12L15 6V3.36z" />
    </svg>
  )
}

export default function ArtifactPanel({
  artifacts,
  activeArtifactId,
  pinned,
  onSelectArtifact,
  onClose,
  onRefresh,
  onTogglePinned,
  onDeleteArtifact,
}) {
  const activeArtifact = artifacts.find((artifact) => artifact?.id === activeArtifactId) || artifacts[0] || null

  return (
    <div
      style={{
        width: 480,
        flexShrink: 0,
        borderLeft: `1px solid ${SLATE.border}`,
        background: `${SLATE.surface}f2`,
        position: 'relative',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minWidth: 0,
        animation: 'artifactPanelSlide 0.25s cubic-bezier(0.16,1,0.3,1) both',
      }}
    >
      <style>{`
        @keyframes artifactPanelSlide {
          from { transform: translateX(20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes artifactLivePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>

      <div
        style={{
          padding: '10px 12px',
          borderBottom: `1px solid ${SLATE.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: `${SLATE.surface}ff`,
        }}
      >
        <div style={{ fontSize: 11, color: AMBER[400], fontWeight: 700 }}>artifact</div>
        <div style={{ fontSize: 10, color: SLATE.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeArtifact?.title || 'panel'}
        </div>
        <div style={{ flex: 1 }} />
        <IconButton title={pinned ? 'Unpin panel' : 'Pin panel'} onClick={onTogglePinned} active={pinned}>
          <PinIcon pinned={pinned} />
        </IconButton>
        <IconButton title="Refresh artifacts" onClick={onRefresh}>
          <RefreshIcon />
        </IconButton>
        <IconButton title="Hide panel" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <div style={{ display: 'flex', borderBottom: `1px solid ${SLATE.border}`, padding: '0 8px', flexShrink: 0, overflowX: 'auto' }}>
        {artifacts.map((artifact) => {
          const active = activeArtifact?.id === artifact?.id
          return (
            <button
              key={artifact?.id || artifact?.title}
              type="button"
              onClick={() => onSelectArtifact?.(artifact?.id)}
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: active ? AMBER[400] : SLATE.muted,
                border: 0,
                borderBottom: active ? `2px solid ${AMBER[400]}` : '2px solid transparent',
                background: 'transparent',
                fontFamily: "'JetBrains Mono', monospace",
                maxWidth: 180,
                flexShrink: 0,
              }}
              title={artifact?.title || artifact?.id}
            >
              {artifact?.live ? (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: SLATE.success,
                    animation: 'artifactLivePulse 2s ease infinite',
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact?.title || artifact?.id}</span>
              <span style={{ color: SLATE.muted, fontSize: 9 }}>{artifact?.type}</span>
              {onDeleteArtifact ? (
                <span
                  onClick={(event) => {
                    event.stopPropagation()
                    onDeleteArtifact(artifact?.id)
                  }}
                  style={{ color: SLATE.muted, fontSize: 12, lineHeight: 1 }}
                  title="Remove artifact"
                >
                  ×
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div
        style={{
          padding: '6px 14px',
          borderBottom: `1px solid ${SLATE.border}10`,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          color: SLATE.muted,
        }}
      >
        <span>via</span>
        <span style={{ color: AMBER[600], fontWeight: 500 }}>{activeArtifact?.source || 'render_panel'}</span>
        <span>·</span>
        <span>{activeArtifact?.type || 'artifact'}</span>
        {activeArtifact?.task_id ? (
          <>
            <span>·</span>
            <span title={String(activeArtifact.task_id)} style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              task {String(activeArtifact.task_id)}
            </span>
          </>
        ) : null}
        <div style={{ flex: 1 }} />
        {activeArtifact?.live ? (
          <span style={{ color: SLATE.success, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: SLATE.success, animation: 'artifactLivePulse 2s ease infinite' }} />
            live
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {activeArtifact ? (
          <ArtifactRenderer artifact={activeArtifact} />
        ) : (
          <div style={{ padding: '18px 16px', fontSize: 12, color: SLATE.muted }}>
            No artifacts yet. Ask Hermes to call <span style={{ color: AMBER[400] }}>render_panel</span>.
          </div>
        )}
      </div>

      <div
        style={{
          padding: '6px 14px',
          borderTop: `1px solid ${SLATE.border}`,
          fontSize: 10,
          color: SLATE.muted,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span title={formatTimestamp(activeArtifact?.timestamp)}>
          updated {formatTimeAgo(activeArtifact?.timestamp)}
        </span>
        <span>
          {activeArtifact?.live ? `auto-refresh: ${Math.max(0, Number(activeArtifact?.refresh_seconds || 0))}s` : 'manual refresh'}
        </span>
      </div>
    </div>
  )
}
