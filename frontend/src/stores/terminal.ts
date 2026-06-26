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
  notePetActivity: (state: PetActivityState, holdMs?: number, afterState?: PetActivityState) => void
  reset: () => void
}

let petActivityTimer: ReturnType<typeof setTimeout> | null = null
let completionTimer: ReturnType<typeof setTimeout> | null = null
let lastOutputBeat = 0
let turnInFlight = false

function clearPetActivityTimer() {
  if (petActivityTimer !== null) {
    clearTimeout(petActivityTimer)
    petActivityTimer = null
  }
}

function clearCompletionTimer() {
  if (completionTimer !== null) {
    clearTimeout(completionTimer)
    completionTimer = null
  }
}

function clearPetTimers() {
  clearPetActivityTimer()
  clearCompletionTimer()
}

function inferPetStateFromOutput(text: string): PetActivityState {
  const clean = (text || '').toString()

  // Priority mirrors agent.pet.state.derive_pet_state: failure beats success,
  // success beats completion, blocked-on-user beats in-flight work.
  if (/\b(traceback|exception|error|failed|failure)\b|✗|❌/i.test(clean)) return 'failed'
  if (/\b(all todos? (done|complete|completed)|plan (done|complete|completed)|todos?.*(completed|cancelled).*(completed|cancelled))\b|🎉|✅/i.test(clean)) return 'jump'
  if (/\b(approval|approve|deny|clarify|confirmation|required confirmation|confirm\?|continue\?|waiting for (you|user))\b|\[[yY]\/n\]|\[y\/N\]/i.test(clean)) return 'waiting'
  if (/\b(review|thinking|reasoning|analyz|reading)\b/i.test(clean)) return 'review'
  if (/\b(tool|running|executing|fetching|searching|building|testing|installing|writing|patching)\b|\[terminal\]|\[tool\]/i.test(clean)) return 'run'

  // Visible output while a submitted turn is active means Hermes is busy even if
  // the text is ordinary assistant prose. Default Hermes maps unspecified busy
  // turns to `run`, then flashes `wave` once the turn completes.
  return turnInFlight ? 'run' : 'idle'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useTerminalStore = create<TerminalStore>((set, get) => {
  const scheduleCleanCompletion = () => {
    clearCompletionTimer()
    completionTimer = setTimeout(() => {
      completionTimer = null
      if (!turnInFlight) return
      turnInFlight = false
      get().notePetActivity('wave', 1600, 'idle')
    }, 950)
  }

  return {
    state: { phase: 'idle' },
    spawnNonce: 0,
    petActivity: { state: 'idle', updatedAt: Date.now() },

    notePetActivity: (state: PetActivityState, holdMs = 0, afterState: PetActivityState = 'idle') => {
      clearPetActivityTimer()
      set({ petActivity: { state, updatedAt: Date.now() } })
      if (holdMs > 0 && state !== afterState) {
        petActivityTimer = setTimeout(() => {
          petActivityTimer = null
          set({ petActivity: { state: afterState, updatedAt: Date.now() } })
        }, holdMs)
      }
    },

    noteUserInput: () => {
      // The user just submitted work to Hermes. Default Hermes shows model
      // thinking/reading as `review`; `waiting` is reserved for clarify/approval
      // prompts that block on the user.
      turnInFlight = true
      clearCompletionTimer()
      get().notePetActivity('review')
    },

    notePtyOutput: (text: string) => {
      const now = Date.now()
      if (now - lastOutputBeat < 250) return
      lastOutputBeat = now

      const state = inferPetStateFromOutput(text)
      if (state === 'idle') return

      if (state === 'failed') {
        turnInFlight = false
        clearCompletionTimer()
        get().notePetActivity('failed', 2800, 'idle')
        return
      }

      if (state === 'jump') {
        turnInFlight = false
        clearCompletionTimer()
        get().notePetActivity('jump', 1800, 'wave')
        setTimeout(() => {
          if (!turnInFlight) get().notePetActivity('wave', 1400, 'idle')
        }, 1850)
        return
      }

      if (state === 'waiting') {
        clearCompletionTimer()
        get().notePetActivity('waiting')
        return
      }

      get().notePetActivity(state)
      if (turnInFlight) scheduleCleanCompletion()
    },

    // -------------------------------------------------------------------------
    // spawn — initiate a terminal connection
    // -------------------------------------------------------------------------
    spawn: (resumeId: string | null) => {
      clearPetTimers()
      turnInFlight = false
      set((s) => ({
        state: { phase: 'connecting', resumeId },
        spawnNonce: s.spawnNonce + 1,
        petActivity: { state: 'run', updatedAt: Date.now() },
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
        clearPetTimers()
        turnInFlight = false
        set({ state: { phase: 'idle' }, petActivity: { state: 'idle', updatedAt: Date.now() } })
        return
      }

      get().notePetActivity('idle')

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

      get().notePetActivity('wave', 1800, 'idle')

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
      clearPetTimers()
      lastOutputBeat = 0
      turnInFlight = false
      set({ state: { phase: 'idle' }, spawnNonce: 0, petActivity: { state: 'idle', updatedAt: Date.now() } })
    },
  }
})

// ---------------------------------------------------------------------------
// Derived selector
// ---------------------------------------------------------------------------

export const selectConnected = (s: { state: TerminalState }): boolean =>
  s.state.phase === 'connected' || s.state.phase === 'detecting'

// ---------------------------------------------------------------------------
// Register with sessions store to enable cross-store calls
// ---------------------------------------------------------------------------

registerTerminalStore(useTerminalStore.getState())
