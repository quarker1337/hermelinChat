import { create } from 'zustand'
import type { SearchHit, SearchGroup, PeekState } from '../types'
import { useAuthStore } from './auth'
import { apiCall } from '../api/client'
import { registerSearchStore } from './sessions'

// ---------------------------------------------------------------------------
// Module-level timer / abort refs (not in store state)
// ---------------------------------------------------------------------------

let _searchTimer: ReturnType<typeof setTimeout> | null = null
let _searchAbort: AbortController | null = null

// ---------------------------------------------------------------------------
// Minimal model label formatter
// (Task 10 will add the full formatModelLabel util; inline a minimal version here)
// ---------------------------------------------------------------------------

function formatModelLabel(model: string | null | undefined): string | null {
  if (!model) return null
  // Strip common vendor prefixes for display, e.g. "anthropic/claude-3-5-sonnet" → "claude-3-5-sonnet"
  const parts = model.split('/')
  return parts[parts.length - 1] ?? model
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeGroups(results: SearchHit[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>()

  for (const r of results) {
    const sid = r.session_id
    if (!sid) continue

    if (!groups.has(sid)) {
      groups.set(sid, {
        session_id: sid,
        title: r.session_title || sid,
        model: formatModelLabel(r.session_model || null),
        hits: [],
      })
    }
    groups.get(sid)!.hits.push(r)
  }

  const out = Array.from(groups.values())

  for (const g of out) {
    g.hits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  }

  out.sort((a, b) => {
    const at = a.hits[0]?.timestamp || 0
    const bt = b.hits[0]?.timestamp || 0
    return bt - at
  })

  return out
}

function computeExpandedSessions(
  prev: Record<string, boolean>,
  results: SearchHit[],
): Record<string, boolean> {
  const sessionIds = Array.from(new Set(results.map((r) => r.session_id)))
  const next: Record<string, boolean> = {}
  for (const id of sessionIds) {
    next[id] = prev[id] ?? true
  }
  return next
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface SearchStore {
  query: string
  results: SearchHit[]
  searching: boolean
  groups: SearchGroup[]
  expandedSessions: Record<string, boolean>
  peek: PeekState

  setQuery: (q: string) => void
  toggleSession: (id: string) => void
  openPeek: (hit: SearchHit) => void
  closePeek: () => void
  // Called by sessions store when a session is renamed
  updateSessionTitle: (sid: string, title: string) => void
  // Called by sessions store when a session is deleted
  removeSession: (sid: string) => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Initial peek state
// ---------------------------------------------------------------------------

const INITIAL_PEEK: PeekState = {
  open: false,
  loading: false,
  error: '',
  context: null,
  hit: null,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: '',
  results: [],
  searching: false,
  groups: [],
  expandedSessions: {},
  peek: { ...INITIAL_PEEK },

  // -------------------------------------------------------------------------
  // setQuery — store immediately, debounce the fetch 250ms
  // -------------------------------------------------------------------------
  setQuery: (q: string) => {
    // Cancel any in-flight timer and request
    if (_searchTimer !== null) {
      clearTimeout(_searchTimer)
      _searchTimer = null
    }
    if (_searchAbort !== null) {
      try { _searchAbort.abort() } catch { /* ignore */ }
      _searchAbort = null
    }

    const trimmed = q.trim()

    if (!trimmed) {
      set({ query: q, results: [], searching: false, groups: [], expandedSessions: {} })
      return
    }

    // Store the raw query immediately so the input stays responsive
    set({ query: q, searching: true })

    _searchAbort = new AbortController()
    const ctrl = _searchAbort

    _searchTimer = setTimeout(async () => {
      _searchTimer = null

      if (!useAuthStore.getState().authenticated) {
        set({ results: [], searching: false, groups: [], expandedSessions: {} })
        return
      }

      try {
        const data = await apiCall<{ results?: SearchHit[] }>(
          `/api/search?q=${encodeURIComponent(trimmed)}&limit=25`,
          { signal: ctrl.signal },
        )
        const results = data.results || []
        const groups = computeGroups(results)
        const expandedSessions = computeExpandedSessions(get().expandedSessions, results)
        set({ results, groups, expandedSessions, searching: false })
      } catch (err: unknown) {
        // AbortError means a newer query cancelled this one — don't clear results
        if (err instanceof Error && err.name === 'AbortError') return
        set({ results: [], groups: [], searching: false })
      }
    }, 250)
  },

  // -------------------------------------------------------------------------
  // toggleSession — expand/collapse a session group in search results
  // -------------------------------------------------------------------------
  toggleSession: (id: string) => {
    set((s) => ({
      expandedSessions: {
        ...s.expandedSessions,
        [id]: !s.expandedSessions[id],
      },
    }))
  },

  // -------------------------------------------------------------------------
  // openPeek — fetch message context and open the peek drawer
  // -------------------------------------------------------------------------
  openPeek: async (hit: SearchHit) => {
    if (!useAuthStore.getState().authenticated) return
    if (!hit?.id) return

    set({
      peek: {
        open: true,
        loading: true,
        error: '',
        context: null,
        hit,
      },
    })

    try {
      const data = await apiCall<PeekState['context']>(
        `/api/messages/context?message_id=${encodeURIComponent(hit.id)}&before=3&after=3`,
      )
      set((s) => ({
        peek: { ...s.peek, loading: false, context: data ?? null },
      }))
    } catch (err: unknown) {
      const error =
        err instanceof Error && err.name === 'ApiError'
          ? 'not found'
          : 'peek failed'
      set((s) => ({
        peek: { ...s.peek, loading: false, error },
      }))
    }
  },

  // -------------------------------------------------------------------------
  // closePeek
  // -------------------------------------------------------------------------
  closePeek: () => {
    set({ peek: { ...INITIAL_PEEK } })
  },

  // -------------------------------------------------------------------------
  // updateSessionTitle — called by sessions store after rename
  // -------------------------------------------------------------------------
  updateSessionTitle: (sid: string, title: string) => {
    set((s) => {
      const results = s.results.map((r) =>
        r.session_id === sid ? { ...r, session_title: title } : r,
      )
      const groups = computeGroups(results)
      return { results, groups }
    })
  },

  // -------------------------------------------------------------------------
  // removeSession — called by sessions store after delete
  // -------------------------------------------------------------------------
  removeSession: (sid: string) => {
    set((s) => {
      const results = s.results.filter((r) => r.session_id !== sid)
      const groups = computeGroups(results)
      const expandedSessions = { ...s.expandedSessions }
      delete expandedSessions[sid]
      return { results, groups, expandedSessions }
    })
  },

  // -------------------------------------------------------------------------
  // reset — clear all search state (called on logout / new session)
  // -------------------------------------------------------------------------
  reset: () => {
    if (_searchTimer !== null) {
      clearTimeout(_searchTimer)
      _searchTimer = null
    }
    if (_searchAbort !== null) {
      try { _searchAbort.abort() } catch { /* ignore */ }
      _searchAbort = null
    }

    set({
      query: '',
      results: [],
      searching: false,
      groups: [],
      expandedSessions: {},
      peek: { ...INITIAL_PEEK },
    })
  },
}))

// ---------------------------------------------------------------------------
// Register with sessions store so it can call reset / updateSessionTitle / removeSession
// ---------------------------------------------------------------------------

registerSearchStore(useSearchStore.getState())
