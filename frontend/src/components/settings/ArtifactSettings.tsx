import { useState, useEffect, useCallback } from 'react'
import { AMBER, SLATE } from '../../theme/index.js'

// ─── Types ──────────────────────────────────────────────────────────

interface DefaultArtifactItem {
  id: string
  title: string
  description: string
  enabled: boolean
  enabled_by_default: boolean
}

export interface ArtifactSettingsHandle {
  dirty: boolean
  save: () => Promise<boolean>
}

interface ArtifactSettingsProps {
  locked?: boolean
  saving?: boolean
  handleRef?: (handle: ArtifactSettingsHandle | null) => void
}

// ─── Normalize ──────────────────────────────────────────────────────

function normalizeDefaultArtifactSettings(raw: unknown): DefaultArtifactItem[] {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((item) => item && typeof item === 'object' && item.id)
    .map((item) => ({
      id: String(item.id),
      title: (item.title || item.id || 'untitled').toString().trim() || String(item.id),
      description: (item.description || '').toString().trim(),
      enabled: !!item.enabled,
      enabled_by_default: item.enabled_by_default === undefined ? true : !!item.enabled_by_default,
    }))
}

// ─── Component ──────────────────────────────────────────────────────

export const ArtifactSettings = ({ locked = false, saving = false, handleRef }: ArtifactSettingsProps) => {
  const [loading, setLoading] = useState(true)
  const [configPath, setConfigPath] = useState('')
  const [savedItems, setSavedItems] = useState<DefaultArtifactItem[]>([])
  const [draftItems, setDraftItems] = useState<DefaultArtifactItem[]>([])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (locked) {
        if (!cancelled) {
          setLoading(false)
          setConfigPath('')
          setSavedItems([])
          setDraftItems([])
        }
        return
      }

      setLoading(true)
      try {
        const r = await fetch('/api/settings/default-artifacts')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const normalized = normalizeDefaultArtifactSettings(data?.items)
        if (!cancelled) {
          setConfigPath((data?.config_path || '').toString())
          setSavedItems(normalized)
          setDraftItems(normalized)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setConfigPath('')
          setSavedItems([])
          setDraftItems([])
          setLoading(false)
        }
      }
    }

    run()
    return () => { cancelled = true }
  }, [locked])

  const dirty = JSON.stringify(savedItems) !== JSON.stringify(draftItems)

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true

    try {
      const r = await fetch('/api/settings/default-artifacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: draftItems }),
      })

      const data = await r.json().catch(() => ({}))
      if (!r.ok) return false

      const normalized = normalizeDefaultArtifactSettings(data?.items)
      setConfigPath((data?.config_path || '').toString())
      setSavedItems(normalized)
      setDraftItems(normalized)
      return true
    } catch {
      return false
    }
  }, [dirty, draftItems])

  // Expose handle to parent
  useEffect(() => {
    handleRef?.({ dirty, save: doSave })
    return () => handleRef?.(null)
  }, [dirty, doSave, handleRef])

  const setEnabled = (artifactId: string, enabled: boolean) => {
    setDraftItems((prev) =>
      (prev || []).map((item) => (item?.id === artifactId ? { ...item, enabled: !!enabled } : item)),
    )
  }

  const disabled = locked || saving

  return (
    <>
      <div
        style={{ fontSize: 10, color: SLATE.muted, marginBottom: 8 }}
        title={configPath || '~/.hermes/config.yaml'}
      >
        built-ins from config.yaml
      </div>

      {loading && (
        <div style={{ fontSize: 10, color: SLATE.muted }}>loading default artifacts...</div>
      )}

      {!loading && draftItems.length === 0 && (
        <div style={{ fontSize: 10, color: SLATE.muted }}>no built-in default artifacts available</div>
      )}

      {!loading && draftItems.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draftItems.map((item) => (
            <div
              key={item.id}
              style={{
                border: `1px solid ${SLATE.border}`,
                background: `${SLATE.elevated}aa`,
                borderRadius: 10,
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>{item.title}</div>
                <div style={{ flex: 1 }} />
                {!item.enabled_by_default && (
                  <div
                    style={{
                      fontSize: 9,
                      color: SLATE.muted,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                    }}
                  >
                    opt-in
                  </div>
                )}
                <input
                  type="checkbox"
                  checked={!!item.enabled}
                  disabled={disabled}
                  onChange={(e) => {
                    if (locked) return
                    setEnabled(item.id, e.target.checked)
                  }}
                  style={{ accentColor: AMBER[400], opacity: locked ? 0.5 : 1 }}
                />
              </div>

              {item.description && (
                <div style={{ marginTop: 6, fontSize: 10, color: SLATE.muted, lineHeight: 1.45 }}>
                  {item.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
