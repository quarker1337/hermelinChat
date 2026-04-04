/**
 * bridge.ts — Stateless WS control message router for the artifact system.
 *
 * Routes incoming WebSocket control messages to the artifact store.
 * Mirrors App.jsx handleArtifactControlMessage exactly.
 */

import type { ArtifactTab } from '../../types'
import { useArtifactStore } from '../../stores/artifacts'

// Extend the window type for the bridge command queue
declare global {
  interface Window {
    __hermesArtifactBridgeCommands?: Record<string, unknown[]>
  }
}

/**
 * Handle a WebSocket control message payload.
 *
 * @returns `true` if the message was handled, `false` if not recognized.
 */
export function handleControlMessage(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false

  const msg = payload as Record<string, unknown>
  const store = useArtifactStore.getState()

  // ── artifact — single artifact upsert ────────────────────────────────────
  if (msg.type === 'artifact') {
    const artifact = msg.payload
    if (!artifact || typeof artifact !== 'object' || !(artifact as Record<string, unknown>).id) {
      return true
    }
    const artObj = artifact as ArtifactTab
    const current = useArtifactStore.getState().tabs
    const next = [artObj, ...current.filter((item) => item.id !== artObj.id)]
    store.applyArtifacts(next, { openOnChange: true })
    return true
  }

  // ── artifact_list — bulk replace ─────────────────────────────────────────
  if (msg.type === 'artifact_list' && Array.isArray(msg.payload)) {
    store.applyArtifacts(msg.payload as ArtifactTab[], { openOnChange: true })
    return true
  }

  // ── artifact_focus — activate tab + open panel ───────────────────────────
  if (msg.type === 'artifact_focus') {
    const info = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>
    const id = info.tab_id || info.id || info.artifact_id || null
    if (!id) return true

    store.setActiveId(String(id))
    useArtifactStore.setState({ panelDismissed: false })
    store.openPanel()
    return true
  }

  // ── artifact_close — close one tab or close_all ──────────────────────────
  if (msg.type === 'artifact_close') {
    const info = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>

    if (info.action === 'close_all') {
      // close_panel semantics: hide the panel (like the user clicked X)
      // and clear any in-memory tabs.
      store.applyArtifacts([], { openOnChange: false })
      useArtifactStore.setState({ panelDismissed: true, panelOpen: false })
      return true
    }

    const id = info.id || info.tab_id
    if (id) {
      const current = useArtifactStore.getState().tabs
      const next = current.filter((item) => item.id !== String(id))
      store.applyArtifacts(next, { openOnChange: false })
      return true
    }
  }

  // ── artifact_bridge_command — forward to iframe ──────────────────────────
  if (msg.type === 'artifact_bridge_command') {
    const command = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>
    const artifactId =
      command.artifact_id || command.artifactId || command.id || command.tab_id || null

    if (artifactId) {
      store.setActiveId(String(artifactId))
      useArtifactStore.setState({ panelDismissed: false })
      store.openPanel()
    }

    if (typeof window !== 'undefined') {
      const bridgeStore = (window.__hermesArtifactBridgeCommands =
        window.__hermesArtifactBridgeCommands || {})
      const key = artifactId ? String(artifactId) : '__global__'
      const queue = Array.isArray(bridgeStore[key]) ? bridgeStore[key] : []
      bridgeStore[key] = [...queue, command]
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('hermes-artifact-command', { detail: command }))
      }, 30)
    }

    return true
  }

  return false
}
