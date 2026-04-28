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

function artifactShallowEqual(a: ArtifactTab, b: ArtifactTab): boolean {
  if (a === b) return true
  // Fast path: compare scalar fields first.
  if (
    String(a.id) !== String(b.id) ||
    String(a.type) !== String(b.type) ||
    String(a.title) !== String(b.title) ||
    Number(a.timestamp || 0) !== Number(b.timestamp || 0)
  ) {
    return false
  }
  // Compare `data` — this is the field most likely to cause unnecessary
  // re-renders.  JSON.parse creates new objects on every poll, so a simple
  // reference check is insufficient.  We do a cheap stringification compare
  // so that identical payloads reuse the previous artifact object, preventing
  // React from churning the DOM and stealing text-selection focus.
  const aData = a.data
  const bData = b.data
  if (aData === bData) return true
  if (!aData || !bData) return false
  try {
    return JSON.stringify(aData) === JSON.stringify(bData)
  } catch {
    return false
  }
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
      preserved.push(artifactShallowEqual(item, updated) ? item : updated)
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
  reset: () => void
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
    try {
      const data = await apiCall<ArtifactTab[]>('/api/artifacts')
      get().applyArtifacts(data, { openOnChange: false })
    } catch {
      // ignore
    }
  },

  // -------------------------------------------------------------------------
  // startPolling — 1.5s interval calling refreshArtifacts
  // -------------------------------------------------------------------------
  startPolling: () => {
    if (_pollInterval !== null) return

    const tick = async () => {
      try {
        const data = await apiCall<ArtifactTab[]>('/api/artifacts')
        get().applyArtifacts(data, { openOnChange: true })
      } catch {
        // ignore artifact refresh failures
      }
    }

    void tick()
    _pollInterval = setInterval(() => {
      void tick()
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
  // reset — clear all artifact state
  // -------------------------------------------------------------------------
  reset: () => {
    if (_pollInterval !== null) {
      clearInterval(_pollInterval)
      _pollInterval = null
    }
    _tabsRef = []
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
