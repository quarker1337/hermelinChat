import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { AMBER, SLATE } from '../../theme/index'

interface AgentConfig {
  hermelin: {
    hermes_launch_mode: 'chat' | 'tui'
    hermes_cmd_override: boolean
    effective_hermes_cmd: string
  }
}

export interface AgentSettingsHandle {
  dirty: boolean
  save: () => Promise<boolean>
}

interface AgentSettingsProps {
  locked?: boolean
  saving?: boolean
  handleRef?: (handle: AgentSettingsHandle | null) => void
}

function normalizeAgentSettings(raw: unknown): AgentConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const hermelin = r.hermelin && typeof r.hermelin === 'object' ? (r.hermelin as Record<string, unknown>) : {}
  const launchModeRaw = (hermelin.hermes_launch_mode || 'chat').toString().trim().toLowerCase()
  const launchMode = launchModeRaw === 'tui' ? 'tui' : 'chat'

  return {
    hermelin: {
      hermes_launch_mode: launchMode,
      hermes_cmd_override: !!hermelin.hermes_cmd_override,
      effective_hermes_cmd: (hermelin.effective_hermes_cmd || '').toString().trim(),
    },
  }
}

export const AgentSettings = ({ locked = false, saving = false, handleRef }: AgentSettingsProps) => {
  const [loading, setLoading] = useState(true)
  const [configPath, setConfigPath] = useState('')
  const [saved, setSaved] = useState<AgentConfig | null>(null)
  const [draft, setDraft] = useState<AgentConfig | null>(null)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (locked) {
        if (!cancelled) {
          setLoading(false)
          setSaved(null)
          setDraft(null)
          setConfigPath('')
        }
        return
      }

      setLoading(true)
      try {
        const r = await fetch('/api/settings/agent')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const normalized = normalizeAgentSettings(data)
        if (!cancelled) {
          setConfigPath((data?.config_path || '').toString())
          setSaved(normalized)
          setDraft(normalized)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          const fallback = normalizeAgentSettings({})
          setSaved(fallback)
          setDraft(fallback)
          setLoading(false)
        }
      }
    }

    run()
    return () => { cancelled = true }
  }, [locked])

  const dirty = !!saved && !!draft && saved.hermelin.hermes_launch_mode !== draft.hermelin.hermes_launch_mode

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!dirty || !draft) return true

    try {
      const r = await fetch('/api/settings/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hermelin: { hermes_launch_mode: draft.hermelin.hermes_launch_mode } }),
      })

      const data = await r.json().catch(() => ({}))
      if (!r.ok) return false

      const normalized = normalizeAgentSettings(data)
      setConfigPath((data?.config_path || '').toString())
      setSaved(normalized)
      setDraft(normalized)
      return true
    } catch {
      return false
    }
  }, [dirty, draft])

  useEffect(() => {
    handleRef?.({ dirty, save: doSave })
    return () => handleRef?.(null)
  }, [dirty, doSave, handleRef])

  const disabled = locked || saving

  const selectStyle: CSSProperties = {
    background: SLATE.elevated,
    border: `1px solid ${SLATE.border}`,
    color: SLATE.textBright,
    padding: '6px 8px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    outline: 'none',
    borderRadius: 8,
    opacity: locked ? 0.5 : 1,
  }

  if (loading) return <div style={{ fontSize: 10, color: SLATE.muted }}>loading Hermes integration...</div>
  if (!draft) return <div style={{ fontSize: 10, color: SLATE.muted }}>Hermes integration settings unavailable</div>

  return (
    <>
      <div
        style={{ fontSize: 10, color: SLATE.muted, marginBottom: 8, lineHeight: 1.45 }}
        title={configPath || '~/.hermes/config.yaml'}
      >
        Launch mode for new terminals.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Launch mode</div>
        <div style={{ flex: 1 }} />
        <select
          value={draft.hermelin.hermes_launch_mode}
          disabled={disabled}
          onChange={(e) => {
            if (locked) return
            const v = e.target.value === 'tui' ? 'tui' : 'chat'
            setDraft((prev) => (prev ? { ...prev, hermelin: { ...prev.hermelin, hermes_launch_mode: v } } : prev))
          }}
          style={selectStyle}
          title="Choose the Hermes interface used for new terminal sessions"
        >
          <option value="chat">Classic Hermes chat</option>
          <option value="tui">Hermes TUI</option>
        </select>
      </div>

      {draft.hermelin.hermes_launch_mode === 'tui' && (
        <div style={{ marginTop: 6, fontSize: 10, color: SLATE.muted, lineHeight: 1.45 }}>
          TUI wheel: PageUp/PageDown.
        </div>
      )}

      {draft.hermelin.hermes_cmd_override && (
        <div
          style={{
            marginTop: 8,
            border: `1px solid ${AMBER[700]}55`,
            background: `${AMBER[900]}22`,
            color: AMBER[400],
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 10,
            lineHeight: 1.45,
          }}
        >
          Env override active: HERMELIN_HERMES_CMD.
        </div>
      )}

      {draft.hermelin.effective_hermes_cmd && (
        <div style={{ marginTop: 8, fontSize: 10, color: SLATE.muted }} title={draft.hermelin.effective_hermes_cmd}>
          command: <span style={{ color: AMBER[500] }}>{draft.hermelin.effective_hermes_cmd}</span>
        </div>
      )}
    </>
  )
}
