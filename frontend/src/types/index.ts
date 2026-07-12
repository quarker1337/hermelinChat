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

export type PetOverlayPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export type PetActivityState = 'idle' | 'wave' | 'run' | 'failed' | 'review' | 'jump' | 'waiting'

export interface PetOverlayPrefs {
  // Browser-local master toggle for the HermelinChat overlay. Does not mutate Hermes config.
  enabled: boolean
  position: PetOverlayPosition
  // Local browser-only multiplier, expressed as percent. 100 = Hermes pet scale.
  size: number
  // Empty string means "follow Hermes active pet". Any value is an installed pet slug override.
  slug: string
}

export interface UiPrefs {
  theme: string
  appName: string
  particles: ParticlePrefs
  background: BackgroundPrefs
  timestamps: TimestampPrefs
  terminal: TerminalPrefs
  videoFx: VideoFxPrefs
  petOverlay: PetOverlayPrefs
}

// ─── Auth ──────────────────────────────────────────────────────────

export interface AuthState {
  loading: boolean
  enabled: boolean
  authenticated: boolean
  logoutReason: 'explicit' | 'expired' | null
  sessionTtlSeconds: number | null
}

// ─── Runtime ───────────────────────────────────────────────────────

export interface RuntimeInfo {
  loading: boolean
  defaultModel: string | null
  spawnCwd: string | null
  runtimeBackend?: string | null
  runtimeAutostartDefault?: boolean
}

export interface HermesRuntimeProfile {
  name: string
  label?: string
  is_default?: boolean
  configured?: boolean
  model?: string | null
}

export interface HermesRuntimeConfig {
  enabled: boolean
  backend: string
  available: boolean
  configured_backend: string
  autostart_default: boolean
  tmux_prefix?: string
  registry_path?: string
  profiles?: HermesRuntimeProfile[]
  default_profile?: string
  error?: string | null
}

export interface HermesRuntime {
  runtime_id: string
  node?: string
  title: string
  profile: string
  cwd: string
  state: string
  source: string
  backend: string
  tmux_name?: string | null
  hermes_pid?: number | null
  active_hermes_session_id?: string | null
  created_at?: string
  updated_at?: string
  last_attached_at?: string | null
  last_seen_at?: string | null
  metadata?: Record<string, unknown>
  can_attach?: boolean
  can_stop?: boolean
  attach_ws_path?: string
}

export interface HermesRuntimeListResponse {
  runtimes: HermesRuntime[]
  last_active_runtime_id?: string | null
}

// ─── HermelinFleet ─────────────────────────────────────────────────

export interface FleetConfig {
  mode: 'off' | 'external' | 'local'
  enabled: boolean
  configured: boolean
  available: boolean
  admin_token_configured: boolean
}

export interface FleetSnapshot {
  config: FleetConfig
  status: FleetStatusSummary
  nodes: FleetNode[]
  agents: FleetAgent[]
  runtimes: FleetRuntimeListResponse
  sessions: FleetSession[]
  capabilities: FleetCapabilities
}

export interface FleetStatusSummary {
  ok?: boolean
  ts?: string
  dispatcher_configured?: boolean
  nodes: number
  agents: number
  sessions: number
  capabilities: string[]
}

export interface FleetNode {
  node: string
  state: string
  last_heartbeat?: string | null
  agent_count: number
  agent_ids: string[]
  capabilities: string[]
  state_counts: Record<string, number>
  metadata?: Record<string, string>
}

export interface FleetSessionRef {
  session_id: string
  title?: string
  profile?: string
  mode?: string
  runtime_activity?: string
  message_count?: number
}

export interface FleetAgent {
  agent_id: string
  kind: string
  host: string
  node?: string
  ts?: string
  state: string
  task?: Record<string, unknown> | null
  resources?: Record<string, unknown>
  cost?: Record<string, unknown> | null
  exit_code?: number | null
  capabilities: string[]
  adapter_version?: string
  metadata?: Record<string, string>
  session?: FleetSessionRef | null
  can_inject: boolean
}

export interface FleetSession {
  session_id: string
  title?: string
  profile?: string
  mode?: string
  state: string
  runtime_activity?: string
  last_user_message?: string
  message_count?: number
  started_at?: string
  last_message_at?: string
  provider?: string
  model?: string
  agent_id: string
  agent_ids: string[]
  node?: string
  nodes: string[]
  host?: string
  kind?: string
  capabilities: string[]
  can_inject: boolean
}

export interface FleetAgentCapabilities {
  agent_id: string
  kind: string
  node?: string
  verbs: string[]
}

export interface FleetCapabilities {
  verbs: string[]
  by_kind: Record<string, string[]>
  by_node: Record<string, string[]>
  by_agent: FleetAgentCapabilities[]
  inject_agents: string[]
}

export interface FleetLogsResponse {
  agent_id: string
  logs?: string
  result?: Record<string, unknown>
}

export interface FleetRuntimeListResponse {
  runtimes: HermesRuntime[]
}

export interface FleetRuntimeCreateResponse {
  runtime?: HermesRuntime
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
