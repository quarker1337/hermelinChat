import { create } from 'zustand'
import type { ArtifactTab } from '../types'
import { apiCall } from '../api/client'
import {
  loadArtifactPanelWidth,
  saveArtifactPanelWidth,
  clampArtifactPanelWidth,
} from '../utils/ui-prefs'

// ---------------------------------------------------------------------------
// Module-level refs (not in store state)
// ---------------------------------------------------------------------------

// Mirror of artifactTabsRef — allows applyArtifacts to read tabs synchronously
// without a stale closure (same pattern as App.jsx's artifactTabsRef).
let _tabsRef: ArtifactTab[] = []

// Polling interval handle
let _pollInterval: ReturnType<typeof setInterval> | null = null

// Track whether the global resize listener has been attached
let _panelResizeListenerAttached = false

// Debounce handle for panel-width localStorage save
let _widthSaveTimer: ReturnType<typeof setTimeout> | null = null

// Avoid overlapping expensive full artifact polls when the host/browser is busy.
let _pollInFlight = false

// The PTY websocket also streams artifact updates. When it is connected, keep
// HTTP polling as a fallback only so heavy artifact payloads are not fetched and
// parsed twice on the browser main thread. Track the current websocket token so
// a stale close/error from an older socket cannot re-enable polling after a
// newer socket has already connected.
let _realtimeUpdatesActive = false
let _realtimeUpdatesToken: unknown = null

// ---------------------------------------------------------------------------
// Pure helpers (mirror of App.jsx logic exactly)
// ---------------------------------------------------------------------------

function normalizeArtifacts(items: unknown[]): ArtifactTab[] {
  const list = Array.isArray(items) ? items : []
  return (list as unknown[])
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !!(item as Record<string, unknown>).id)
    .map((item) => ({
      ...item,
      id: String(item.id),
      type: String(item.type || 'unknown').toLowerCase(),
    })) as ArtifactTab[]
}

const ARTIFACT_DATA_COMPARE_MAX_BYTES = 256 * 1024
const ARTIFACT_DATA_COMPARE_MAX_NODES = 5000

function artifactDataWithinCompareLimit(value: unknown): boolean {
  const seen = new Set<object>()
  const stack: unknown[] = [value]
  let bytes = 0
  let nodes = 0

  while (stack.length) {
    const item = stack.pop()
    nodes += 1
    if (nodes > ARTIFACT_DATA_COMPARE_MAX_NODES) return false

    if (item === null || item === undefined) {
      bytes += 4
    } else if (typeof item === 'string') {
      bytes += item.length
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      bytes += 8
    } else if (typeof item === 'object') {
      if (seen.has(item)) continue
      seen.add(item)

      if (Array.isArray(item)) {
        if (nodes + stack.length + item.length > ARTIFACT_DATA_COMPARE_MAX_NODES) return false
        bytes += item.length
        for (let i = 0; i < item.length; i += 1) {
          stack.push(item[i])
        }
      } else {
        const record = item as Record<string, unknown>
        let keyCount = 0
        for (const key in record) {
          if (!Object.prototype.hasOwnProperty.call(record, key)) continue
          keyCount += 1
          if (nodes + stack.length + keyCount > ARTIFACT_DATA_COMPARE_MAX_NODES) return false
          bytes += key.length
          stack.push(record[key])
          if (bytes > ARTIFACT_DATA_COMPARE_MAX_BYTES) return false
        }
      }
    } else {
      bytes += String(item).length
    }

    if (bytes > ARTIFACT_DATA_COMPARE_MAX_BYTES) return false
  }

  return true
}

function artifactDataEqual(aData: unknown, bData: unknown): boolean {
  if (aData === bData) return true
  if (!aData || !bData) return false
  if (!artifactDataWithinCompareLimit(aData) || !artifactDataWithinCompareLimit(bData)) return false
  try {
    return JSON.stringify(aData) === JSON.stringify(bData)
  } catch {
    return false
  }
}

function artifactShallowEqual(a: ArtifactTab, b: ArtifactTab): boolean {
  if (a === b) return true
  // Fast path: compare scalar fields first.
  if (
    String(a.id) !== String(b.id) ||
    String(a.type) !== String(b.type) ||
    String(a.title) !== String(b.title) ||
    String(a.runner_status || '') !== String(b.runner_status || '') ||
    Boolean(a.live) !== Boolean(b.live) ||
    Boolean(a.persistent) !== Boolean(b.persistent) ||
    Boolean(a.runner_active) !== Boolean(b.runner_active) ||
    Number(a.refresh_seconds || 0) !== Number(b.refresh_seconds || 0) ||
    Number(a.timestamp || 0) !== Number(b.timestamp || 0) ||
    Number(a.updated_at || 0) !== Number(b.updated_at || 0)
  ) {
    return false
  }
  // Compare `data` — this is the field most likely to cause unnecessary
  // re-renders.  JSON.parse creates new objects on every poll, so a simple
  // reference check is insufficient.  We do a cheap stringification compare
  // so that identical payloads reuse the previous artifact object, preventing
  // React from churning the DOM and stealing text-selection focus.
  return artifactDataEqual(a.data, b.data)
}

function mergeArtifactRenderData(prev: ArtifactTab, next: ArtifactTab): ArtifactTab {
  if (prev === next || prev.data === next.data) return next
  if (!artifactDataEqual(prev.data, next.data)) return next
  return { ...next, data: prev.data }
}

function mergeArtifactsStable(prevItems: ArtifactTab[], nextItems: ArtifactTab[]): ArtifactTab[] {
  const prev = Array.isArray(prevItems) ? prevItems : []
  const next = Array.isArray(nextItems) ? nextItems : []

  if (!prev.length) return next

  const prevById = new Map(prev.map((item) => [item.id, item]))
  const nextById = new Map(next.map((item) => [item.id, item]))

  // Keep the existing dropdown/tab order stable for known artifact IDs.
  // Live artifacts refresh their timestamps constantly, so blindly re-sorting
  // by timestamp makes the list jump around under the user's mouse.
  //
  // When an artifact's data hasn't semantically changed, reuse the *previous
  // object reference* so that React's shallow-equality check in re-renders
  // sees "no change" and skips the component update.  This prevents the
  // constant DOM churn that steals text-selection focus from the user.
  const preserved: ArtifactTab[] = []
  for (const item of prev) {
    const updated = nextById.get(item.id)
    if (updated) {
      preserved.push(artifactShallowEqual(item, updated) ? item : mergeArtifactRenderData(item, updated))
    }
  }

  const newcomers = next.filter((item) => !prevById.has(item.id))
  const merged = [...newcomers, ...preserved]

  if (
    newcomers.length === 0 &&
    merged.length === prev.length &&
    merged.every((item, index) => item === prev[index])
  ) {
    return prev
  }

  return merged
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface ArtifactStore {
  tabs: ArtifactTab[]
  activeId: string | null
  panelOpen: boolean
  panelPinned: boolean
  panelDismissed: boolean
  panelWidth: number

  setActiveId: (id: string) => void
  setPanelWidth: (w: number) => void
  openPanel: () => void
  closePanel: () => void
  togglePin: () => void
  applyArtifacts: (items: ArtifactTab[], opts?: { openOnChange?: boolean }) => void
  deleteTab: (id: string) => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  setRealtimeUpdatesActive: (active: boolean, token?: unknown) => void
  reset: () => void
}

async function refreshArtifacts(
  get: () => ArtifactStore,
  opts: { openOnChange?: boolean; force?: boolean } = {},
): Promise<void> {
  if (_pollInFlight) return
  if (_realtimeUpdatesActive && !opts.force) return

  _pollInFlight = true
  try {
    const data = await apiCall<ArtifactTab[]>('/api/artifacts')
    get().applyArtifacts(data, { openOnChange: opts.openOnChange !== false })
  } catch {
    // ignore artifact refresh failures
  } finally {
    _pollInFlight = false
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useArtifactStore = create<ArtifactStore>((set, get) => ({
  tabs: [],
  activeId: null,
  panelOpen: false,
  panelPinned: false,
  panelDismissed: false,
  panelWidth: loadArtifactPanelWidth(),

  // -------------------------------------------------------------------------
  // setActiveId
  // -------------------------------------------------------------------------
  setActiveId: (id: string) => {
    set({ activeId: id })
  },

  // -------------------------------------------------------------------------
  // setPanelWidth — clamp + debounced localStorage save
  // -------------------------------------------------------------------------
  setPanelWidth: (w: number) => {
    const clamped = clampArtifactPanelWidth(w)
    if (clamped === get().panelWidth) return

    set({ panelWidth: clamped })

    if (_widthSaveTimer !== null) {
      clearTimeout(_widthSaveTimer)
    }
    _widthSaveTimer = setTimeout(() => {
      _widthSaveTimer = null
      saveArtifactPanelWidth(clamped)
    }, 150)
  },

  // -------------------------------------------------------------------------
  // openPanel — close search peek first
  // -------------------------------------------------------------------------
  openPanel: () => {
    // Import lazily to avoid circular dependency at module init time
    import('./search').then(({ useSearchStore }) => {
      useSearchStore.getState().closePeek()
    }).catch(() => { /* ignore */ })
    set({ panelOpen: true })
  },

  // -------------------------------------------------------------------------
  // closePanel
  // -------------------------------------------------------------------------
  closePanel: () => {
    set({ panelDismissed: true, panelOpen: false })
  },

  // -------------------------------------------------------------------------
  // togglePin
  // -------------------------------------------------------------------------
  togglePin: () => {
    set((s) => ({ panelPinned: !s.panelPinned }))
  },

  // -------------------------------------------------------------------------
  // applyArtifacts — normalize + merge + auto-open logic
  // -------------------------------------------------------------------------
  applyArtifacts: (items: ArtifactTab[], opts?: { openOnChange?: boolean }) => {
    const openOnChange = opts?.openOnChange !== false
    const prev = _tabsRef
    const normalized = normalizeArtifacts(items as unknown[])
    const next = mergeArtifactsStable(prev, normalized)
    const prevById = new Map(prev.map((item) => [item.id, item]))
    const nextById = new Map(next.map((item) => [item.id, item]))

    let hasAddOrUpdate = next.length > 0 && prev.length === 0
    for (const item of next) {
      const prevItem = prevById.get(item.id)
      if (!prevItem || Number(prevItem?.timestamp || 0) !== Number(item?.timestamp || 0)) {
        hasAddOrUpdate = true
        break
      }
    }
    const hasNewIds = next.some((item) => !prevById.has(item.id))

    // Update the module-level ref synchronously
    _tabsRef = next

    const { panelDismissed } = get()

    set((s) => {
      let activeId = s.activeId
      if (!activeId || !nextById.has(activeId)) {
        activeId = next[0]?.id ?? null
      }

      if (!next.length) {
        // Keep panel state as-is when there are no artifacts.
        //
        // Otherwise, opening the panel manually will immediately collapse again
        // on the next refresh tick (because the artifacts list is still empty).
        return { tabs: next, activeId }
      }

      let panelOpen = s.panelOpen
      let panelDismissedNext = panelDismissed

      if (openOnChange && hasAddOrUpdate && (!panelDismissed || hasNewIds)) {
        panelDismissedNext = false
        panelOpen = true
        // Close peek (fire-and-forget)
        import('./search').then(({ useSearchStore }) => {
          useSearchStore.getState().closePeek()
        }).catch(() => { /* ignore */ })
      }

      return { tabs: next, activeId, panelOpen, panelDismissed: panelDismissedNext }
    })
  },

  // -------------------------------------------------------------------------
  // deleteTab — DELETE /api/artifacts/{id} then refresh (no auto-open)
  // -------------------------------------------------------------------------
  deleteTab: async (id: string) => {
    if (!id) return
    try {
      await apiCall(`/api/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch {
      // ignore
    }
    // Refresh without triggering auto-open
    void refreshArtifacts(get, { openOnChange: false, force: true })
  },

  // -------------------------------------------------------------------------
  // startPolling — 1.5s interval calling refreshArtifacts
  // -------------------------------------------------------------------------
  startPolling: () => {
    if (_pollInterval !== null) return

    void refreshArtifacts(get, { openOnChange: true })
    _pollInterval = setInterval(() => {
      void refreshArtifacts(get, { openOnChange: true })
    }, 1500)
  },

  // -------------------------------------------------------------------------
  // stopPolling
  // -------------------------------------------------------------------------
  stopPolling: () => {
    if (_pollInterval !== null) {
      clearInterval(_pollInterval)
      _pollInterval = null
    }
  },

  // -------------------------------------------------------------------------
  // setRealtimeUpdatesActive
  // -------------------------------------------------------------------------
  setRealtimeUpdatesActive: (active: boolean, token?: unknown) => {
    const next = !!active
    const nextToken = token ?? '__default_realtime_token__'

    if (next) {
      _realtimeUpdatesActive = true
      _realtimeUpdatesToken = nextToken
      return
    }

    if (_realtimeUpdatesToken !== nextToken) return
    if (!_realtimeUpdatesActive) return

    _realtimeUpdatesActive = false
    _realtimeUpdatesToken = null

    // When the PTY websocket drops, immediately refresh once so the HTTP
    // fallback catches any artifact update that arrived near disconnect.
    if (_pollInterval !== null) {
      void refreshArtifacts(get, { openOnChange: true, force: true })
    }
  },

  // -------------------------------------------------------------------------
  // reset — clear all artifact state
  // -------------------------------------------------------------------------
  reset: () => {
    if (_pollInterval !== null) {
      clearInterval(_pollInterval)
      _pollInterval = null
    }
    _tabsRef = []
    _pollInFlight = false
    _realtimeUpdatesActive = false
    _realtimeUpdatesToken = null
    set({
      tabs: [],
      activeId: null,
      panelOpen: false,
      panelPinned: false,
      panelDismissed: false,
      panelWidth: loadArtifactPanelWidth(),
    })
  },
}))

function ensureArtifactPanelResizeSync() {
  if (_panelResizeListenerAttached || typeof window === 'undefined') return

  const handleResize = () => {
    const { panelWidth, setPanelWidth } = useArtifactStore.getState()
    setPanelWidth(panelWidth)
  }

  window.addEventListener('resize', handleResize)
  _panelResizeListenerAttached = true
}

ensureArtifactPanelResizeSync()
