import { create } from 'zustand'
import type { TerminalState } from '../types'
import {
  useSessionStore,
  registerTerminalStore,
  startFallbackDetection,
} from './sessions'

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface TerminalStore {
  state: TerminalState
  spawnNonce: number
  spawn: (resumeId: string | null) => void
  onConnectionChange: (isUp: boolean) => void
  onDetectedSessionId: (sid: string) => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  state: { phase: 'idle' },
  spawnNonce: 0,

  // -------------------------------------------------------------------------
  // spawn — initiate a terminal connection
  // -------------------------------------------------------------------------
  spawn: (resumeId: string | null) => {
    set((s) => ({
      state: { phase: 'connecting', resumeId },
      spawnNonce: s.spawnNonce + 1,
    }))

    if (resumeId !== null) {
      useSessionStore.getState().setActiveSessionId(resumeId)
    }
  },

  // -------------------------------------------------------------------------
  // onConnectionChange — called when the WS connects or disconnects
  // -------------------------------------------------------------------------
  onConnectionChange: (isUp: boolean) => {
    const { state } = get()

    if (!isUp) {
      set({ state: { phase: 'idle' } })
      return
    }

    if (state.phase !== 'connecting') return

    if (state.resumeId !== null) {
      // Resume an existing session — go straight to connected
      set({ state: { phase: 'connected', resumeId: state.resumeId } })
    } else {
      // New session — enter detecting phase; snapshot baseline session IDs
      const sessions = useSessionStore.getState().sessions
      const baselineIds = new Set(
        sessions.map((s) => s?.id).filter(Boolean) as string[],
      )

      set({
        state: {
          phase: 'detecting',
          resumeId: null,
          startedAt: Date.now() / 1000,
          baselineIds,
        },
      })

      // Start fallback detection polling in the sessions store
      startFallbackDetection()
    }
  },

  // -------------------------------------------------------------------------
  // onDetectedSessionId — called when terminal output reveals the session ID
  // -------------------------------------------------------------------------
  onDetectedSessionId: (sid: string) => {
    const { state } = get()

    if (state.phase !== 'detecting' && state.phase !== 'connected') return

    set({ state: { phase: 'connected', resumeId: null } })
    useSessionStore.getState().setActiveSessionId(sid)
  },

  // -------------------------------------------------------------------------
  // reset — return to initial state
  // -------------------------------------------------------------------------
  reset: () => {
    set({ state: { phase: 'idle' }, spawnNonce: 0 })
  },
}))

// ---------------------------------------------------------------------------
// Derived selector
// ---------------------------------------------------------------------------

export const selectConnected = (s: { state: TerminalState }): boolean =>
  s.state.phase === 'connected' || s.state.phase === 'detecting'

// ---------------------------------------------------------------------------
// Register with sessions store to enable cross-store calls
// ---------------------------------------------------------------------------

registerTerminalStore(useTerminalStore.getState())
