import { useCallback, useEffect, useRef, useState } from 'react'
import { AMBER, SLATE } from '../theme/index'

// ─── Stores ────────────────────────────────────────────────────────
import { useAuthStore } from '../stores/auth'
import { useSessionStore } from '../stores/sessions'
import { useTerminalStore, selectConnected } from '../stores/terminal'
import { useArtifactStore } from '../stores/artifacts'
import { useSearchStore } from '../stores/search'
import { useVideoFxStore } from '../stores/video-fx'
import { useUiPrefsStore } from '../stores/ui-prefs'
import { useToastStore } from '../stores/toast'

// ─── Utils ─────────────────────────────────────────────────────────
import { formatModelLabel } from '../utils/formatting'

// ─── Components ────────────────────────────────────────────────────
import { Sidebar } from './sidebar/Sidebar'
import { BackgroundRenderer } from './backgrounds/BackgroundRenderer'
import TerminalPane from './terminal/TerminalPane'
import { AlignmentEasterEgg } from './AlignmentEasterEgg'
import { InlineSvgIcon } from './shared/icons'
import { SettingsPanel } from './settings/SettingsPanel'
import { LoginScreen } from './modals/LoginScreen'
import { SessionContextMenu } from './modals/SessionContextMenu'
import { RenameSessionModal } from './modals/RenameSessionModal'
import { DeleteSessionModal } from './modals/DeleteSessionModal'

// Still .jsx — will be converted in Task 18
import ArtifactPanel from './ArtifactPanel.jsx'
import VideoFxOverlay from './VideoFxOverlay.jsx'

// ─── Types ─────────────────────────────────────────────────────────
import type { Session, SessionMenu } from '../types'

// ===================================================================
// AppShell — composition root
//
// Replaces the monolithic App() function from App.jsx. Reads all
// zustand stores, owns shell-local UI state (modals, settings), and
// composes extracted components into the full layout.
// ===================================================================

export function AppShell() {
  // ─── Store reads ──────────────────────────────────────────────────
  const authLoading = useAuthStore((s) => s.loading)
  const authEnabled = useAuthStore((s) => s.enabled)
  const authenticated = useAuthStore((s) => s.authenticated)

  const activeSession = useSessionStore((s) => s.activeSession)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const runtimeInfo = useSessionStore((s) => s.runtimeInfo)

  const connected = useTerminalStore(selectConnected)

  const artifactPanelOpen = useArtifactStore((s) => s.panelOpen)
  const artifactPanelWidth = useArtifactStore((s) => s.panelWidth)
  const artifactTabs = useArtifactStore((s) => s.tabs)
  const activeArtifactId = useArtifactStore((s) => s.activeId)

  const videoFxFilter = useVideoFxStore((s) => s.filter)
  const videoFxTransform = useVideoFxStore((s) => s.transform)
  const videoFxEnabled = useVideoFxStore((s) => s.enabled)
  const videoFxFactor = useVideoFxStore((s) => s.factor)
  const videoFxGlitchNow = useVideoFxStore((s) => s.glitchNow)
  const videoFxGlitchSeed = useVideoFxStore((s) => s.glitchSeed)

  const activeTheme = useUiPrefsStore((s) => s.activeTheme)
  const prefs = useUiPrefsStore((s) => s.prefs)

  // ─── Derived ──────────────────────────────────────────────────────
  const locked = !authLoading && authEnabled && !authenticated

  const currentModelRaw = activeSession?.model || runtimeInfo.defaultModel || null
  const currentModel = formatModelLabel(currentModelRaw)
  const currentCwd = runtimeInfo.spawnCwd || null

  // ─── Shell-local state ────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionMenu, setSessionMenu] = useState<SessionMenu | null>(null)
  const [renameSession, setRenameSession] = useState<{ id: string; title: string } | null>(null)
  const [deleteSession, setDeleteSession] = useState<{ id: string; title: string } | null>(null)

  // ─── Initialization ───────────────────────────────────────────────

  // Refresh auth on mount
  useEffect(() => {
    useAuthStore.getState().refresh()
  }, [])

  // Start/stop polling based on auth state
  useEffect(() => {
    if (!authenticated) {
      useSessionStore.getState().stopPolling()
      useArtifactStore.getState().stopPolling()
      return
    }
    useSessionStore.getState().startPolling()
    useSessionStore.getState().fetchRuntimeInfo()
    useArtifactStore.getState().startPolling()
    return () => {
      useSessionStore.getState().stopPolling()
      useArtifactStore.getState().stopPolling()
    }
  }, [authenticated])

  // Cross-store cleanup on logout (auth store sets authenticated=false,
  // this effect resets all dependent stores). Track previous state to
  // avoid resetting on initial mount when authenticated starts as false.
  const wasAuthenticatedRef = useRef(authenticated)
  useEffect(() => {
    if (!authenticated && wasAuthenticatedRef.current) {
      useSessionStore.getState().reset()
      useArtifactStore.getState().reset()
      useSearchStore.getState().reset()
      useTerminalStore.getState().reset()
    }
    wasAuthenticatedRef.current = authenticated
  }, [authenticated])

  // ─── Callbacks ────────────────────────────────────────────────────

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    // Keep typing without needing another click
    setTimeout(() => {
      try {
        document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
      } catch {
        // ignore
      }
    }, 0)
  }, [])

  const handleOpenSessionMenu = useCallback((session: Session, ev: React.MouseEvent) => {
    if (!session?.id) return
    if (typeof window === 'undefined') return

    const sid = String(session.id)
    const title = String(session.title || session.id || sid)

    let left = 12
    let top = 12

    try {
      const rect = ev?.currentTarget?.getBoundingClientRect?.()
      const menuWidth = 180
      const menuHeight = 84
      if (rect) {
        left = rect.right - menuWidth
        top = rect.bottom + 6
        left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, left))
        top = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, top))
      }
    } catch {
      // ignore
    }

    setSessionMenu({ session_id: sid, title, left, top })
  }, [])

  const closeSessionMenu = useCallback(() => {
    setSessionMenu(null)
  }, [])

  const beginRename = useCallback(() => {
    if (!sessionMenu?.session_id) return
    const sid = String(sessionMenu.session_id)
    const sessions = useSessionStore.getState().sessions
    const found = (sessions || []).find((x) => x?.id === sid)
    const currentTitle = String(found?.title || sessionMenu.title || sid)
    setRenameSession({ id: sid, title: currentTitle })
    setSessionMenu(null)
  }, [sessionMenu])

  const beginDelete = useCallback(() => {
    if (!sessionMenu?.session_id) return
    const sid = String(sessionMenu.session_id)
    const sessions = useSessionStore.getState().sessions
    const found = (sessions || []).find((x) => x?.id === sid)
    const currentTitle = String(found?.title || sessionMenu.title || sid)
    setDeleteSession({ id: sid, title: currentTitle })
    setSessionMenu(null)
  }, [sessionMenu])

  const handleRename = useCallback(async (id: string, title: string) => {
    await useSessionStore.getState().rename(id, title)
    useToastStore.getState().show('session renamed')
    setRenameSession(null)
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    await useSessionStore.getState().deleteSess(id)
    useToastStore.getState().show('session deleted')
    setDeleteSession(null)
  }, [])

  const handleNewSession = useCallback(() => {
    useSessionStore.getState().startNewSession()
  }, [])

  const handleResumeSession = useCallback((session: Session) => {
    useSessionStore.getState().resumeSession(session.id)
    useSearchStore.getState().closePeek()
  }, [])

  const handleOpenArtifactPanel = useCallback(() => {
    useArtifactStore.getState().openPanel()
  }, [])

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: SLATE.bg,
        position: 'relative',
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        color: SLATE.textBright,
        overflow: 'hidden',
      }}
    >
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: ${SLATE.border}; border-radius: 2px }
        ::-webkit-scrollbar-thumb:hover { background: ${SLATE.muted} }
        ::selection { background: ${AMBER[700]}44 }

        /* xterm: make viewport/screen transparent so our ParticleField shows through */
        .xterm, .xterm .xterm-viewport, .xterm .xterm-screen {
          background-color: transparent !important;
        }
        .xterm canvas {
          background-color: transparent !important;
        }
        .xterm .composition-view {
          background: transparent !important;
        }

        button.hm-btn { background: none; border: none; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; text-align: inherit; display: inline-flex; align-items: center; }
        button.hm-btn:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }

        @keyframes eggToastFade {
          0% { opacity: 0; transform: translateY(4px); }
          12% { opacity: 1; transform: translateY(0); }
          80% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-4px); }
        }
      `}</style>

      {/* ── Main flex row (sidebar + content) ── */}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          filter: videoFxFilter,
          transform: videoFxTransform,
          willChange: videoFxEnabled ? 'filter, transform' : undefined,
        }}
      >
        <Sidebar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSessionMenu={handleOpenSessionMenu}
          onResumeSession={handleResumeSession}
          onNewSession={handleNewSession}
          sessionMenu={sessionMenu}
        />

        {/* ── Main area ── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <BackgroundRenderer />

          {/* ── Topbar ── */}
          <div
            style={{
              height: 40,
              flexShrink: 0,
              borderBottom: `1px solid ${SLATE.border}`,
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              gap: 10,
              background: `${SLATE.surface}ee`,
              position: 'relative',
              zIndex: 5,
              backdropFilter: 'blur(8px)',
            }}
          >
            <InlineSvgIcon svgRaw={activeTheme?.icons?.topbarSvgRaw} size={activeTheme?.icons?.topbarSize ?? 18} />
            <span style={{ fontSize: 11, color: SLATE.muted }}>session:</span>
            <span style={{ fontSize: 11, color: SLATE.muted }}>
              {authLoading
                ? 'auth\u2026'
                : locked
                  ? 'login required'
                  : activeSessionId
                    ? activeSessionId
                    : 'new session'}
            </span>

            <span style={{ color: SLATE.muted, fontSize: 11 }}>&middot;</span>
            <span style={{ fontSize: 11, color: SLATE.muted }}>model:</span>
            <span style={{ fontSize: 11, color: AMBER[500] }}>
              {runtimeInfo.loading ? '\u2026' : currentModel || '\u2014'}
            </span>

            <span style={{ color: SLATE.muted, fontSize: 11 }}>&middot;</span>
            <span style={{ fontSize: 11, color: SLATE.muted }}>cwd:</span>
            <span
              style={{
                fontSize: 11,
                color: SLATE.muted,
                maxWidth: 520,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={currentCwd || ''}
            >
              {runtimeInfo.loading ? '\u2026' : currentCwd || '\u2014'}
            </span>

            <div style={{ flex: 1 }} />
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: connected ? SLATE.success : SLATE.muted,
                boxShadow: `0 0 6px ${connected ? SLATE.success : SLATE.muted}`,
                transition: 'background 0.3s ease',
              }}
            />
            <span style={{ fontSize: 11, color: SLATE.muted }}>PTY</span>
          </div>

          {/* ── Terminal + Artifact/Peek panels ── */}
          <div style={{ flex: 1, display: 'flex', position: 'relative', minWidth: 0, minHeight: 0 }}>
            <div style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0 }}>
              {authenticated ? (
                <>
                  <TerminalPane />
                  <AlignmentEasterEgg
                    svgRaw={activeTheme?.icons?.alignmentSvgRaw}
                    title={activeTheme?.icons?.alignmentTitle}
                    whisperText={activeTheme?.icons?.alignmentWhisperText}
                    fetchFromApi={activeTheme?.icons?.alignmentFetchWhisper ?? true}
                  />
                </>
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: SLATE.muted,
                    fontSize: 12,
                  }}
                >
                  {authLoading ? 'checking auth\u2026' : locked ? 'locked' : 'disconnected'}
                </div>
              )}

              {/* Artifact panel edge tab (collapsed) */}
              {!artifactPanelOpen && authenticated && (
                <div
                  onClick={handleOpenArtifactPanel}
                  title="Open panel"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: SLATE.surface,
                    border: `1px solid ${SLATE.border}`,
                    borderRight: 'none',
                    borderRadius: '8px 0 0 8px',
                    padding: '12px 7px',
                    cursor: 'pointer',
                    color: SLATE.muted,
                    zIndex: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    userSelect: 'none',
                    boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = AMBER[400]
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = SLATE.muted
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span
                    style={{
                      fontSize: 9,
                      writingMode: 'vertical-rl',
                      textOrientation: 'mixed',
                      letterSpacing: '0.04em',
                      userSelect: 'none',
                    }}
                  >
                    {`${artifactTabs.length} artifact${artifactTabs.length === 1 ? '' : 's'}`}
                  </span>
                </div>
              )}
            </div>

            {artifactPanelOpen && (
              <ArtifactPanel
                width={artifactPanelWidth}
                onResizeWidth={(w: number) => useArtifactStore.getState().setPanelWidth(w)}
                artifacts={artifactTabs}
                activeArtifactId={activeArtifactId}
                onSelectArtifact={(id: string) => useArtifactStore.getState().setActiveId(id)}
                onClose={() => useArtifactStore.getState().closePanel()}
                onDeleteArtifact={(id: string) => useArtifactStore.getState().deleteTab(id)}
              />
            )}
          </div>

          {/* Login overlay */}
          {locked && (
            <LoginScreen faviconHref={activeTheme?.icons?.faviconHref} />
          )}
        </div>
      </div>

      {/* ── Modals ── */}
      {sessionMenu && (
        <SessionContextMenu
          menu={sessionMenu}
          onRename={beginRename}
          onDelete={beginDelete}
          onClose={closeSessionMenu}
        />
      )}

      {renameSession && (
        <RenameSessionModal
          session={renameSession}
          onSave={handleRename}
          onClose={() => setRenameSession(null)}
        />
      )}

      {deleteSession && (
        <DeleteSessionModal
          session={deleteSession}
          onDelete={handleDelete}
          onClose={() => setDeleteSession(null)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={closeSettings}
          locked={locked}
          defaultModel={formatModelLabel(runtimeInfo.defaultModel) || ''}
          onModelSaved={(m: string) => {
            useSessionStore.setState((s) => ({
              runtimeInfo: {
                ...s.runtimeInfo,
                loading: false,
                defaultModel: m || null,
              },
            }))
          }}
          uiPrefs={prefs}
          onUiPrefsChange={useUiPrefsStore.getState().update}
          onSaved={() => {
            useToastStore.getState().show('settings saved')
          }}
        />
      )}

      <VideoFxOverlay
        enabled={videoFxEnabled}
        intensity={videoFxFactor * 100}
        glitchNow={videoFxGlitchNow}
        glitchSeed={videoFxGlitchSeed}
      />
    </div>
  )
}
