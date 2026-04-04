import { create } from 'zustand'
import type { Session, GroupedSessions, RuntimeInfo } from '../types'
import { useAuthStore } from './auth'
import { apiCall, apiPost } from '../api/client'

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

export const HERMELINCHAT_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.13'

// ---------------------------------------------------------------------------
// Module-level timer refs (not in store state)
// ---------------------------------------------------------------------------

let _pollTimer: ReturnType<typeof setInterval> | null = null
let _fastPollTimer: ReturnType<typeof setInterval> | null = null
let _fallbackTimer: ReturnType<typeof setInterval> | null = null

// Module-level mutable refs for fallback detection (mirror of App.jsx refs)
let _newSessionBaselineRef: Set<string> | null = null
let _newSessionStartedAt: number | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeGrouped(sessions: Session[]): GroupedSessions {
  const out: GroupedSessions = { Today: [], Yesterday: [], Earlier: [] }
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000

  for (const s of sessions) {
    const ts = (s.started_at || 0) * 1000
    if (ts >= startOfToday) out.Today.push(s)
    else if (ts >= startOfYesterday) out.Yesterday.push(s)
    else out.Earlier.push(s)
  }

  return out
}

function computeActiveSession(sessions: Session[], activeSessionId: string | null): Session | null {
  if (!activeSessionId) return null
  return sessions.find((s) => s.id === activeSessionId) || null
}

// ---------------------------------------------------------------------------
// Cross-store lazy accessors
//
// These stores are created in later tasks (Task 7 and Task 8).
// We use a registration pattern so this file compiles without depending on
// files that don't exist yet. The terminal and search stores will call
// `registerTerminalStore` / `registerSearchStore` at module load time.
// ---------------------------------------------------------------------------

interface TerminalStoreRef {
  spawn: (id: string | null) => void
}

interface SearchStoreRef {
  reset: () => void
  updateSessionTitle?: (sid: string, title: string) => void
  removeSession?: (sid: string) => void
}

let _terminalStore: TerminalStoreRef | null = null
let _searchStore: SearchStoreRef | null = null

export function registerTerminalStore(store: TerminalStoreRef) {
  _terminalStore = store
}

export function registerSearchStore(store: SearchStoreRef) {
  _searchStore = store
}

function getTerminalStore(): TerminalStoreRef | null {
  return _terminalStore
}

function getSearchStore(): SearchStoreRef | null {
  return _searchStore
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface SessionStore {
  sessions: Session[]
  activeSessionId: string | null
  runtimeInfo: RuntimeInfo

  // Derived state — recomputed whenever sessions or activeSessionId changes
  activeSession: Session | null
  grouped: GroupedSessions

  // Actions
  startPolling: () => void
  stopPolling: () => void
  startNewSession: () => void
  resumeSession: (id: string) => void
  setActiveSessionId: (sid: string) => void
  rename: (id: string, title: string) => Promise<void>
  deleteSess: (id: string) => Promise<void>
  fetchRuntimeInfo: () => Promise<void>
  reset: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  runtimeInfo: { loading: true, defaultModel: null, spawnCwd: null },
  activeSession: null,
  grouped: { Today: [], Yesterday: [], Earlier: [] },

  // -------------------------------------------------------------------------
  // Internal helper — update sessions and recompute derived state
  // -------------------------------------------------------------------------

  // Note: called via the closure below, not exposed on the interface

  // -------------------------------------------------------------------------
  // startPolling — sets up the regular 10s interval poll
  // -------------------------------------------------------------------------
  startPolling: () => {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }

    const load = async () => {
      if (!useAuthStore.getState().authenticated) {
        set((s) => ({
          sessions: [],
          grouped: { Today: [], Yesterday: [], Earlier: [] },
          activeSession: computeActiveSession([], s.activeSessionId),
        }))
        return
      }

      try {
        const data = await apiCall<{ sessions: Session[] }>('/api/sessions?limit=50')
        const sessions = data.sessions || []
        set((s) => ({
          sessions,
          grouped: computeGrouped(sessions),
          activeSession: computeActiveSession(sessions, s.activeSessionId),
        }))
      } catch {
        // apiCall handles 401 → setUnauthenticated automatically
      }
    }

    void load()
    _pollTimer = setInterval(load, 10_000)
  },

  // -------------------------------------------------------------------------
  // stopPolling — clears all polling intervals
  // -------------------------------------------------------------------------
  stopPolling: () => {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
    if (_fastPollTimer) { clearInterval(_fastPollTimer); _fastPollTimer = null }
    if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }
  },

  // -------------------------------------------------------------------------
  // setActiveSessionId — update active session and stop fast/fallback polls
  // -------------------------------------------------------------------------
  setActiveSessionId: (sid: string) => {
    // Clear new-session timestamps on explicit active session assignment
    _newSessionStartedAt = null
    _newSessionBaselineRef = null

    set((s) => ({
      activeSessionId: sid,
      activeSession: computeActiveSession(s.sessions, sid),
    }))

    // Stop fast-poll and fallback timers since we now have an active session
    if (_fastPollTimer) { clearInterval(_fastPollTimer); _fastPollTimer = null }
    if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }

    // Kick off fast-poll in case the session isn't in the list yet
    const { sessions } = get()
    const missing = !sessions.some((s) => s.id === sid)
    if (missing && useAuthStore.getState().authenticated) {
      _startFastPoll(sid)
    }
  },

  // -------------------------------------------------------------------------
  // startNewSession — snapshot baseline, reset state, spawn new pty
  // -------------------------------------------------------------------------
  startNewSession: () => {
    if (!useAuthStore.getState().authenticated) return

    const { sessions } = get()

    // Snapshot current session IDs as baseline for new-session detection
    _newSessionBaselineRef = new Set(sessions.map((s) => s?.id).filter(Boolean) as string[])
    _newSessionStartedAt = Date.now() / 1000

    set({ activeSessionId: null, activeSession: null })

    // Cross-store calls (wrapped — stores created in later tasks)
    try {
      getSearchStore()?.reset()
    } catch { /* not yet created */ }

    try {
      getTerminalStore()?.spawn(null)
    } catch { /* not yet created */ }
  },

  // -------------------------------------------------------------------------
  // resumeSession — set active session and spawn terminal with that ID
  // -------------------------------------------------------------------------
  resumeSession: (id: string) => {
    set((s) => ({
      activeSessionId: id,
      activeSession: computeActiveSession(s.sessions, id),
    }))

    _newSessionStartedAt = null
    _newSessionBaselineRef = null

    // Cross-store call
    try {
      getTerminalStore()?.spawn(id)
    } catch { /* not yet created */ }
  },

  // -------------------------------------------------------------------------
  // rename — POST /api/sessions/{id}/rename, optimistic update
  // -------------------------------------------------------------------------
  rename: async (id: string, title: string) => {
    const sid = String(id)
    const nextTitle = title.trim()

    const data = await apiPost<{ title?: string }>(
      `/api/sessions/${encodeURIComponent(sid)}/rename`,
      { title: nextTitle },
    )

    const finalTitle = String(data?.title || nextTitle).trim() || nextTitle

    set((s) => {
      const sessions = (s.sessions || []).map((sess) =>
        sess?.id === sid ? { ...sess, title: finalTitle, title_source: 'meta' } : sess,
      )
      return {
        sessions,
        grouped: computeGrouped(sessions),
        activeSession: computeActiveSession(sessions, s.activeSessionId),
      }
    })

    // Update search results if search store exists
    try {
      const searchStore = getSearchStore()
      if (searchStore?.updateSessionTitle) {
        searchStore.updateSessionTitle(sid, finalTitle)
      }
    } catch { /* not yet created */ }
  },

  // -------------------------------------------------------------------------
  // deleteSess — POST /api/sessions/{id}/delete, remove from list
  // -------------------------------------------------------------------------
  deleteSess: async (id: string) => {
    const sid = String(id)

    // If deleting the active session, start a new one first
    if (get().activeSessionId === sid) {
      get().startNewSession()
    }

    await apiPost(`/api/sessions/${encodeURIComponent(sid)}/delete`, {})

    set((s) => {
      const sessions = (s.sessions || []).filter((sess) => sess?.id !== sid)
      return {
        sessions,
        grouped: computeGrouped(sessions),
        activeSession: computeActiveSession(sessions, s.activeSessionId),
      }
    })

    // Update search results if search store exists
    try {
      const searchStore = getSearchStore()
      if (searchStore?.removeSession) {
        searchStore.removeSession(sid)
      }
    } catch { /* not yet created */ }
  },

  // -------------------------------------------------------------------------
  // fetchRuntimeInfo — fetch /api/info
  // -------------------------------------------------------------------------
  fetchRuntimeInfo: async () => {
    if (!useAuthStore.getState().authenticated) {
      set({ runtimeInfo: { loading: false, defaultModel: null, spawnCwd: null } })
      return
    }

    try {
      const data = await apiCall<{ default_model?: string | null; spawn_cwd?: string | null }>('/api/info')
      set({
        runtimeInfo: {
          loading: false,
          defaultModel: data.default_model || null,
          spawnCwd: data.spawn_cwd || null,
        },
      })
    } catch {
      set({ runtimeInfo: { loading: false, defaultModel: null, spawnCwd: null } })
    }
  },

  // -------------------------------------------------------------------------
  // reset — clear all session state (called on logout)
  // -------------------------------------------------------------------------
  reset: () => {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
    if (_fastPollTimer) { clearInterval(_fastPollTimer); _fastPollTimer = null }
    if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }
    _newSessionStartedAt = null
    _newSessionBaselineRef = null

    set({
      sessions: [],
      activeSessionId: null,
      activeSession: null,
      grouped: { Today: [], Yesterday: [], Earlier: [] },
      runtimeInfo: { loading: true, defaultModel: null, spawnCwd: null },
    })
  },
}))

// ---------------------------------------------------------------------------
// Fast-poll — 1s interval when activeSessionId is set but missing from list
// ---------------------------------------------------------------------------

function _startFastPoll(activeSessionId: string) {
  if (_fastPollTimer) { clearInterval(_fastPollTimer); _fastPollTimer = null }

  let tries = 0

  const tick = async () => {
    tries += 1
    try {
      const data = await apiCall<{ sessions: Session[] }>('/api/sessions?limit=50')
      const sessions = data.sessions || []
      useSessionStore.setState((s) => ({
        sessions,
        grouped: computeGrouped(sessions),
        activeSession: computeActiveSession(sessions, s.activeSessionId),
      }))
      const hasIt = sessions.some((s) => s.id === activeSessionId)
      if (hasIt || tries >= 15) {
        if (_fastPollTimer) { clearInterval(_fastPollTimer); _fastPollTimer = null }
      }
    } catch {
      if (tries >= 15) {
        if (_fastPollTimer) { clearInterval(_fastPollTimer); _fastPollTimer = null }
      }
    }
  }

  void tick()
  _fastPollTimer = setInterval(tick, 1000)
}

// ---------------------------------------------------------------------------
// Fallback detection — 1s interval when terminal is detecting and no active session
// Called externally (e.g. from terminal store or AppShell) when a new session
// is started and the terminal connects but hasn't yet detected a session ID.
// ---------------------------------------------------------------------------

export function startFallbackDetection() {
  if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }
  if (!_newSessionStartedAt) return
  if (!useAuthStore.getState().authenticated) return

  const startedAt = _newSessionStartedAt
  let tries = 0

  const tick = async () => {
    tries += 1
    try {
      const data = await apiCall<{ sessions: Session[] }>('/api/sessions?limit=50')
      const list = data.sessions || []

      useSessionStore.setState((s) => ({
        sessions: list,
        grouped: computeGrouped(list),
        activeSession: computeActiveSession(list, s.activeSessionId),
      }))

      const baseline = _newSessionBaselineRef
      const candidate = baseline
        ? list.find((s) => s?.id && !baseline.has(s.id))
        : list.find((s) => (s.started_at || 0) >= startedAt - 10)

      if (candidate?.id) {
        _newSessionStartedAt = null
        _newSessionBaselineRef = null

        useSessionStore.setState((s) => ({
          activeSessionId: candidate.id,
          activeSession: computeActiveSession(list, candidate.id),
          sessions: s.sessions,
        }))

        if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }
        return
      }
    } catch {
      // ignore
    }

    if (tries >= 20) {
      if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }
    }
  }

  void tick()
  _fallbackTimer = setInterval(tick, 1000)
}

export function stopFallbackDetection() {
  if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null }
}

// Export for terminal store to set when WS connects with no resumeId
export function setNewSessionStartedAt(ts: number | null) {
  _newSessionStartedAt = ts
}

export function getNewSessionStartedAt(): number | null {
  return _newSessionStartedAt
}
