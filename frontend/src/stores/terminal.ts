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

interface PetActivitySignals {
  awaitingInput?: boolean
  busy?: boolean
  celebrate?: boolean
  error?: boolean
  justCompleted?: boolean
  reasoning?: boolean
  toolRunning?: boolean
}

interface PetSyncDebug {
  active: boolean
  awaitingInput: boolean
  busy: boolean
  lastEventAt: number
  lastEventType: string
  reasoning: boolean
  state: PetActivityState
  tools: string[]
  trace: Array<{
    at: number
    event: string
    state: PetActivityState
    tools: string[]
  }>
}

declare global {
  interface Window {
    __HERMELIN_PET_SYNC__?: PetSyncDebug
  }
}

interface TerminalStore {
  state: TerminalState
  spawnNonce: number
  petActivity: PetActivity
  spawn: (resumeId: string | null) => void
  onConnectionChange: (isUp: boolean, nonce?: number) => void
  onDetectedSessionId: (sid: string) => void
  noteUserInput: (data?: string) => void
  notePtyOutput: (text: string) => void
  notePetSyncMode: (info: unknown) => void
  noteHermesPetEvent: (event: unknown) => void
  notePetActivity: (state: PetActivityState, holdMs?: number, afterState?: PetActivityState) => void
  reset: () => void
}

let petActivityTimer: ReturnType<typeof setTimeout> | null = null
let completionTimer: ReturnType<typeof setTimeout> | null = null
let lastOutputBeat = 0
let turnInFlight = false
let pendingUserInput = ''
let structuredPetSyncActive = false
let hermesBusy = false
let hermesReasoningActive = false
let hermesAwaitingInput = false
let hermesTodosDone = false
let lastStructuredEventAt = 0
let lastStructuredEventType = ''
let structuredSettleTimer: ReturnType<typeof setTimeout> | null = null
const STRUCTURED_STALE_MS = 2500
const STRUCTURED_SETTLE_MS = 10000
const PET_TRACE_LIMIT = 80
const hermesActiveToolIds = new Set<string>()
const petSyncTrace: PetSyncDebug['trace'] = []

function resetStructuredPetState() {
  hermesBusy = false
  hermesReasoningActive = false
  hermesAwaitingInput = false
  hermesTodosDone = false
  hermesActiveToolIds.clear()
}

function derivePetState(signals: PetActivitySignals): PetActivityState {
  if (signals.error) return 'failed'
  if (signals.celebrate) return 'jump'
  if (signals.justCompleted) return 'wave'
  if (signals.awaitingInput) return 'waiting'
  if (signals.toolRunning) return 'run'
  if (signals.reasoning) return 'review'
  if (signals.busy) return 'run'
  return 'idle'
}

function deriveStructuredPetState(): PetActivityState {
  // Mirror Hermes desktop/TUI: steady tool/reasoning flags only count while the
  // turn is actually busy, so stale flags cannot pin the pet on run/review.
  return derivePetState({
    awaitingInput: hermesAwaitingInput,
    busy: hermesBusy,
    reasoning: hermesBusy && hermesReasoningActive,
    toolRunning: hermesBusy && hermesActiveToolIds.size > 0,
  })
}

function recordPetSyncDebug(event: string, state: PetActivityState) {
  lastStructuredEventType = event
  petSyncTrace.push({
    at: Date.now(),
    event,
    state,
    tools: [...hermesActiveToolIds],
  })
  while (petSyncTrace.length > PET_TRACE_LIMIT) petSyncTrace.shift()

  if (typeof window === 'undefined') return
  window.__HERMELIN_PET_SYNC__ = {
    active: structuredPetSyncActive,
    awaitingInput: hermesAwaitingInput,
    busy: hermesBusy,
    lastEventAt: lastStructuredEventAt,
    lastEventType: lastStructuredEventType,
    reasoning: hermesReasoningActive,
    state,
    tools: [...hermesActiveToolIds],
    trace: [...petSyncTrace],
  }
}

function normaliseHermesEvent(event: unknown): { type: string; payload: Record<string, unknown> } | null {
  if (!event || typeof event !== 'object') return null
  const raw = event as Record<string, unknown>
  const params = raw.method === 'event' && raw.params && typeof raw.params === 'object'
    ? (raw.params as Record<string, unknown>)
    : raw
  const type = String(params.type || '').trim()
  if (!type) return null
  const payload = params.payload && typeof params.payload === 'object'
    ? (params.payload as Record<string, unknown>)
    : {}
  return { type, payload }
}

function toolIdFromPayload(payload: Record<string, unknown>): string {
  return String(payload.tool_id ?? payload.id ?? '').trim()
}

function toolKeyFromPayload(payload: Record<string, unknown>): string {
  return toolIdFromPayload(payload) || String(payload.name ?? 'tool').trim() || 'tool'
}

function todosDone(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => {
    if (!item || typeof item !== 'object') return false
    const status = String((item as Record<string, unknown>).status ?? '')
    return status === 'completed' || status === 'cancelled'
  })
}

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

function clearStructuredSettleTimer() {
  if (structuredSettleTimer !== null) {
    clearTimeout(structuredSettleTimer)
    structuredSettleTimer = null
  }
}

function clearPetTimers() {
  clearPetActivityTimer()
  clearCompletionTimer()
  clearStructuredSettleTimer()
}

function skipEscapeSequence(text: string, start: number): number {
  const next = text[start + 1]
  if (next === '[') {
    for (let i = start + 2; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i
    }
    return text.length - 1
  }

  if (next === ']') {
    for (let i = start + 2; i < text.length; i += 1) {
      if (text[i] === '\u0007') return i
      if (text[i] === '\u001b' && text[i + 1] === '\\') return i + 1
    }
    return text.length - 1
  }

  return Math.min(start + 1, text.length - 1)
}

function terminalInputSubmitsNonEmptyText(data = ''): boolean {
  let submitted = false

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]
    const code = data.charCodeAt(i)

    if (ch === '\u001b') {
      i = skipEscapeSequence(data, i)
      continue
    }

    if (ch === '\u0003' || ch === '\u0004') {
      pendingUserInput = ''
      turnInFlight = false
      clearCompletionTimer()
      continue
    }

    if (ch === '\b' || ch === '\u007f') {
      pendingUserInput = pendingUserInput.slice(0, -1)
      continue
    }

    if (ch === '\r' || ch === '\n') {
      if (pendingUserInput.trim().length > 0) submitted = true
      pendingUserInput = ''
      continue
    }

    if (code < 32 || code === 0x7f) continue
    pendingUserInput += ch
  }

  return submitted
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

  const applyStructuredPetState = (event = lastStructuredEventType || 'state') => {
    clearPetActivityTimer()
    const state = deriveStructuredPetState()
    set({ petActivity: { state, updatedAt: Date.now() } })
    recordPetSyncDebug(event, state)
  }

  const scheduleStructuredCompletionFallback = () => {
    clearStructuredSettleTimer()
    const scheduledAt = Date.now()
    structuredSettleTimer = setTimeout(() => {
      structuredSettleTimer = null
      if (!structuredPetSyncActive) return
      if (!hermesBusy || hermesAwaitingInput || hermesActiveToolIds.size > 0) return
      if (lastStructuredEventAt > scheduledAt) return

      const flashState: PetActivityState = hermesTodosDone ? 'jump' : 'wave'
      turnInFlight = false
      pendingUserInput = ''
      resetStructuredPetState()
      get().notePetActivity(flashState, 1600, 'idle')
      recordPetSyncDebug('watchdog.complete', flashState)
    }, STRUCTURED_SETTLE_MS)
  }

  return {
    state: { phase: 'idle' },
    spawnNonce: 0,
    petActivity: { state: 'idle', updatedAt: Date.now() },

    notePetActivity: (state: PetActivityState, holdMs = 0, afterState: PetActivityState = 'idle') => {
      clearPetActivityTimer()
      set({ petActivity: { state, updatedAt: Date.now() } })
      recordPetSyncDebug(`flash.${state}`, state)
      if (holdMs > 0 && state !== afterState) {
        petActivityTimer = setTimeout(() => {
          petActivityTimer = null
          set({ petActivity: { state: afterState, updatedAt: Date.now() } })
          recordPetSyncDebug(`flash.after.${afterState}`, afterState)
        }, holdMs)
      }
    },

    notePetSyncMode: (info: unknown) => {
      const mode = info && typeof info === 'object'
        ? String((info as Record<string, unknown>).mode || '')
        : String(info || '')
      structuredPetSyncActive = mode === 'structured'
      resetStructuredPetState()
      clearPetTimers()
      lastStructuredEventAt = Date.now()
      lastStructuredEventType = 'pet_sync'
      if (structuredPetSyncActive) {
        turnInFlight = false
        pendingUserInput = ''
        lastOutputBeat = 0
        set({ petActivity: { state: 'idle', updatedAt: Date.now() } })
        recordPetSyncDebug('pet_sync', 'idle')
      }
    },

    noteHermesPetEvent: (event: unknown) => {
      const ev = normaliseHermesEvent(event)
      if (!ev) return

      structuredPetSyncActive = true
      lastStructuredEventAt = Date.now()
      lastStructuredEventType = ev.type
      clearCompletionTimer()
      clearStructuredSettleTimer()

      switch (ev.type) {
        case 'message.start':
          turnInFlight = true
          hermesBusy = true
          hermesReasoningActive = false
          hermesAwaitingInput = false
          hermesTodosDone = false
          hermesActiveToolIds.clear()
          applyStructuredPetState(ev.type)
          return

        case 'thinking.delta':
        case 'reasoning.delta':
        case 'reasoning.available':
          if ((ev.type === 'thinking.delta' || ev.type === 'reasoning.delta') && !String(ev.payload.text ?? '')) {
            return
          }
          hermesBusy = true
          hermesReasoningActive = true
          applyStructuredPetState(ev.type)
          return

        case 'tool.start':
          hermesBusy = true
          hermesReasoningActive = false
          hermesAwaitingInput = false
          if (todosDone(ev.payload.todos)) hermesTodosDone = true
          hermesActiveToolIds.add(toolKeyFromPayload(ev.payload))
          applyStructuredPetState(ev.type)
          return

        case 'tool.complete':
          if (todosDone(ev.payload.todos)) hermesTodosDone = true
          {
            const id = toolIdFromPayload(ev.payload)
            if (id) {
              hermesActiveToolIds.delete(id)
            } else {
              // Hermes should send `tool_id`, but if the sidecar/gateway ever
              // drops it, do not leave an un-clearable active tool that pins
              // the pet on `run` forever. Completion without identity is still
              // a real lifecycle edge for the current tool batch.
              const name = String(ev.payload.name ?? '').trim()
              if (!name || !hermesActiveToolIds.delete(name)) hermesActiveToolIds.clear()
            }
          }
          hermesReasoningActive = false
          hermesAwaitingInput = false
          hermesBusy = true
          applyStructuredPetState(ev.type)
          return

        case 'message.delta':
          hermesBusy = true
          hermesReasoningActive = false
          applyStructuredPetState(ev.type)
          scheduleStructuredCompletionFallback()
          return

        case 'clarify.request':
        case 'approval.request':
        case 'sudo.request':
        case 'secret.request':
          hermesBusy = true
          hermesAwaitingInput = true
          applyStructuredPetState(ev.type)
          return

        case 'message.complete': {
          const flashState: PetActivityState = hermesTodosDone || todosDone(ev.payload.todos) ? 'jump' : 'wave'
          turnInFlight = false
          pendingUserInput = ''
          clearStructuredSettleTimer()
          resetStructuredPetState()
          get().notePetActivity(flashState, 1600, 'idle')
          return
        }

        case 'error':
          turnInFlight = false
          pendingUserInput = ''
          clearStructuredSettleTimer()
          resetStructuredPetState()
          get().notePetActivity('failed', 1600, 'idle')
          return

        default:
          return
      }
    },

    noteUserInput: (data = '') => {
      if (!terminalInputSubmitsNonEmptyText(data)) return

      turnInFlight = true
      lastOutputBeat = 0
      clearCompletionTimer()
      if (!structuredPetSyncActive) {
        get().notePetActivity('review')
      }
    },

    notePtyOutput: (text: string) => {
      if (structuredPetSyncActive && (!turnInFlight || Date.now() - lastStructuredEventAt < STRUCTURED_STALE_MS)) return
      if (!turnInFlight) return

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
      pendingUserInput = ''
      structuredPetSyncActive = false
      resetStructuredPetState()
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
        pendingUserInput = ''
        structuredPetSyncActive = false
        resetStructuredPetState()
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

      const activeSessionId = useSessionStore.getState().activeSessionId
      if (state.phase === 'connected' && (activeSessionId === sid || state.resumeId === sid)) {
        useSessionStore.getState().setActiveSessionId(sid)
        return
      }

      if (!structuredPetSyncActive) get().notePetActivity('wave', 1800, 'idle')

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
      pendingUserInput = ''
      structuredPetSyncActive = false
      resetStructuredPetState()
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
