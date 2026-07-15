import { create } from 'zustand'
import { apiCall, apiPost } from '../api/client'
import type {
  FleetAgent,
  FleetCapabilities,
  FleetConfig,
  FleetLogsResponse,
  FleetNode,
  FleetRuntimeCreateResponse,
  FleetSession,
  FleetSnapshot,
  FleetStatusSummary,
  HermesRuntime,
} from '../types'

const EMPTY_CONFIG: FleetConfig = {
  mode: 'off',
  enabled: false,
  configured: false,
  available: false,
  admin_token_configured: false,
}

const EMPTY_CAPABILITIES: FleetCapabilities = {
  verbs: [],
  by_kind: {},
  by_node: {},
  by_agent: [],
  inject_agents: [],
}

let _pollTimer: ReturnType<typeof setTimeout> | null = null
let _refreshInFlight = false
let _pollActive = false
let _pollFailures = 0

const POLL_DELAYS_MS = [5_000, 10_000, 30_000, 60_000] as const

export function fleetBackoffDelay(failureCount: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(Math.trunc(failureCount) - 1, 0), POLL_DELAYS_MS.length - 1)
  const jitter = 1 + Math.max(0, Math.min(1, random())) * 0.2
  return Math.round(POLL_DELAYS_MS[index] * jitter)
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export function hermesSkinForUiTheme(theme: string | null | undefined): string {
  const normalized = String(theme || '').trim().toLowerCase()
  if (['hermelin', 'matrix', 'nous', 'samaritan'].includes(normalized)) return normalized
  return ''
}

export function isFleetSessionAgent(agent: FleetAgent | null | undefined): boolean {
  return Boolean(
    agent?.session?.session_id ||
      agent?.can_inject ||
      (Array.isArray(agent?.capabilities) && agent.capabilities.includes('inject_task')),
  )
}

export function preferredFleetAgentId(
  agents: FleetAgent[],
  sessions: FleetSession[],
  currentAgentId: string | null | undefined,
): string | null {
  const agentIds = new Set(agents.map((agent) => agent.agent_id))
  const sessionAgentIds = sessions.map((session) => session.agent_id).filter((id): id is string => Boolean(id && agentIds.has(id)))

  if (currentAgentId) {
    const current = agents.find((agent) => agent.agent_id === currentAgentId)
    if (current && (sessionAgentIds.includes(current.agent_id) || isFleetSessionAgent(current))) return current.agent_id
  }

  if (sessionAgentIds.length) return sessionAgentIds[0]
  return agents.find(isFleetSessionAgent)?.agent_id || null
}

export function normalizeFleetConfig(value: Partial<FleetConfig> | null | undefined): FleetConfig {
  const rawMode = String(value?.mode || '').toLowerCase()
  const mode = rawMode === 'external' || rawMode === 'local' ? rawMode : 'off'
  return {
    mode,
    enabled: Boolean(value?.enabled),
    configured: Boolean(value?.configured),
    available: Boolean(value?.available),
    admin_token_configured: Boolean(value?.admin_token_configured),
  }
}

function normalizeFleetRuntime(raw: Partial<HermesRuntime> | null | undefined): HermesRuntime | null {
  if (!raw?.runtime_id) return null
  const runtimeId = String(raw.runtime_id)
  const node = raw.node ? String(raw.node) : String(raw.metadata?.node || '')
  const derivedAttachPath = node
    ? `/ws/fleet/nodes/${encodeURIComponent(node)}/runtimes/${encodeURIComponent(runtimeId)}/attach`
    : ''
  return {
    runtime_id: runtimeId,
    node,
    title: String(raw.title || runtimeId),
    display_title: raw.display_title ? String(raw.display_title) : null,
    session_title: raw.session_title ? String(raw.session_title) : null,
    profile: String(raw.profile || 'fleet'),
    cwd: String(raw.cwd || ''),
    state: String(raw.state || 'idle'),
    source: String(raw.source || 'fleet_remote'),
    backend: String(raw.backend || 'fleet-tmux'),
    tmux_name: raw.tmux_name ?? null,
    hermes_pid: typeof raw.hermes_pid === 'number' ? raw.hermes_pid : null,
    active_hermes_session_id: raw.active_hermes_session_id ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    last_attached_at: raw.last_attached_at ?? null,
    last_seen_at: raw.last_seen_at ?? null,
    metadata: raw.metadata || {},
    can_attach: raw.can_attach !== false,
    can_stop: raw.can_stop !== false,
    attach_ws_path: String(derivedAttachPath || raw.attach_ws_path || ''),
  }
}

export interface FleetStore {
  config: FleetConfig
  status: FleetStatusSummary | null
  nodes: FleetNode[]
  agents: FleetAgent[]
  runtimes: HermesRuntime[]
  sessions: FleetSession[]
  capabilities: FleetCapabilities
  selectedAgentId: string | null
  logsByAgent: Record<string, string>
  loading: boolean
  error: string
  logsLoadingAgentId: string | null
  injectingAgentId: string | null
  lastRefreshAt: number | null
  lastAttemptAt: number | null
  stale: boolean

  refreshConfig: () => Promise<FleetConfig>
  refreshSnapshot: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  selectAgent: (agentId: string | null) => void
  fetchLogs: (agentId: string) => Promise<void>
  injectAgent: (agentId: string, message: string, sessionId?: string) => Promise<void>
  createRuntime: (node: string, title?: string, opts?: { resumeId?: string | null; uiTheme?: string | null; skin?: string | null }) => Promise<HermesRuntime | null>
  bindRuntimeSession: (attachPath: string, sessionId: string) => void
  stopRuntime: (node: string, runtimeId: string) => Promise<void>
  reset: () => void
}

export const useFleetStore = create<FleetStore>((set, get) => ({
  config: EMPTY_CONFIG,
  status: null,
  nodes: [],
  agents: [],
  runtimes: [],
  sessions: [],
  capabilities: EMPTY_CAPABILITIES,
  selectedAgentId: null,
  logsByAgent: {},
  loading: false,
  error: '',
  logsLoadingAgentId: null,
  injectingAgentId: null,
  lastRefreshAt: null,
  lastAttemptAt: null,
  stale: false,

  refreshConfig: async () => {
    const config = normalizeFleetConfig(await apiCall<FleetConfig>('/api/fleet/config'))
    set({ config })
    return config
  },

  refreshSnapshot: async () => {
    if (_refreshInFlight) return
    _refreshInFlight = true
    set({ loading: true, error: '', lastAttemptAt: Date.now() })

    try {
      const config = normalizeFleetConfig(await apiCall<FleetConfig>('/api/fleet/config'))
      if (!config.enabled) {
        _pollFailures = 0
        set({
          config,
          status: null,
          nodes: [],
          agents: [],
          runtimes: [],
          sessions: [],
          capabilities: EMPTY_CAPABILITIES,
          selectedAgentId: null,
          loading: false,
          stale: false,
          lastRefreshAt: Date.now(),
        })
        return
      }

      const snapshot = await apiCall<FleetSnapshot>('/api/fleet/snapshot')
      const nextConfig = normalizeFleetConfig(snapshot?.config || config)
      const nextAgents = asArray<FleetAgent>(snapshot?.agents)
      const previousRuntimes = get().runtimes
      const nextRuntimes = asArray<HermesRuntime>(snapshot?.runtimes?.runtimes)
        .map(normalizeFleetRuntime)
        .filter((runtime): runtime is HermesRuntime => runtime !== null)
        .map((runtime) => {
          if (runtime.active_hermes_session_id) return runtime
          const previous = previousRuntimes.find((entry) => entry.node === runtime.node && entry.runtime_id === runtime.runtime_id)
          return previous?.active_hermes_session_id
            ? { ...runtime, active_hermes_session_id: previous.active_hermes_session_id }
            : runtime
        }) as HermesRuntime[]
      const nextSessions = asArray<FleetSession>(snapshot?.sessions)
      const selectedAgentId = preferredFleetAgentId(nextAgents, nextSessions, get().selectedAgentId)
      _pollFailures = 0

      set({
        config: nextConfig,
        status: snapshot?.status || null,
        nodes: asArray<FleetNode>(snapshot?.nodes),
        agents: nextAgents,
        runtimes: nextRuntimes,
        sessions: nextSessions,
        capabilities: snapshot?.capabilities || EMPTY_CAPABILITIES,
        selectedAgentId,
        loading: false,
        stale: false,
        lastRefreshAt: Date.now(),
      })
    } catch (err) {
      _pollFailures += 1
      set({
        loading: false,
        stale: true,
        error: errorMessage(err, 'fleet bridge unavailable'),
      })
    } finally {
      _refreshInFlight = false
    }
  },

  startPolling: () => {
    if (_pollTimer) {
      clearTimeout(_pollTimer)
      _pollTimer = null
    }
    _pollActive = true
    const tick = async () => {
      if (!_pollActive) return
      await get().refreshSnapshot()
      if (!_pollActive) return
      _pollTimer = setTimeout(() => {
        void tick()
      }, fleetBackoffDelay(_pollFailures))
    }
    void tick()
  },

  stopPolling: () => {
    _pollActive = false
    if (_pollTimer) {
      clearTimeout(_pollTimer)
      _pollTimer = null
    }
  },

  selectAgent: (agentId) => {
    set({ selectedAgentId: agentId })
  },

  fetchLogs: async (agentId) => {
    const id = String(agentId || '').trim()
    if (!id) return
    set({ logsLoadingAgentId: id, error: '' })
    try {
      const data = await apiCall<FleetLogsResponse>(`/api/fleet/agents/${encodeURIComponent(id)}/logs`)
      const logs = String(data?.logs || data?.result?.detail || '')
      set((state) => ({
        logsByAgent: { ...state.logsByAgent, [id]: logs || JSON.stringify(data || {}, null, 2) },
        logsLoadingAgentId: null,
      }))
    } catch (err) {
      set({ logsLoadingAgentId: null, error: errorMessage(err, 'fleet logs unavailable') })
    }
  },

  injectAgent: async (agentId, message, sessionId = '') => {
    const id = String(agentId || '').trim()
    const text = String(message || '').trim()
    const sid = String(sessionId || '').trim()
    if (!id || !text) return
    set({ injectingAgentId: id, error: '' })
    try {
      await apiPost(`/api/fleet/agents/${encodeURIComponent(id)}/inject`, {
        message: text,
        ...(sid ? { session_id: sid } : {}),
      })
      set({ injectingAgentId: null })
      await get().refreshSnapshot()
    } catch (err) {
      set({ injectingAgentId: null, error: errorMessage(err, 'fleet inject failed') })
      throw err
    }
  },

  createRuntime: async (node, title = 'New session', opts = {}) => {
    const safeNode = String(node || '').trim()
    if (!safeNode) return null
    const body: Record<string, unknown> = { title }
    if (opts.resumeId) body.resume = opts.resumeId
    const uiTheme = String(opts.uiTheme || '').trim()
    const skin = String(opts.skin || hermesSkinForUiTheme(uiTheme)).trim()
    if (uiTheme) body.ui_theme = uiTheme
    if (skin) body.skin = skin
    try {
      const data = await apiPost<FleetRuntimeCreateResponse>(`/api/fleet/nodes/${encodeURIComponent(safeNode)}/runtimes`, body)
      const runtime = normalizeFleetRuntime(data?.runtime)
      if (!runtime) return null
      if (runtime.can_attach === false || runtime.state === 'stopped') {
        throw new Error(`remote runtime start failed: ${runtime.runtime_id} is ${runtime.state || 'not attachable'}`)
      }
      set((state) => ({
        runtimes: [runtime, ...state.runtimes.filter((entry) => !(entry.node === runtime.node && entry.runtime_id === runtime.runtime_id))],
        error: '',
      }))
      return runtime
    } catch (err) {
      set({ error: errorMessage(err, 'fleet runtime start failed') })
      throw err
    }
  },

  bindRuntimeSession: (attachPath, sessionId) => {
    const path = String(attachPath || '').trim()
    const sid = String(sessionId || '').trim()
    if (!path || !sid) return
    set((state) => ({
      runtimes: state.runtimes.map((runtime) => (
        String(runtime.attach_ws_path || '') === path
          ? { ...runtime, active_hermes_session_id: sid }
          : runtime
      )),
    }))
  },

  stopRuntime: async (node, runtimeId) => {
    const safeNode = String(node || '').trim()
    const rid = String(runtimeId || '').trim()
    if (!safeNode || !rid) return
    try {
      await apiPost<FleetRuntimeCreateResponse>(`/api/fleet/nodes/${encodeURIComponent(safeNode)}/runtimes/${encodeURIComponent(rid)}/stop`, {})
      await get().refreshSnapshot()
    } catch (err) {
      set({ error: errorMessage(err, 'fleet runtime stop failed') })
      throw err
    }
  },

  reset: () => {
    get().stopPolling()
    _pollFailures = 0
    _refreshInFlight = false
    set({
      config: EMPTY_CONFIG,
      status: null,
      nodes: [],
      agents: [],
      runtimes: [],
      sessions: [],
      capabilities: EMPTY_CAPABILITIES,
      selectedAgentId: null,
      logsByAgent: {},
      loading: false,
      error: '',
      logsLoadingAgentId: null,
      injectingAgentId: null,
      lastRefreshAt: null,
      lastAttemptAt: null,
      stale: false,
    })
  },
}))
