import { create } from 'zustand'
import { apiCall, apiPost } from '../api/client'
import { useAuthStore } from './auth'
import type { HermesRuntime, HermesRuntimeConfig, HermesRuntimeListResponse, HermesRuntimeProfile } from '../types'

let _pollTimer: ReturnType<typeof setInterval> | null = null

const DEFAULT_RUNTIME_PROFILES: HermesRuntimeProfile[] = [{ name: 'default', label: 'default', is_default: true, configured: true, model: null }]

const DEFAULT_RUNTIME_CONFIG: HermesRuntimeConfig = {
  enabled: false,
  backend: 'legacy',
  available: true,
  configured_backend: 'auto',
  autostart_default: true,
  profiles: DEFAULT_RUNTIME_PROFILES,
  default_profile: 'default',
  error: null,
}

interface RuntimeStore {
  config: HermesRuntimeConfig
  runtimes: HermesRuntime[]
  activeRuntimeId: string | null
  loading: boolean
  error: string

  startPolling: () => void
  stopPolling: () => void
  refresh: () => Promise<void>
  createRuntime: (title?: string, opts?: { resumeId?: string | null; profile?: string | null }) => Promise<HermesRuntime | null>
  activateRuntime: (runtimeId: string) => Promise<void>
  stopRuntime: (runtimeId: string) => Promise<void>
  setActiveRuntimeId: (runtimeId: string | null) => void
  setRuntimeActivity: (runtimeId: string, activity: 'idle' | 'working') => void
  reset: () => void
}

function normalizeProfile(raw: Partial<HermesRuntimeProfile> | null | undefined): HermesRuntimeProfile | null {
  const name = String(raw?.name || '').trim()
  if (!name) return null
  return {
    name,
    label: String(raw?.label || name),
    is_default: Boolean(raw?.is_default || name === 'default'),
    configured: raw?.configured !== false,
    model: raw?.model ? String(raw.model) : null,
  }
}

function normalizeProfiles(raw: unknown): HermesRuntimeProfile[] {
  const profiles = Array.isArray(raw)
    ? raw.map((entry) => normalizeProfile(entry as Partial<HermesRuntimeProfile>)).filter(Boolean) as HermesRuntimeProfile[]
    : []
  if (!profiles.some((profile) => profile.name === 'default')) profiles.unshift(DEFAULT_RUNTIME_PROFILES[0])
  return profiles.length ? profiles : DEFAULT_RUNTIME_PROFILES
}

function normalizeConfig(raw: Partial<HermesRuntimeConfig> | null | undefined): HermesRuntimeConfig {
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    ...(raw || {}),
    enabled: Boolean(raw?.enabled),
    available: raw?.available !== false,
    backend: String(raw?.backend || DEFAULT_RUNTIME_CONFIG.backend),
    configured_backend: String(raw?.configured_backend || DEFAULT_RUNTIME_CONFIG.configured_backend),
    autostart_default: raw?.autostart_default !== false,
    profiles: normalizeProfiles(raw?.profiles),
    default_profile: String(raw?.default_profile || 'default'),
    error: raw?.error ? String(raw.error) : null,
  }
}

function normalizeRuntime(raw: Partial<HermesRuntime> | null | undefined): HermesRuntime | null {
  if (!raw?.runtime_id) return null
  return {
    runtime_id: String(raw.runtime_id),
    title: String(raw.title || raw.runtime_id || 'default'),
    profile: String(raw.profile || 'default'),
    cwd: String(raw.cwd || ''),
    state: String(raw.state || 'idle'),
    runtime_activity: String(raw.runtime_activity || '').trim() || undefined,
    source: String(raw.source || 'user_ui'),
    backend: String(raw.backend || 'legacy'),
    tmux_name: raw.tmux_name ?? null,
    hermes_pid: typeof raw.hermes_pid === 'number' ? raw.hermes_pid : null,
    active_hermes_session_id: raw.active_hermes_session_id ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    last_attached_at: raw.last_attached_at ?? null,
    last_seen_at: raw.last_seen_at ?? null,
    metadata: raw.metadata || {},
    can_attach: Boolean(raw.can_attach),
    can_stop: Boolean(raw.can_stop),
    attach_ws_path: String(raw.attach_ws_path || '/ws/pty'),
  }
}

function selectActiveRuntime(runtimes: HermesRuntime[], serverActiveId?: string | null, previousActiveId?: string | null): string | null {
  const usable = runtimes.filter((runtime) => runtime.state !== 'stopped' && runtime.can_attach !== false)
  if (!usable.length) return null
  // Preserve an explicit browser-side selection. Runtime polling can race with
  // POST /activate and briefly report the previous server-side last-active id;
  // letting that stale value win makes the dropdown appear to snap back.
  if (previousActiveId && usable.some((runtime) => runtime.runtime_id === previousActiveId)) return previousActiveId
  if (serverActiveId && usable.some((runtime) => runtime.runtime_id === serverActiveId)) return serverActiveId
  return usable[0].runtime_id
}

export function runtimeAttachPath(runtime: HermesRuntime | null | undefined): string {
  if (!runtime) return '/ws/pty'
  return runtime.attach_ws_path || (runtime.backend === 'tmux' ? `/ws/runtimes/${encodeURIComponent(runtime.runtime_id)}/attach` : '/ws/pty')
}

export const useRuntimeStore = create<RuntimeStore>((set, get) => ({
  config: DEFAULT_RUNTIME_CONFIG,
  runtimes: [],
  activeRuntimeId: null,
  loading: false,
  error: '',

  startPolling: () => {
    if (_pollTimer) clearInterval(_pollTimer)
    _pollTimer = null
    if (!useAuthStore.getState().authenticated) return
    void get().refresh()
    _pollTimer = setInterval(() => {
      if (useAuthStore.getState().authenticated) void get().refresh()
    }, 5000)
  },

  stopPolling: () => {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
  },

  refresh: async () => {
    if (!useAuthStore.getState().authenticated) return
    set({ loading: true, error: '' })
    try {
      const [configRaw, listRaw] = await Promise.all([
        apiCall<Partial<HermesRuntimeConfig>>('/api/runtimes/config'),
        apiCall<HermesRuntimeListResponse>('/api/runtimes'),
      ])
      const runtimes = (listRaw.runtimes || []).map(normalizeRuntime).filter(Boolean) as HermesRuntime[]
      set((state) => ({
        config: normalizeConfig(configRaw),
        runtimes,
        activeRuntimeId: selectActiveRuntime(runtimes, listRaw.last_active_runtime_id ?? null, state.activeRuntimeId),
        loading: false,
        error: '',
      }))
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'runtime refresh failed' })
    }
  },

  createRuntime: async (title = 'Hermes', opts = {}) => {
    if (!useAuthStore.getState().authenticated) return null
    const body: Record<string, unknown> = { title }
    if (opts.resumeId) body.resume = opts.resumeId
    const profile = String(opts.profile || '').trim()
    if (profile && profile !== 'default') body.profile = profile
    const data = await apiPost<{ runtime?: HermesRuntime }>('/api/runtimes', body)
    const runtime = normalizeRuntime(data.runtime)
    if (!runtime) return null
    set((state) => ({
      runtimes: [runtime, ...state.runtimes.filter((entry) => entry.runtime_id !== runtime.runtime_id)],
      activeRuntimeId: runtime.runtime_id,
      error: '',
    }))
    return runtime
  },

  activateRuntime: async (runtimeId: string) => {
    const rid = String(runtimeId || '').trim()
    if (!rid) return
    set({ activeRuntimeId: rid })
    try {
      const data = await apiPost<{ runtime?: HermesRuntime }>(`/api/runtimes/${encodeURIComponent(rid)}/activate`, {})
      const runtime = normalizeRuntime(data.runtime)
      if (runtime) {
        set((state) => ({
          runtimes: state.runtimes.map((entry) => (entry.runtime_id === runtime.runtime_id ? runtime : entry)),
          activeRuntimeId: runtime.runtime_id,
        }))
      }
    } catch {
      // Local active switch should still work even if the best-effort server
      // "last active" write fails; the websocket attach path is the real action.
    }
  },

  stopRuntime: async (runtimeId: string) => {
    const rid = String(runtimeId || '').trim()
    if (!rid) return
    await apiPost<{ runtime?: HermesRuntime }>(`/api/runtimes/${encodeURIComponent(rid)}/stop`, {})
    await get().refresh()
  },

  setActiveRuntimeId: (runtimeId: string | null) => set({ activeRuntimeId: runtimeId }),

  setRuntimeActivity: (runtimeId: string, activity: 'idle' | 'working') => {
    const rid = String(runtimeId || '').trim()
    if (!rid) return
    set((state) => ({
      runtimes: state.runtimes.map((runtime) => (
        runtime.runtime_id === rid && runtime.runtime_activity !== activity
          ? { ...runtime, runtime_activity: activity }
          : runtime
      )),
    }))
  },

  reset: () => {
    if (_pollTimer) clearInterval(_pollTimer)
    _pollTimer = null
    set({
      config: DEFAULT_RUNTIME_CONFIG,
      runtimes: [],
      activeRuntimeId: null,
      loading: false,
      error: '',
    })
  },
}))

export function selectActiveRuntimeRecord(state: Pick<RuntimeStore, 'runtimes' | 'activeRuntimeId'>): HermesRuntime | null {
  return state.runtimes.find((runtime) => runtime.runtime_id === state.activeRuntimeId) || null
}
