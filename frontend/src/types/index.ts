// ─── Session ───────────────────────────────────────────────────────

export interface Session {
  id: string
  title: string
  title_source?: string
  model?: string | null
  started_at?: number
  started_at_iso?: string | null
}

export interface GroupedSessions {
  Today: Session[]
  Yesterday: Session[]
  Earlier: Session[]
}

// ─── Search ────────────────────────────────────────────────────────

export interface SearchHit {
  id: string
  session_id: string
  session_title?: string
  session_model?: string | null
  role?: string
  text?: string
  snippet?: string
  timestamp?: number
  timestamp_iso?: string | null
}

export interface SearchGroup {
  session_id: string
  title: string
  model: string | null
  hits: SearchHit[]
}

// ─── Artifacts ─────────────────────────────────────────────────────

export interface ArtifactTab {
  id: string
  type: string
  title?: string
  timestamp?: number
  [key: string]: unknown
}

// ─── UI Prefs ──────────────────────────────────────────────────────

export interface ParticlePrefs {
  enabled: boolean
  intensity: number
}

export interface BackgroundPrefs {
  effect: string
}

export interface TimestampPrefs {
  enabled: boolean
}

export interface TerminalPrefs {
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
}

export interface VideoFxPrefs {
  enabled: boolean
  intensity: number
  glitchPulses: boolean
}

export interface UiPrefs {
  theme: string
  appName: string
  particles: ParticlePrefs
  background: BackgroundPrefs
  timestamps: TimestampPrefs
  terminal: TerminalPrefs
  videoFx: VideoFxPrefs
}

// ─── Auth ──────────────────────────────────────────────────────────

export interface AuthState {
  loading: boolean
  enabled: boolean
  authenticated: boolean
}

// ─── Runtime ───────────────────────────────────────────────────────

export interface RuntimeInfo {
  loading: boolean
  defaultModel: string | null
  spawnCwd: string | null
}

// ─── Peek ──────────────────────────────────────────────────────────

export interface PeekMessage {
  id: string
  role: string
  content: string
  content_truncated?: boolean
  timestamp_iso?: string | null
  is_target?: boolean
}

export interface PeekContext {
  session_id?: string
  session_title?: string
  session_model?: string | null
  messages?: PeekMessage[]
}

export interface PeekState {
  open: boolean
  loading: boolean
  error: string
  context: PeekContext | null
  hit: SearchHit | null
}

// ─── Session Menu ──────────────────────────────────────────────────

export interface SessionMenu {
  session_id: string
  title: string
  left: number
  top: number
}

// ─── Terminal State Machine ────────────────────────────────────────

export type TerminalPhase = 'idle' | 'connecting' | 'connected' | 'detecting'

export type TerminalState =
  | { phase: 'idle' }
  | { phase: 'connecting'; resumeId: string | null }
  | { phase: 'connected'; resumeId: string | null }
  | { phase: 'detecting'; resumeId: null; startedAt: number; baselineIds: Set<string> }
