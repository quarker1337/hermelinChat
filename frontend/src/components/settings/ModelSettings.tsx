import { useState, useEffect, useCallback } from 'react'
import { AMBER, SLATE } from '../../theme/index'

// ─── Types ──────────────────────────────────────────────────────────

interface ModelOption {
  value: string
  label: string
}

interface Status {
  kind: '' | 'ok' | 'error'
  text: string
}

export interface ModelSettingsHandle {
  dirty: boolean
  save: () => Promise<boolean>
}

interface ModelSettingsProps {
  locked?: boolean
  defaultModel: string
  onModelSaved?: (model: string) => void
  onStatusChange?: (status: Status) => void
  handleRef?: (handle: ModelSettingsHandle | null) => void
}

// ─── Fallback options ───────────────────────────────────────────────

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { value: 'openai/gpt-5.2', label: 'openai/gpt-5.2' },
  { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' },
  { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  { value: 'google/gemini-3-flash-preview', label: 'google/gemini-3-flash-preview' },
  { value: '__custom__', label: 'Custom model' },
]

// ─── Component ──────────────────────────────────────────────────────

export const ModelSettings = ({
  locked = false,
  defaultModel,
  onModelSaved,
  onStatusChange,
  handleRef,
}: ModelSettingsProps) => {
  const initial = (defaultModel || '').trim()
  const [savedModel, setSavedModel] = useState(initial)
  const [draftModel, setDraftModel] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: '', text: '' })
  const [forceCustomModel, setForceCustomModel] = useState(false)

  const [modelOptions, setModelOptions] = useState<{ loading: boolean; items: ModelOption[] }>({
    loading: true,
    items: FALLBACK_MODEL_OPTIONS,
  })

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const r = await fetch('/api/settings/models')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const items = Array.isArray(data?.models) ? data.models : []
        const normalized: ModelOption[] = items
          .map((m: Record<string, unknown>) => ({
            value: String(m?.value || '').trim(),
            label: String(m?.label || m?.value || '').trim(),
          }))
          .filter((m: ModelOption) => m.value && m.label)

        if (!normalized.some((m) => m.value === '__custom__')) {
          normalized.push({ value: '__custom__', label: 'Custom model' })
        }

        if (!cancelled) setModelOptions({ loading: false, items: normalized })
      } catch {
        if (!cancelled) setModelOptions({ loading: false, items: FALLBACK_MODEL_OPTIONS })
      }
    }

    run()
    return () => { cancelled = true }
  }, [])

  const dirty = (draftModel || '').trim() !== (savedModel || '').trim()

  const updateStatus = useCallback(
    (s: Status) => {
      setStatus(s)
      onStatusChange?.(s)
    },
    [onStatusChange],
  )

  const doSave = useCallback(async (): Promise<boolean> => {
    if (locked || saving) return false

    const m = (draftModel || '').trim()
    if (!dirty) return true

    if (!m) {
      updateStatus({ kind: 'error', text: 'model is required' })
      return false
    }

    setSaving(true)
    updateStatus({ kind: '', text: '' })

    try {
      const r = await fetch('/api/settings/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m }),
      })

      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        const msg = data?.error || data?.detail || 'save failed'
        updateStatus({ kind: 'error', text: String(msg) })
        return false
      }

      const newModel = String(data?.model || m).trim()
      setSavedModel(newModel)
      setDraftModel(newModel)
      updateStatus({ kind: 'ok', text: 'saved' })
      onModelSaved?.(newModel)
      return true
    } catch {
      updateStatus({ kind: 'error', text: 'save failed' })
      return false
    } finally {
      setSaving(false)
    }
  }, [locked, saving, draftModel, dirty, updateStatus, onModelSaved])

  // Expose handle to parent
  useEffect(() => {
    handleRef?.({ dirty, save: doSave })
    return () => handleRef?.(null)
  }, [dirty, doSave, handleRef])

  const draftTrim = (draftModel || '').trim()
  const draftIsKnownModel = modelOptions.items.some(
    (m) => m.value === draftTrim && m.value !== '__custom__',
  )
  const modelSelectValue = forceCustomModel ? '__custom__' : draftIsKnownModel ? draftTrim : '__custom__'

  return (
    <>
      <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 8 }}>
        new sessions · saved: <span style={{ color: AMBER[500] }}>{savedModel || '—'}</span>
      </div>

      <select
        value={modelSelectValue}
        onChange={(e) => {
          const v = e.target.value
          if (locked) return

          if (v === '__custom__') {
            setForceCustomModel(true)
          } else {
            setForceCustomModel(false)
            if (v) setDraftModel(v)
          }

          setStatus({ kind: '', text: '' })
        }}
        disabled={locked}
        style={{
          width: '100%',
          background: SLATE.elevated,
          border: `1px solid ${SLATE.border}`,
          color: SLATE.textBright,
          padding: '10px 10px',
          fontFamily: "'JetBrains Mono',monospace",
          fontSize: 12,
          outline: 'none',
          borderRadius: 8,
          opacity: locked ? 0.5 : 1,
        }}
        title="Default model (new sessions)"
      >
        {modelOptions.items.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {modelSelectValue === '__custom__' && (
        <input
          value={draftModel}
          onChange={(e) => {
            setForceCustomModel(true)
            setDraftModel(e.target.value)
            setStatus({ kind: '', text: '' })
          }}
          placeholder={savedModel || 'provider/model'}
          disabled={locked}
          style={{
            width: '100%',
            background: SLATE.elevated,
            border: `1px solid ${SLATE.border}`,
            color: SLATE.textBright,
            padding: '10px 10px',
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 12,
            outline: 'none',
            borderRadius: 8,
            marginTop: 10,
            opacity: locked ? 0.5 : 1,
          }}
          title="Custom model"
        />
      )}

      {modelOptions.loading && (
        <div style={{ marginTop: 10, fontSize: 10, color: SLATE.muted }}>loading model list...</div>
      )}

      {status.text && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: status.kind === 'error' ? SLATE.danger : status.kind === 'ok' ? SLATE.success : SLATE.muted,
          }}
        >
          {status.text}
        </div>
      )}
    </>
  )
}
