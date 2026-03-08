import { useEffect, useRef, useState } from 'react'

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

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="10" x2="12" y2="16" />
      <circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function MaximizeIcon({ maximized }) {
  if (maximized) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 3 3 3 3 9" />
        <polyline points="15 21 21 21 21 15" />
        <line x1="3" y1="3" x2="10" y2="10" />
        <line x1="21" y1="21" x2="14" y2="14" />
      </svg>
    )
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
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

function ChevronDownIcon({ open = false }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.12s ease',
        flexShrink: 0,
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function ArtifactTabIcon({ type }) {
  const kind = String(type || '').toLowerCase()

  if (kind === 'table') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <line x1="9" y1="4" x2="9" y2="20" />
        <line x1="15" y1="4" x2="15" y2="20" />
      </svg>
    )
  }

  if (kind === 'chart') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 4 4 5-6" />
      </svg>
    )
  }

  if (kind === 'logs') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <circle cx="4" cy="6" r="1" />
        <circle cx="4" cy="12" r="1" />
        <circle cx="4" cy="18" r="1" />
      </svg>
    )
  }

  if (kind === 'markdown') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
      </svg>
    )
  }

  if (kind === 'html') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    )
  }

  if (kind === 'iframe') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="14" height="14" rx="2" />
        <path d="M14 3h7v7" />
        <path d="M21 3l-9 9" />
      </svg>
    )
  }

  if (kind === 'map') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10c0 6-9 13-9 13S3 16 3 10a9 9 0 1 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    )
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  )
}

export default function ArtifactPanel({
  width = 480,
  onResizeWidth,
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

  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const restoreWidthRef = useRef(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const infoTitle = (() => {
    if (!activeArtifact) return 'No active artifact'

    const scope = activeArtifact?.persistent ? 'persistent' : 'session'
    const created = activeArtifact?.created_at || activeArtifact?.timestamp
    const updated = activeArtifact?.updated_at || activeArtifact?.timestamp
    const source = activeArtifact?.source || 'create_artifact'

    return [
      `source: ${source}`,
      `type: ${activeArtifact?.type || 'artifact'}`,
      `tab id: ${activeArtifact?.id || ''}`,
      `scope: ${scope}`,
      `created: ${formatTimestamp(created) || 'unknown'}`,
      `updated: ${formatTimestamp(updated) || 'unknown'}`,
    ].join('\n')
  })()

  useEffect(() => {
    if (!tabMenuOpen) return

    const handlePointerDown = (event) => {
      const target = event.target
      if (menuRef.current && menuRef.current.contains(target)) return
      if (triggerRef.current && triggerRef.current.contains(target)) return
      setTabMenuOpen(false)
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setTabMenuOpen(false)
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('touchstart', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('touchstart', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [tabMenuOpen])

  const resizeCleanupRef = useRef(null)

  useEffect(() => {
    return () => {
      try {
        resizeCleanupRef.current?.()
      } catch {
        // ignore
      }
    }
  }, [])

  const handleResizePointerDown = (event) => {
    if (!onResizeWidth) return
    if (typeof window === 'undefined') return

    // Only left-click drags (but keep touch/pens working).
    if (event.pointerType === 'mouse' && event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()

    try {
      resizeCleanupRef.current?.()
    } catch {
      // ignore
    }

    const handleEl = event.currentTarget
    const pointerId = event.pointerId

    try {
      handleEl?.setPointerCapture?.(pointerId)
    } catch {
      // ignore
    }

    const startX = event.clientX
    const startWidth = Number(width) || 480

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    // Prevent iframe interactions from eating pointerup.
    try {
      document.body.classList.add('artifactPanel--resizing')
    } catch {
      // ignore
    }

    let raf = null

    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('blur', cleanup)

      if (raf) cancelAnimationFrame(raf)

      try {
        handleEl?.releasePointerCapture?.(pointerId)
      } catch {
        // ignore
      }

      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect

      try {
        document.body.classList.remove('artifactPanel--resizing')
      } catch {
        // ignore
      }

      resizeCleanupRef.current = null
    }

    const handleMove = (moveEvent) => {
      // If we somehow miss pointerup (e.g. released outside window / iframe weirdness),
      // stop resizing as soon as the pointer is no longer pressed.
      if (typeof moveEvent.buttons === 'number' && moveEvent.buttons === 0) {
        cleanup()
        return
      }

      const dx = startX - moveEvent.clientX
      const next = startWidth + dx

      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = null
        onResizeWidth(next)
      })
    }

    resizeCleanupRef.current = cleanup

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('blur', cleanup)
  }

  return (
    <div
      style={{
        width: Number(width) || 480,
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

        @keyframes artifactTabMenuDrop {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .artifactTabDropdown__trigger:hover {
          background: ${SLATE.elevated};
        }

        .artifactTabDropdown__item:hover {
          background: ${SLATE.elevated};
        }

        .artifactTabDropdown__close:hover {
          color: ${SLATE.danger};
        }

        .artifactPanelResizeHandle:hover {
          background: ${SLATE.border}55;
        }

        .artifactPanelResizeHandle:active {
          background: ${AMBER[900]}35;
        }

        body.artifactPanel--resizing iframe {
          pointer-events: none;
        }
      `}</style>

      {onResizeWidth ? (
        <button
          type="button"
          onPointerDown={handleResizePointerDown}
          title="Drag to resize"
          aria-label="Resize artifact panel"
          className="artifactPanelResizeHandle"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 12,
            cursor: 'col-resize',
            zIndex: 60,
            touchAction: 'none',
            border: 0,
            padding: 0,
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            outline: 'none',
          }}
        >
          <div
            style={{
              width: 3,
              height: 42,
              borderRadius: 999,
              background: `${SLATE.border}aa`,
              boxShadow: `0 0 0 1px ${SLATE.surface}ff`,
            }}
          />
        </button>
      ) : null}

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
        <div
          style={{
            fontSize: 12,
            color: SLATE.textBright,
            fontWeight: 650,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={activeArtifact?.title || activeArtifact?.id || ''}
        >
          {activeArtifact?.title || activeArtifact?.id || 'Artifacts'}
        </div>
        <div style={{ flex: 1 }} />
        <IconButton title={pinned ? 'Unpin panel' : 'Pin panel'} onClick={onTogglePinned} active={pinned}>
          <PinIcon pinned={pinned} />
        </IconButton>
        <IconButton title="Refresh artifacts" onClick={onRefresh}>
          <RefreshIcon />
        </IconButton>
        <IconButton
          title={infoTitle}
          onClick={() => {
            try {
              globalThis?.navigator?.clipboard?.writeText?.(infoTitle)
            } catch {
              // ignore
            }
          }}
        >
          <InfoIcon />
        </IconButton>
        <IconButton
          title={maximized ? 'Restore panel size' : 'Maximize panel'}
          onClick={() => {
            if (!onResizeWidth) return
            const current = Number(width) || 480

            if (!maximized) {
              restoreWidthRef.current = current
              onResizeWidth(960)
              setMaximized(true)
              return
            }

            const restore = Number(restoreWidthRef.current) || 480
            restoreWidthRef.current = null
            onResizeWidth(restore)
            setMaximized(false)
          }}
          active={maximized}
        >
          <MaximizeIcon maximized={maximized} />
        </IconButton>
        <IconButton title="Close panel" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <div style={{ position: 'relative', flexShrink: 0, borderBottom: `1px solid ${SLATE.border}` }}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setTabMenuOpen((open) => !open)}
          className="artifactTabDropdown__trigger"
          style={{
            width: '100%',
            padding: '9px 12px',
            cursor: 'pointer',
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: SLATE.text,
            border: 0,
            background: `${SLATE.surface}ff`,
            fontFamily: "'JetBrains Mono', monospace",
            textAlign: 'left',
          }}
          title={activeArtifact?.title || activeArtifact?.id}
        >
          <span style={{ color: AMBER[400], display: 'flex', alignItems: 'center' }}>
            <ArtifactTabIcon type={activeArtifact?.type} />
          </span>
          {activeArtifact?.live ? (
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
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: SLATE.textBright,
              fontWeight: 500,
            }}
          >
            {activeArtifact?.title || activeArtifact?.id || 'panel'}
          </span>
          <span
            style={{
              flexShrink: 0,
              fontSize: 9,
              color: SLATE.muted,
              border: `1px solid ${SLATE.border}`,
              padding: '1px 7px',
              borderRadius: 999,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {artifacts.length} tab{artifacts.length === 1 ? '' : 's'}
          </span>
          <span style={{ color: SLATE.muted, display: 'flex', alignItems: 'center' }}>
            <ChevronDownIcon open={tabMenuOpen} />
          </span>
        </button>

        {tabMenuOpen ? (
          <div
            ref={menuRef}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 10,
              right: 10,
              border: `1px solid ${SLATE.border}`,
              background: `${SLATE.surface}ff`,
              borderRadius: 8,
              boxShadow: '0 12px 28px rgba(0,0,0,0.55)',
              padding: 6,
              zIndex: 50,
              maxHeight: 320,
              overflowY: 'auto',
              animation: 'artifactTabMenuDrop 0.12s ease both',
            }}
          >
            {artifacts.map((artifact) => {
              const active = activeArtifact?.id === artifact?.id
              const title = artifact?.title || artifact?.id || 'artifact'
              const type = artifact?.type || 'artifact'

              return (
                <button
                  key={artifact?.id || artifact?.title}
                  type="button"
                  onClick={() => {
                    onSelectArtifact?.(artifact?.id)
                    setTabMenuOpen(false)
                  }}
                  className="artifactTabDropdown__item"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    border: 0,
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: active ? `${AMBER[900]}35` : 'transparent',
                    color: active ? AMBER[300] : SLATE.text,
                    fontFamily: "'JetBrains Mono', monospace",
                    textAlign: 'left',
                    borderLeft: active ? `2px solid ${AMBER[400]}` : `2px solid transparent`,
                  }}
                  title={title}
                >
                  <span style={{ color: active ? AMBER[400] : SLATE.muted, display: 'flex', alignItems: 'center' }}>
                    <ArtifactTabIcon type={type} />
                  </span>
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
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                    }}
                  >
                    {title}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 9,
                      color: SLATE.muted,
                      border: `1px solid ${SLATE.border}`,
                      padding: '1px 6px',
                      borderRadius: 999,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {String(type)}
                  </span>
                  {onDeleteArtifact ? (
                    <span
                      className="artifactTabDropdown__close"
                      onClick={(event) => {
                        event.stopPropagation()
                        onDeleteArtifact(artifact?.id)
                      }}
                      style={{
                        color: SLATE.muted,
                        fontSize: 14,
                        lineHeight: 1,
                        padding: '0 4px',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                      title="Close tab"
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {activeArtifact ? (
          <ArtifactRenderer artifact={activeArtifact} />
        ) : (
          <div style={{ padding: '18px 16px', fontSize: 12, color: SLATE.muted }}>
            No artifacts yet. Ask Hermes to call <span style={{ color: AMBER[400] }}>create_artifact</span>.
          </div>
        )}
      </div>

      <div
        style={{
          padding: '5px 14px',
          borderTop: `1px solid ${SLATE.border}`,
          fontSize: 9,
          color: `${SLATE.muted}cc`,
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
