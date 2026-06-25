import { create } from 'zustand'
import type { PetActivityState, TerminalState } from '../types'
import {
  useSessionStore,
  registerTerminalStore,
  startFallbackDetection,
} from './sessions'

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface PetActivity {
  state: PetActivityState
  updatedAt: number
}

interface TerminalStore {
  state: TerminalState
  spawnNonce: number
  petActivity: PetActivity
  spawn: (resumeId: string | null) => void
  onConnectionChange: (isUp: boolean, nonce?: number) => void
  onDetectedSessionId: (sid: string) => void
  noteUserInput: () => void
  notePtyOutput: (text: string) => void
  notePetActivity: (state: PetActivityState, holdMs?: number) => void
  reset: () => void
}

let petActivityTimer: ReturnType<typeof setTimeout> | null = null
let lastOutputBeat = 0

function clearPetActivityTimer() {
  if (petActivityTimer !== null) {
    clearTimeout(petActivityTimer)
    petActivityTimer = null
  }
}

function inferPetStateFromOutput(text: string): PetActivityState {
  const clean = (text || '').toString()
  if (/\b(traceback|exception|error|failed|failure)\b|✗|❌/i.test(clean)) return 'failed'
  if (/\b(review|thinking|reasoning|analyz)/i.test(clean)) return 'review'
  if (/\b(tool|running|executing|fetching|searching|building|testing)\b|\[terminal\]|\[tool\]/i.test(clean)) return 'running'
  return 'running'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  state: { phase: 'idle' },
  spawnNonce: 0,
  petActivity: { state: 'idle', updatedAt: Date.now() },

  notePetActivity: (state: PetActivityState, holdMs = 0) => {
    clearPetActivityTimer()
    set({ petActivity: { state, updatedAt: Date.now() } })
    if (holdMs > 0 && state !== 'idle') {
      petActivityTimer = setTimeout(() => {
        petActivityTimer = null
        set({ petActivity: { state: 'idle', updatedAt: Date.now() } })
      }, holdMs)
    }
  },

  noteUserInput: () => {
    get().notePetActivity('waiting', 1600)
  },

  notePtyOutput: (text: string) => {
    const now = Date.now()
    if (now - lastOutputBeat < 350) return
    lastOutputBeat = now
    const state = inferPetStateFromOutput(text)
    get().notePetActivity(state, state === 'failed' ? 2800 : 1200)
  },

  // -------------------------------------------------------------------------
  // spawn — initiate a terminal connection
  // -------------------------------------------------------------------------
  spawn: (resumeId: string | null) => {
    set((s) => ({
      state: { phase: 'connecting', resumeId },
      spawnNonce: s.spawnNonce + 1,
      petActivity: { state: 'waiting', updatedAt: Date.now() },
    }))

    if (resumeId !== null) {
      useSessionStore.getState().setActiveSessionId(resumeId)
    }
  },

  // -------------------------------------------------------------------------
  // onConnectionChange — called when the WS connects or disconnects
  // -------------------------------------------------------------------------
  onConnectionChange: (isUp: boolean, nonce?: number) => {
    const { state, spawnNonce } = get()

    if (nonce !== undefined && nonce !== spawnNonce) {
      return
    }

    if (!isUp) {
      clearPetActivityTimer()
      set({ state: { phase: 'idle' }, petActivity: { state: 'idle', updatedAt: Date.now() } })
      return
    }

    get().notePetActivity('waiting', 1400)

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

    get().notePetActivity('waving', 1800)

    if (state.phase === 'connected' && state.resumeId !== null) {
      // Resume flows already know which session they requested. If the backend later
      // echoes the same "Session: ..." line, keep the resumeId instead of clearing it.
      // Clearing it causes TerminalPane's websocket effect to reconnect without the
      // ?resume=... query param, which starts a fresh session and drops the resumed one.
      useSessionStore.getState().setActiveSessionId(sid)
      return
    }

    set({ state: { phase: 'connected', resumeId: null } })
    useSessionStore.getState().setActiveSessionId(sid)
  },

  // -------------------------------------------------------------------------
  // reset — return to initial state
  // -------------------------------------------------------------------------
  reset: () => {
    clearPetActivityTimer()
    lastOutputBeat = 0
    set({ state: { phase: 'idle' }, spawnNonce: 0, petActivity: { state: 'idle', updatedAt: Date.now() } })
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
