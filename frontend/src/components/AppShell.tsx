import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useFleetStore } from '../stores/fleet'
import { useRuntimeStore } from '../stores/runtimes'

// ─── Utils ─────────────────────────────────────────────────────────
import { formatModelLabel } from '../utils/formatting'

// ─── Components ────────────────────────────────────────────────────
import { Sidebar } from './sidebar/Sidebar'
import { BackgroundRenderer } from './backgrounds/BackgroundRenderer'
import TerminalPane from './terminal/TerminalPane'
import { AlignmentEasterEgg } from './AlignmentEasterEgg'
import { ThemeIcon } from './shared/icons'
import { TopbarSprite } from './shared/TopbarSprite'
import { SettingsPanel } from './settings/SettingsPanel'
import { LoginScreen } from './modals/LoginScreen'
import { SessionContextMenu } from './modals/SessionContextMenu'
import { RenameSessionModal } from './modals/RenameSessionModal'
import { DeleteSessionModal } from './modals/DeleteSessionModal'
import { FloatingPetOverlay } from './pet/FloatingPetOverlay'
import { FleetPanel } from './fleet/FleetPanel'

import ArtifactPanel from './ArtifactPanel'
import VideoFxOverlay from './VideoFxOverlay'

// ─── Types ─────────────────────────────────────────────────────────
import type { FleetNode, HermesRuntime, Session, SessionMenu } from '../types'

function fleetRuntimeNode(runtime: HermesRuntime | null | undefined): string {
  return String(runtime?.node || runtime?.metadata?.node || '')
}

function fleetRuntimeAttachPath(runtime: HermesRuntime | null | undefined): string | null {
  const node = fleetRuntimeNode(runtime).trim()
  const id = String(runtime?.runtime_id || '').trim()
  return node && id ? `/ws/fleet/nodes/${encodeURIComponent(node)}/runtimes/${encodeURIComponent(id)}/attach` : null
}

function fleetNodeLabel(node: FleetNode): string {
  return String(node.node || node.metadata?.host || 'remote')
}

function isFleetNodeOnline(node: FleetNode): boolean {
  return String(node.state || '').toLowerCase() !== 'offline'
}


function isAttachableLocalRuntime(runtime: HermesRuntime): boolean {
  return runtime.state !== 'stopped' && runtime.can_attach !== false
}

type ActiveFleetRuntimeTarget =
  | { kind: 'runtime'; node: string; runtimeId: string }
  | null

// ===================================================================
// Artifact shell islands
//
// Keep artifact list/payload subscriptions outside AppShell so live/heavy
// artifact updates do not re-render the whole composition root or terminal
// subtree on every poll/websocket control frame.
// ===================================================================

interface ArtifactEdgeTabProps {
  authenticated: boolean
}

const ArtifactEdgeTab = memo(function ArtifactEdgeTab({ authenticated }: ArtifactEdgeTabProps) {
  const artifactPanelOpen = useArtifactStore((s) => s.panelOpen)
  const artifactCount = useArtifactStore((s) => s.tabs.length)

  const handleOpenArtifactPanel = useCallback(() => {
    useArtifactStore.getState().openPanel()
  }, [])

  if (artifactPanelOpen || !authenticated) return null

  return (
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
        {`${artifactCount} artifact${artifactCount === 1 ? '' : 's'}`}
      </span>
    </div>
  )
})

const ArtifactPanelHost = memo(function ArtifactPanelHost() {
  const artifactPanelOpen = useArtifactStore((s) => s.panelOpen)
  const artifactPanelWidth = useArtifactStore((s) => s.panelWidth)
  const artifactTabs = useArtifactStore((s) => s.tabs)
  const activeArtifactId = useArtifactStore((s) => s.activeId)

  const handleResizeWidth = useCallback((w: number) => {
    useArtifactStore.getState().setPanelWidth(w)
  }, [])
  const handleSelectArtifact = useCallback((id: string) => {
    useArtifactStore.getState().setActiveId(id)
  }, [])
  const handleClose = useCallback(() => {
    useArtifactStore.getState().closePanel()
  }, [])
  const handleDeleteArtifact = useCallback((id: string) => {
    useArtifactStore.getState().deleteTab(id)
  }, [])
  const handleRenameArtifact = useCallback((id: string, title: string) => {
    void useArtifactStore.getState().renameTab(id, title)
  }, [])
  const handleClearSessionArtifacts = useCallback(() => {
    void useArtifactStore.getState().clearSessionArtifacts()
  }, [])

  if (!artifactPanelOpen) return null

  return (
    <ArtifactPanel
      width={artifactPanelWidth}
      onResizeWidth={handleResizeWidth}
      artifacts={artifactTabs}
      activeArtifactId={activeArtifactId}
      onSelectArtifact={handleSelectArtifact}
      onClose={handleClose}
      onDeleteArtifact={handleDeleteArtifact}
      onRenameArtifact={handleRenameArtifact}
      onClearSessionArtifacts={handleClearSessionArtifacts}
    />
  )
})

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
  const logoutReason = useAuthStore((s) => s.logoutReason)
  const sessionTtlSeconds = useAuthStore((s) => s.sessionTtlSeconds)

  const activeSession = useSessionStore((s) => s.activeSession)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const runtimeInfo = useSessionStore((s) => s.runtimeInfo)

  const runtimes = useRuntimeStore((s) => s.runtimes)
  const activeRuntimeId = useRuntimeStore((s) => s.activeRuntimeId)
  const runtimeConfig = useRuntimeStore((s) => s.config)
  const activeRuntime = runtimes.find((runtime) => runtime.runtime_id === activeRuntimeId) || null
  const runtimeProfiles = useMemo(() => {
    const profiles = Array.isArray(runtimeConfig.profiles) && runtimeConfig.profiles.length
      ? runtimeConfig.profiles
      : [{ name: 'default', label: 'default', is_default: true, configured: true, model: null }]
    return profiles
  }, [runtimeConfig.profiles])
  const liveLocalRuntimes = useMemo(() => runtimes.filter(isAttachableLocalRuntime), [runtimes])
  const hiddenStoppedLocalRuntimeCount = Math.max(0, runtimes.length - liveLocalRuntimes.length)

  const fleetConfig = useFleetStore((s) => s.config)
  const fleetNodes = useFleetStore((s) => s.nodes)
  const fleetRuntimes = useFleetStore((s) => s.runtimes)
  const fleetSessions = useFleetStore((s) => s.sessions)
  const fleetLoading = useFleetStore((s) => s.loading)
  const fleetError = useFleetStore((s) => s.error)

  const connected = useTerminalStore(selectConnected)
  const petActivityState = useTerminalStore((s) => s.petActivity.state)

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
  const remoteFleetRuntimes = useMemo(
    () => fleetRuntimes.filter((runtime) => runtime.can_attach !== false && runtime.state !== 'stopped' && Boolean(fleetRuntimeAttachPath(runtime))),
    [fleetRuntimes],
  )
  const remoteFleetStartNodes = useMemo(
    () => fleetNodes.filter(isFleetNodeOnline),
    [fleetNodes],
  )

  // ─── Shell-local state ────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [fleetPanelOpen, setFleetPanelOpen] = useState(false)
  const [activeFleetRuntimeTarget, setActiveFleetRuntimeTarget] = useState<ActiveFleetRuntimeTarget>(null)
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false)
  const [selectedRuntimeProfile, setSelectedRuntimeProfile] = useState('default')
  const [sessionMenu, setSessionMenu] = useState<SessionMenu | null>(null)
  const [renameSession, setRenameSession] = useState<{ id: string; title: string } | null>(null)
  const [deleteSession, setDeleteSession] = useState<{ id: string; title: string } | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)

  const activeFleetRuntimeRecord = activeFleetRuntimeTarget?.kind === 'runtime'
    ? fleetRuntimes.find((runtime) => runtime.runtime_id === activeFleetRuntimeTarget.runtimeId && fleetRuntimeNode(runtime) === activeFleetRuntimeTarget.node) || null
    : null
  const activeFleetRuntimeAttachPath = fleetRuntimeAttachPath(activeFleetRuntimeRecord)

  // Pause background animation while any overlay/modal is open
  const overlayOpen = !!(settingsOpen || fleetPanelOpen || renameSession || deleteSession || locked)

  // ─── Initialization ───────────────────────────────────────────────

  // Refresh auth on mount
  useEffect(() => {
    useAuthStore.getState().refresh()
  }, [])

  // Keep the profile selector pointed at an existing local Hermes profile.
  useEffect(() => {
    if (runtimeProfiles.some((profile) => profile.name === selectedRuntimeProfile)) return
    const fallback = runtimeProfiles.find((profile) => profile.name === runtimeConfig.default_profile)?.name || runtimeProfiles[0]?.name || 'default'
    setSelectedRuntimeProfile(fallback)
  }, [runtimeProfiles, runtimeConfig.default_profile, selectedRuntimeProfile])

  // Keep long-lived open tabs authenticated by hitting /api/auth/me.  The
  // backend renews the signed cookie on successful auth checks.
  useEffect(() => {
    if (!authEnabled || !authenticated) return
    const ttlMs = Math.max(0, Number(sessionTtlSeconds || 0) * 1000)
    // Default to the previous 5-minute cadence when the server omits a TTL,
    // but for shorter deployments renew halfway through the advertised TTL.
    const keepaliveMs = ttlMs > 0 ? Math.max(500, Math.min(5 * 60 * 1000, Math.floor(ttlMs * 0.5))) : 5 * 60 * 1000
    const t = setInterval(() => {
      void useAuthStore.getState().refresh({ preserveEnabledOnError: true })
    }, keepaliveMs)
    return () => clearInterval(t)
  }, [authEnabled, authenticated, sessionTtlSeconds])

  // Check for updates after initial load (wait for auth so protected deployments don't miss it)
  useEffect(() => {
    if (authLoading) return
    if (authEnabled && !authenticated) {
      setUpdateAvailable(false)
      return
    }

    let cancelled = false
    const t = setTimeout(() => {
      fetch('/api/update-check')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled) return
          setUpdateAvailable(Boolean(data?.update_available))
        })
        .catch(() => {})
    }, 5000)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [authEnabled, authLoading, authenticated])

  // Start/stop polling based on auth state
  useEffect(() => {
    let cancelled = false
    if (!authenticated) {
      useSessionStore.getState().stopPolling()
      useRuntimeStore.getState().stopPolling()
      useArtifactStore.getState().stopPolling()
      useFleetStore.getState().stopPolling()
      return
    }
    useSessionStore.getState().startPolling()
    useSessionStore.getState().fetchRuntimeInfo()
    useRuntimeStore.getState().startPolling()
    useArtifactStore.getState().startPolling()
    void useFleetStore.getState().refreshConfig().then((config) => {
      if (!cancelled && config.enabled) useFleetStore.getState().startPolling()
    }).catch(() => {
      // Fleet is optional; local HermelinChat remains fully usable.
    })

    // Auto-spawn terminal on first auth, but let the local runtime manager
    // discover/create a default runtime first. If runtime discovery fails, the
    // terminal still falls back to the legacy /ws/pty path.
    void useRuntimeStore.getState().refresh().finally(() => {
      if (cancelled) return
      if (useTerminalStore.getState().state.phase === 'idle') {
        useTerminalStore.getState().spawn(useSessionStore.getState().activeSessionId ?? null)
      }
    })

    return () => {
      cancelled = true
      useSessionStore.getState().stopPolling()
      useRuntimeStore.getState().stopPolling()
      useArtifactStore.getState().stopPolling()
      useFleetStore.getState().stopPolling()
    }
  }, [authenticated])

  // Cross-store cleanup on deliberate logout only.  If a cookie expires or a
  // background request gets a 401, keep the active session in memory so the
  // login overlay can be dismissed without forcing manual resume.
  const wasAuthenticatedRef = useRef(authenticated)
  const didExplicitLogoutCleanupRef = useRef(false)
  useEffect(() => {
    if (authenticated || logoutReason !== 'explicit') {
      didExplicitLogoutCleanupRef.current = false
    }
    if (!authenticated && logoutReason === 'explicit' && !didExplicitLogoutCleanupRef.current) {
      didExplicitLogoutCleanupRef.current = true
      useSessionStore.getState().reset()
      useArtifactStore.getState().reset()
      useSearchStore.getState().reset()
      useTerminalStore.getState().reset()
      useRuntimeStore.getState().reset()
      useFleetStore.getState().reset()
      setActiveFleetRuntimeTarget(null)
    } else if (!authenticated && wasAuthenticatedRef.current && logoutReason === 'expired') {
      // TerminalPane unmounts while locked and closes its websocket. Reset only
      // the terminal connection state and clear search UI that renders outside
      // the main lock overlay, while preserving activeSessionId so the
      // next successful login reconnects instead of opening a fresh session.
      useSearchStore.getState().reset()
      useTerminalStore.getState().reset()
    }
    wasAuthenticatedRef.current = authenticated
  }, [authenticated, logoutReason])

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
    setActiveFleetRuntimeTarget(null)
    const runtimeState = useRuntimeStore.getState()
    if (runtimeState.config.enabled && runtimeState.config.backend === 'tmux') {
      useSessionStore.getState().startNewSession({ spawn: false })
      const count = runtimeState.runtimes.filter(isAttachableLocalRuntime).length + 1
      void runtimeState.createRuntime(`Hermes ${count}`, { profile: selectedRuntimeProfile }).then((runtime) => {
        if (runtime) useTerminalStore.getState().spawn(null)
      }).catch((err) => {
        useToastStore.getState().show(err instanceof Error ? err.message : 'failed to start runtime')
      })
      return
    }
    useSessionStore.getState().startNewSession()
  }, [selectedRuntimeProfile])

  const handleResumeSession = useCallback((session: Session) => {
    setActiveFleetRuntimeTarget(null)
    const runtimeState = useRuntimeStore.getState()
    if (runtimeState.config.enabled && runtimeState.config.backend === 'tmux') {
      void runtimeState.createRuntime(session.title || session.id, { resumeId: session.id }).then((runtime) => {
        if (runtime) {
          useSessionStore.getState().setActiveSessionId(session.id)
          useTerminalStore.getState().spawn(session.id)
        }
      })
      useSearchStore.getState().closePeek()
      return
    }
    useSessionStore.getState().resumeSession(session.id)
    useSearchStore.getState().closePeek()
  }, [])

  const handleToggleRuntimeMenu = useCallback(() => {
    setRuntimeMenuOpen((open) => {
      const next = !open
      if (next) {
        void useRuntimeStore.getState().refresh()
        void useFleetStore.getState().refreshSnapshot()
      }
      return next
    })
  }, [])

  const handleSelectRuntime = useCallback((runtimeId: string) => {
    const rid = String(runtimeId || '').trim()
    if (!rid) return
    setActiveFleetRuntimeTarget(null)
    useRuntimeStore.getState().setActiveRuntimeId(rid)
    // Force a clean attach cycle.  Relying only on the derived websocket path
    // can leave the terminal store in its previous runtime/session phase, which
    // makes the topbar label switch while the visible terminal appears stuck.
    useTerminalStore.getState().spawn(null)
    void useRuntimeStore.getState().activateRuntime(rid)
    setRuntimeMenuOpen(false)
  }, [])

  const handleSelectFleetTmuxRuntime = useCallback((runtime: HermesRuntime) => {
    if (runtime.can_attach === false || runtime.state === 'stopped') {
      useToastStore.getState().show(`remote runtime is not attachable: ${runtime.runtime_id}`)
      return
    }
    const node = fleetRuntimeNode(runtime).trim()
    const rid = String(runtime.runtime_id || '').trim()
    if (!node || !rid) return
    setActiveFleetRuntimeTarget({ kind: 'runtime', node, runtimeId: rid })
    setFleetPanelOpen(false)
    setRuntimeMenuOpen(false)
    useRuntimeStore.getState().setActiveRuntimeId(null)
    useTerminalStore.getState().spawn(null)
    useToastStore.getState().show(`remote runtime selected: ${node}`)
  }, [])

  const handleStartFleetTmuxRuntime = useCallback(async (node: string) => {
    const safeNode = String(node || '').trim()
    if (!safeNode) return
    const count = useFleetStore.getState().runtimes.filter((runtime) => fleetRuntimeNode(runtime) === safeNode && runtime.can_attach !== false && runtime.state !== 'stopped').length + 1
    const uiTheme = useUiPrefsStore.getState().prefs.theme
    const runtime = await useFleetStore.getState().createRuntime(safeNode, `Hermes ${count}`, { uiTheme })
    if (!runtime) return
    handleSelectFleetTmuxRuntime(runtime)
    useToastStore.getState().show(`remote runtime started: ${safeNode}`)
  }, [handleSelectFleetTmuxRuntime])

  const handleStopFleetTmuxRuntime = useCallback(async (runtime: HermesRuntime) => {
    const node = fleetRuntimeNode(runtime).trim()
    const rid = String(runtime.runtime_id || '').trim()
    if (!node || !rid) return
    await useFleetStore.getState().stopRuntime(node, rid)
    if (activeFleetRuntimeTarget?.kind === 'runtime' && activeFleetRuntimeTarget.node === node && activeFleetRuntimeTarget.runtimeId === rid) {
      setActiveFleetRuntimeTarget(null)
      useTerminalStore.getState().spawn(useSessionStore.getState().activeSessionId ?? null)
    }
    useToastStore.getState().show(`remote runtime stopped: ${node}`)
  }, [activeFleetRuntimeTarget])

  const handleNewRuntime = useCallback(async () => {
    setActiveFleetRuntimeTarget(null)
    const count = useRuntimeStore.getState().runtimes.filter(isAttachableLocalRuntime).length + 1
    const runtime = await useRuntimeStore.getState().createRuntime(`Hermes ${count}`, { profile: selectedRuntimeProfile })
    if (runtime) {
      useTerminalStore.getState().spawn(null)
      useToastStore.getState().show(`runtime started · profile ${runtime.profile || selectedRuntimeProfile}`)
    }
    setRuntimeMenuOpen(false)
  }, [selectedRuntimeProfile])

  const handleStopRuntime = useCallback(async (runtimeId: string) => {
    setActiveFleetRuntimeTarget(null)
    await useRuntimeStore.getState().stopRuntime(runtimeId)
    useTerminalStore.getState().spawn(useSessionStore.getState().activeSessionId ?? null)
    useToastStore.getState().show('runtime stopped')
  }, [])

  const runtimePillLabel = activeFleetRuntimeRecord
    ? `remote: ${fleetRuntimeNode(activeFleetRuntimeRecord)} · ${activeFleetRuntimeRecord.title || activeFleetRuntimeRecord.runtime_id}`
    : activeRuntime
      ? `${activeRuntime.title || activeRuntime.runtime_id} · ${activeRuntime.profile || 'default'}${activeRuntime.backend === 'tmux' ? '' : ' · legacy'}`
      : runtimeConfig.enabled
        ? 'runtime…'
        : 'legacy'
  const activeFleetSessionId = activeFleetRuntimeRecord?.active_hermes_session_id || ''

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
          updateAvailable={updateAvailable}
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
          <BackgroundRenderer paused={overlayOpen} />

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
              background: `${SLATE.surface}f8`,
              position: 'relative',
              // Keep topbar/dropdowns above the xterm canvas/helper textarea.
              // TerminalPane is a later sibling, so equal z-index lets xterm
              // paint/intercept over menus and normal text selection/copy.
              zIndex: 80,
            }}
          >
            <span
              style={{
                opacity: activeTheme?.icons?.topbarGlow ? 0.88 : 1,
                filter: activeTheme?.icons?.topbarGlow
                  ? `drop-shadow(0 0 10px ${AMBER[400]}70)`
                  : 'none',
                transition: 'all 0.35s ease',
              }}
            >
              {activeTheme?.icons?.topbarSpritesheet && activeTheme?.icons?.topbarImageHref ? (
                <TopbarSprite
                  blinkHref={activeTheme.icons.topbarImageHref}
                  blinkFrames={activeTheme.icons.topbarSpriteFrames}
                  frameWidth={activeTheme.icons.topbarSpriteWidth}
                  frameHeight={activeTheme.icons.topbarSpriteHeight}
                  width={activeTheme.icons.topbarWidth}
                  height={activeTheme.icons.topbarHeight}
                  paused={overlayOpen}
                  tintColor={activeTheme.icons.topbarTintColor}
                  tintOpacity={activeTheme.icons.topbarTintOpacity}
                  title={activeTheme.label}
                />
              ) : (
                <ThemeIcon
                  svgRaw={activeTheme?.icons?.topbarSvgRaw}
                  imageHref={activeTheme?.icons?.topbarImageHref}
                  size={activeTheme?.icons?.topbarSize ?? 18}
                  width={activeTheme?.icons?.topbarWidth}
                  height={activeTheme?.icons?.topbarHeight}
                  tintColor={activeTheme?.icons?.topbarTintColor}
                  tintOpacity={activeTheme?.icons?.topbarTintOpacity}
                  backdropFadeColor={activeTheme?.icons?.topbarBackdropFadeColor}
                  title={activeTheme?.label}
                />
              )}
            </span>
            <button
              type="button"
              className="hm-btn"
              disabled={!authenticated || !runtimeConfig.enabled}
              onClick={handleToggleRuntimeMenu}
              title="Hermes runtime"
              style={{
                border: `1px solid ${runtimeMenuOpen ? AMBER[700] : SLATE.border}`,
                background: runtimeMenuOpen ? `${AMBER[900]}44` : SLATE.elevated,
                color: activeRuntime?.backend === 'tmux' ? AMBER[400] : SLATE.muted,
                opacity: authenticated && runtimeConfig.enabled ? 1 : 0.5,
                borderRadius: 8,
                padding: '4px 8px',
                fontSize: 11,
                maxWidth: 220,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {`runtime: ${runtimePillLabel}`}
            </button>
            {runtimeMenuOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 36,
                  left: 50,
                  width: 360,
                  maxHeight: 420,
                  overflowY: 'auto',
                  background: `${SLATE.surface}fb`,
                  border: `1px solid ${runtimeMenuOpen ? AMBER[900] : SLATE.border}`,
                  borderRadius: 12,
                  boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
                  padding: 10,
                  zIndex: 120,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, color: SLATE.muted }}>
                    {runtimeConfig.backend === 'tmux' ? `persistent local runtimes · ${liveLocalRuntimes.length} live` : 'legacy runtime fallback'}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: SLATE.muted, fontSize: 10 }}>
                      <span>profile</span>
                      <select
                        value={selectedRuntimeProfile}
                        disabled={!runtimeConfig.enabled}
                        onChange={(ev) => setSelectedRuntimeProfile(ev.currentTarget.value)}
                        title="Hermes profile for new local runtimes"
                        style={{
                          maxWidth: 118,
                          border: `1px solid ${SLATE.border}`,
                          background: SLATE.surface,
                          color: SLATE.textBright,
                          borderRadius: 7,
                          padding: '3px 6px',
                          font: 'inherit',
                          fontSize: 10,
                        }}
                      >
                        {runtimeProfiles.map((profile) => (
                          <option key={profile.name} value={profile.name}>
                            {profile.label || profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="hm-btn"
                      onClick={() => void useRuntimeStore.getState().refresh()}
                      title="Refresh runtime list"
                      style={{
                        border: `1px solid ${SLATE.border}`,
                        background: SLATE.elevated,
                        color: SLATE.muted,
                        borderRadius: 7,
                        padding: '3px 6px',
                        fontSize: 10,
                      }}
                    >
                      refresh
                    </button>
                    <button
                      type="button"
                      className="hm-btn"
                      onClick={handleNewRuntime}
                      disabled={!runtimeConfig.enabled}
                      style={{
                        border: `1px solid ${AMBER[800]}`,
                        background: `${AMBER[900]}44`,
                        color: AMBER[300],
                        borderRadius: 7,
                        padding: '3px 6px',
                        fontSize: 10,
                      }}
                    >
                      + new
                    </button>
                  </div>
                </div>
                {liveLocalRuntimes.length === 0 ? (
                  <div style={{ color: SLATE.muted, fontSize: 11, padding: '10px 4px' }}>no live managed runtime</div>
                ) : (
                  liveLocalRuntimes.map((runtime) => {
                    const active = runtime.runtime_id === activeRuntimeId
                    const statusColor = active ? AMBER[300] : SLATE.textBright
                    return (
                      <div
                        key={runtime.runtime_id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: runtime.can_stop ? 'minmax(0, 1fr) auto' : '1fr',
                          gap: 8,
                          alignItems: 'stretch',
                          marginTop: 6,
                        }}
                      >
                        <button
                          type="button"
                          className="hm-btn"
                          onClick={() => handleSelectRuntime(runtime.runtime_id)}
                          title={active ? 'Current runtime' : `Switch to ${runtime.title || runtime.runtime_id}`}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1fr) auto',
                            alignItems: 'center',
                            gap: 10,
                            minWidth: 0,
                            width: '100%',
                            padding: '8px 9px',
                            borderRadius: 9,
                            border: `1px solid ${active ? AMBER[800] : SLATE.border}`,
                            background: active ? `${AMBER[900]}3d` : SLATE.elevated,
                            opacity: 1,
                          }}
                        >
                          <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                            <span style={{ color: statusColor, fontSize: 12, fontWeight: active ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {runtime.title || runtime.runtime_id}
                            </span>
                            <span style={{ color: SLATE.muted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {`${runtime.backend} · ${runtime.state} · profile ${runtime.profile || 'default'}${runtime.hermes_pid ? ` · pid ${runtime.hermes_pid}` : ''}`}
                            </span>
                          </span>
                          <span
                            style={{
                              border: `1px solid ${active ? AMBER[800] : SLATE.border}`,
                              borderRadius: 999,
                              color: active ? AMBER[300] : SLATE.muted,
                              padding: '2px 7px',
                              fontSize: 10,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {active ? 'current' : 'switch'}
                          </span>
                        </button>
                        {runtime.can_stop && (
                          <button
                            type="button"
                            className="hm-btn"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              void handleStopRuntime(runtime.runtime_id)
                            }}
                            title={`Stop ${runtime.title || runtime.runtime_id}`}
                            style={{ color: SLATE.muted, fontSize: 10, border: `1px solid ${SLATE.border}`, borderRadius: 9, padding: '0 8px', background: SLATE.surface }}
                          >
                            stop
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
                {hiddenStoppedLocalRuntimeCount > 0 && (
                  <div style={{ color: SLATE.dim, fontSize: 10, padding: '8px 4px 0' }}>
                    {`${hiddenStoppedLocalRuntimeCount} stopped runtime${hiddenStoppedLocalRuntimeCount === 1 ? '' : 's'} hidden`}
                  </div>
                )}

                {fleetConfig.enabled && (
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${SLATE.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 10, color: SLATE.muted }}>
                      {`remote fleet tmux${fleetConfig.enabled ? ` · ${remoteFleetRuntimes.length} runtimes · ${remoteFleetStartNodes.length} hosts` : ''}`}
                    </span>
                    <span style={{ fontSize: 10, color: fleetError ? SLATE.danger : fleetConfig.enabled ? SLATE.success : SLATE.muted }}>
                      {fleetLoading ? 'sync' : fleetError ? 'error' : fleetConfig.enabled ? `${fleetSessions.length} sessions` : 'disabled'}
                    </span>
                  </div>
                  {!fleetConfig.enabled ? (
                    <div style={{ color: SLATE.muted, fontSize: 10, padding: '7px 4px' }}>configure HERMELIN_FLEET_URL to list remotes</div>
                  ) : fleetError ? (
                    <div style={{ color: SLATE.danger, fontSize: 10, padding: '7px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fleetError}>{fleetError}</div>
                  ) : remoteFleetRuntimes.length === 0 && remoteFleetStartNodes.length === 0 ? (
                    <div style={{ color: SLATE.muted, fontSize: 10, padding: '7px 4px' }}>no remote Fleet hosts visible</div>
                  ) : (
                    <>
                      {remoteFleetRuntimes.map((runtime) => {
                        const node = fleetRuntimeNode(runtime)
                        const active = activeFleetRuntimeTarget?.kind === 'runtime' && activeFleetRuntimeTarget.node === node && activeFleetRuntimeTarget.runtimeId === runtime.runtime_id
                        return (
                          <div
                            key={`rt:${node}:${runtime.runtime_id}`}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: runtime.can_stop !== false ? 'minmax(0, 1fr) auto' : '1fr',
                              gap: 8,
                              alignItems: 'stretch',
                              marginTop: 6,
                            }}
                          >
                            <button
                              type="button"
                              className="hm-btn"
                              onClick={() => handleSelectFleetTmuxRuntime(runtime)}
                              title={`Attach remote tmux runtime ${node} · ${runtime.runtime_id}`}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1fr) auto',
                                alignItems: 'center',
                                gap: 10,
                                minWidth: 0,
                                width: '100%',
                                padding: '8px 9px',
                                borderRadius: 9,
                                border: `1px solid ${active ? AMBER[800] : SLATE.border}`,
                                background: active ? `${AMBER[900]}3d` : '#101215',
                              }}
                            >
                              <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                                <span style={{ color: active ? AMBER[300] : SLATE.textBright, fontSize: 12, fontWeight: active ? 700 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {runtime.title || runtime.runtime_id}
                                </span>
                                <span style={{ color: SLATE.muted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {`fleet tmux · ${node} · ${runtime.state || 'idle'}${runtime.hermes_pid ? ` · pid ${runtime.hermes_pid}` : ''}`}
                                </span>
                              </span>
                              <span style={{ border: `1px solid ${active ? AMBER[800] : SLATE.border}`, borderRadius: 999, color: active ? AMBER[300] : SLATE.muted, padding: '2px 7px', fontSize: 10, whiteSpace: 'nowrap' }}>
                                {active ? 'current' : 'attach'}
                              </span>
                            </button>
                            {runtime.can_stop !== false && (
                              <button
                                type="button"
                                className="hm-btn"
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  void handleStopFleetTmuxRuntime(runtime)
                                }}
                                title={`Stop remote runtime ${runtime.title || runtime.runtime_id}`}
                                style={{ color: SLATE.muted, fontSize: 10, border: `1px solid ${SLATE.border}`, borderRadius: 9, padding: '0 8px', background: SLATE.surface }}
                              >
                                stop
                              </button>
                            )}
                          </div>
                        )
                      })}
                      {remoteFleetStartNodes.map((node) => (
                        <button
                          key={`node:${node.node}`}
                          type="button"
                          className="hm-btn"
                          onClick={() => void handleStartFleetTmuxRuntime(node.node)}
                          title={`Start remote tmux Hermes on ${fleetNodeLabel(node)}`}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1fr) auto',
                            alignItems: 'center',
                            gap: 10,
                            minWidth: 0,
                            width: '100%',
                            marginTop: 6,
                            padding: '8px 9px',
                            borderRadius: 9,
                            border: `1px dashed ${AMBER[900]}`,
                            background: '#101215',
                          }}
                        >
                          <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                            <span style={{ color: SLATE.textBright, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {fleetNodeLabel(node)}
                            </span>
                            <span style={{ color: SLATE.muted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {`fleet host · ${node.state || 'online'} · start tmux Hermes`}
                            </span>
                          </span>
                          <span style={{ border: `1px solid ${AMBER[800]}`, borderRadius: 999, color: AMBER[300], padding: '2px 7px', fontSize: 10, whiteSpace: 'nowrap' }}>
                            start
                          </span>
                        </button>
                      ))}

                    </>
                  )}
                  </div>
                )}
              </div>
            )}

            <span style={{ fontSize: 11, color: SLATE.muted }}>session:</span>
            <span style={{ fontSize: 11, color: SLATE.muted }}>
              {authLoading
                ? 'auth\u2026'
                : locked
                  ? 'login required'
                  : activeFleetRuntimeRecord
                    ? activeFleetSessionId || activeFleetRuntimeRecord.runtime_id
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
            {fleetConfig.enabled && (
              <button
              type="button"
              className="hm-btn"
              disabled={!authenticated}
              onClick={() => setFleetPanelOpen((v) => !v)}
              style={{
                border: `1px solid ${fleetPanelOpen ? AMBER[700] : SLATE.border}`,
                background: fleetPanelOpen ? `${AMBER[900]}55` : SLATE.elevated,
                color: fleetPanelOpen ? AMBER[300] : SLATE.muted,
                opacity: authenticated ? 1 : 0.35,
                cursor: authenticated ? 'pointer' : 'default',
                borderRadius: 8,
                padding: '5px 8px',
                fontSize: 11,
                userSelect: 'none',
              }}
              title="Open HermelinFleet cockpit"
            >
              fleet
              </button>
            )}
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: activeFleetRuntimeRecord ? SLATE.success : connected ? SLATE.success : SLATE.muted,
                boxShadow: `0 0 6px ${activeFleetRuntimeRecord ? SLATE.success : connected ? SLATE.success : SLATE.muted}`,
                transition: 'background 0.3s ease',
              }}
            />
            <span style={{ fontSize: 11, color: SLATE.muted }}>{activeFleetRuntimeRecord ? 'FLEET' : 'PTY'}</span>
          </div>

          {/* ── Terminal + Artifact/Peek panels ── */}
          <div style={{ flex: 1, display: 'flex', position: 'relative', minWidth: 0, minHeight: 0 }}>
            <div style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0 }}>
              {authenticated ? (
                <>
                  <TerminalPane attachPathOverride={activeFleetRuntimeAttachPath} />
                  <FloatingPetOverlay
                    activityState={petActivityState}
                    paused={overlayOpen}
                    settings={prefs.petOverlay}
                    visible={authenticated && prefs.petOverlay.enabled}
                  />
                  <AlignmentEasterEgg
                    svgRaw={activeTheme?.icons?.alignmentSvgRaw}
                    imageHref={activeTheme?.icons?.alignmentImageHref}
                    title={activeTheme?.icons?.alignmentTitle}
                    whisperText={activeTheme?.icons?.alignmentWhisperText}
                    fetchFromApi={activeTheme?.icons?.alignmentFetchWhisper}
                    size={activeTheme?.icons?.alignmentSize ?? 18}
                    width={activeTheme?.icons?.alignmentWidth}
                    height={activeTheme?.icons?.alignmentHeight}
                    alwaysVisible={activeTheme?.icons?.alignmentAlwaysVisible}
                    bob={activeTheme?.icons?.alignmentBob}
                    bobDurationMs={activeTheme?.icons?.alignmentBobDurationMs}
                    bobDistancePx={activeTheme?.icons?.alignmentBobDistancePx}
                    paused={overlayOpen}
                    spritesheet={activeTheme?.icons?.alignmentSpritesheet}
                    spriteFrames={activeTheme?.icons?.alignmentSpriteFrames}
                    spriteWidth={activeTheme?.icons?.alignmentSpriteWidth}
                    spriteHeight={activeTheme?.icons?.alignmentSpriteHeight}
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

              <ArtifactEdgeTab authenticated={authenticated} />
              {fleetPanelOpen && authenticated && (
                <FleetPanel onClose={() => setFleetPanelOpen(false)} />
              )}
            </div>

            <ArtifactPanelHost />
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
