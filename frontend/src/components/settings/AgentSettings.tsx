import { useState, useEffect, useCallback } from 'react'
import { AMBER, SLATE } from '../../theme/index'

// ─── Types ──────────────────────────────────────────────────────────

interface AgentConfig {
  agent: {
    max_turns: number
    verbose: boolean
    reasoning_effort: string
  }
  display: {
    compact: boolean
    tool_progress: string
  }
  memory: {
    memory_enabled: boolean
    user_profile_enabled: boolean
  }
  compression: {
    enabled: boolean
    threshold_pct: number
    summary_model: string
  }
  terminal: {
    backend: string
    cwd: string
    timeout: number
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

// ─── Normalize ──────────────────────────────────────────────────────

function normalizeAgentSettings(raw: unknown): AgentConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const agent = r.agent && typeof r.agent === 'object' ? (r.agent as Record<string, unknown>) : {}
  const display = r.display && typeof r.display === 'object' ? (r.display as Record<string, unknown>) : {}
  const memory = r.memory && typeof r.memory === 'object' ? (r.memory as Record<string, unknown>) : {}
  const compression =
    r.compression && typeof r.compression === 'object' ? (r.compression as Record<string, unknown>) : {}
  const terminal = r.terminal && typeof r.terminal === 'object' ? (r.terminal as Record<string, unknown>) : {}

  return {
    agent: {
      max_turns: Math.max(1, Math.min(500, Number(agent.max_turns ?? 60) || 60)),
      verbose: !!agent.verbose,
      reasoning_effort: (agent.reasoning_effort || 'xhigh').toString().trim() || 'xhigh',
    },
    display: {
      compact: !!display.compact,
      tool_progress: (display.tool_progress || 'all').toString().trim() || 'all',
    },
    memory: {
      memory_enabled: memory.memory_enabled === undefined ? true : !!memory.memory_enabled,
      user_profile_enabled: memory.user_profile_enabled === undefined ? true : !!memory.user_profile_enabled,
    },
    compression: {
      enabled: compression.enabled === undefined ? true : !!compression.enabled,
      threshold_pct: Math.max(50, Math.min(99, Number(compression.threshold_pct ?? 85) || 85)),
      summary_model:
        (compression.summary_model || 'google/gemini-3-flash-preview').toString().trim() ||
        'google/gemini-3-flash-preview',
    },
    terminal: {
      backend: (terminal.backend || 'local').toString().trim() || 'local',
      cwd: (terminal.cwd || '.').toString().trim() || '.',
      timeout: Math.max(1, Math.min(3600, Number(terminal.timeout ?? 60) || 60)),
    },
  }
}

// ─── Component ──────────────────────────────────────────────────────

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
          setSaved(normalizeAgentSettings({}))
          setDraft(normalizeAgentSettings({}))
          setLoading(false)
        }
      }
    }

    run()
    return () => { cancelled = true }
  }, [locked])

  const dirty = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft)

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!dirty || !draft) return true

    try {
      const r = await fetch('/api/settings/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
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

  // Expose handle to parent
  useEffect(() => {
    handleRef?.({ dirty, save: doSave })
    return () => handleRef?.(null)
  }, [dirty, doSave, handleRef])

  const disabled = locked || saving

  const updateDraft = (updater: (prev: AgentConfig) => AgentConfig) => {
    setDraft((prev) => {
      if (!prev) return prev
      return updater(prev)
    })
  }

  const selectStyle: React.CSSProperties = {
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

  const checkboxStyle: React.CSSProperties = {
    accentColor: AMBER[400],
    opacity: locked ? 0.5 : 1,
  }

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: SLATE.border,
    margin: '12px 0',
  }

  const sectionHeaderStyle: React.CSSProperties = {
    fontSize: 10,
    color: SLATE.muted,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    marginBottom: 8,
  }

  return (
    <>
      <div
        style={{ fontSize: 10, color: SLATE.muted, marginBottom: 8 }}
        title={configPath || '~/.hermes/config.yaml'}
      >
        config.yaml · mostly new sessions
      </div>

      {loading && <div style={{ fontSize: 10, color: SLATE.muted }}>loading agent settings...</div>}

      {!loading && !draft && (
        <div style={{ fontSize: 10, color: SLATE.muted }}>agent settings unavailable</div>
      )}

      {!loading && draft && (
        <>
          {/* Max turns */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Max turns</div>
            <div style={{ flex: 1 }} />
            <input
              type="number"
              value={draft.agent.max_turns}
              min={1}
              max={500}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                const v = Math.max(1, Math.min(500, Number(e.target.value) || 1))
                updateDraft((prev) => ({ ...prev, agent: { ...prev.agent, max_turns: v } }))
              }}
              style={{
                width: 90,
                background: SLATE.elevated,
                border: `1px solid ${SLATE.border}`,
                color: SLATE.textBright,
                padding: '6px 8px',
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 11,
                outline: 'none',
                borderRadius: 8,
                opacity: locked ? 0.5 : 1,
                textAlign: 'right',
              }}
              title="Maximum tool-calling iterations"
            />
          </div>

          {/* Reasoning effort */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Reasoning effort</div>
            <div style={{ flex: 1 }} />
            <select
              value={(draft.agent.reasoning_effort || 'xhigh').toString().toLowerCase()}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                const v = (e.target.value || 'xhigh').toString().toLowerCase()
                updateDraft((prev) => ({ ...prev, agent: { ...prev.agent, reasoning_effort: v } }))
              }}
              style={selectStyle}
              title="OpenRouter reasoning effort"
            >
              <option value="xhigh">xhigh</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="minimal">minimal</option>
              <option value="none">none</option>
            </select>
          </div>

          {/* Verbose */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Verbose</div>
            <div style={{ flex: 1 }} />
            <input
              type="checkbox"
              checked={!!draft.agent.verbose}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                updateDraft((prev) => ({ ...prev, agent: { ...prev.agent, verbose: e.target.checked } }))
              }}
              style={checkboxStyle}
            />
          </div>

          <div style={dividerStyle} />

          {/* Compact output */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Compact output</div>
            <div style={{ flex: 1 }} />
            <input
              type="checkbox"
              checked={!!draft.display.compact}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                updateDraft((prev) => ({ ...prev, display: { ...prev.display, compact: e.target.checked } }))
              }}
              style={checkboxStyle}
            />
          </div>

          {/* Tool progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Tool progress</div>
            <div style={{ flex: 1 }} />
            <select
              value={(draft.display.tool_progress || 'all').toString().toLowerCase()}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                const v = (e.target.value || 'all').toString().toLowerCase()
                updateDraft((prev) => ({ ...prev, display: { ...prev.display, tool_progress: v } }))
              }}
              style={selectStyle}
              title="Rich tool progress output"
            >
              <option value="off">off</option>
              <option value="new">new</option>
              <option value="all">all</option>
              <option value="verbose">verbose</option>
            </select>
          </div>

          <div style={dividerStyle} />

          {/* Memory */}
          <div style={sectionHeaderStyle}>Memory</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enable memory</div>
            <div style={{ flex: 1 }} />
            <input
              type="checkbox"
              checked={!!draft.memory.memory_enabled}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                updateDraft((prev) => ({
                  ...prev,
                  memory: { ...prev.memory, memory_enabled: e.target.checked },
                }))
              }}
              style={checkboxStyle}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enable user profile</div>
            <div style={{ flex: 1 }} />
            <input
              type="checkbox"
              checked={!!draft.memory.user_profile_enabled}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                updateDraft((prev) => ({
                  ...prev,
                  memory: { ...prev.memory, user_profile_enabled: e.target.checked },
                }))
              }}
              style={checkboxStyle}
            />
          </div>

          <div style={dividerStyle} />

          {/* Context compression */}
          <div style={sectionHeaderStyle}>Context compression</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enabled</div>
            <div style={{ flex: 1 }} />
            <input
              type="checkbox"
              checked={!!draft.compression.enabled}
              disabled={disabled}
              onChange={(e) => {
                if (locked) return
                updateDraft((prev) => ({
                  ...prev,
                  compression: { ...prev.compression, enabled: e.target.checked },
                }))
              }}
              style={checkboxStyle}
            />
          </div>

          <div
            style={{
              marginTop: 10,
              opacity: draft.compression.enabled ? 1 : 0.4,
              pointerEvents: draft.compression.enabled ? 'auto' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Threshold</div>
              <div style={{ flex: 1 }} />
              <div style={{ fontSize: 11, color: AMBER[500] }}>{draft.compression.threshold_pct}%</div>
            </div>
            <input
              type="range"
              min={50}
              max={99}
              step={1}
              value={draft.compression.threshold_pct}
              onChange={(e) => {
                if (locked) return
                const v = Math.max(50, Math.min(99, Number(e.target.value) || 85))
                updateDraft((prev) => ({
                  ...prev,
                  compression: { ...prev.compression, threshold_pct: v },
                }))
              }}
              style={{ width: '100%' }}
            />

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600, marginBottom: 6 }}>
                Summary model
              </div>
              <input
                value={draft.compression.summary_model}
                onChange={(e) => {
                  if (locked) return
                  const v = e.target.value
                  updateDraft((prev) => ({
                    ...prev,
                    compression: { ...prev.compression, summary_model: v },
                  }))
                }}
                placeholder="google/gemini-3-flash-preview"
                disabled={disabled}
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
              />
            </div>
          </div>

          <div style={dividerStyle} />

          {/* Terminal tool */}
          <div style={sectionHeaderStyle}>Terminal tool</div>

          <div>
            <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600, marginBottom: 6 }}>
              Working dir
            </div>
            <input
              value={draft.terminal.cwd}
              onChange={(e) => {
                if (locked) return
                const v = e.target.value
                updateDraft((prev) => ({ ...prev, terminal: { ...prev.terminal, cwd: v } }))
              }}
              placeholder="."
              disabled={disabled}
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
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Timeout (s)</div>
              <div style={{ flex: 1 }} />
              <input
                type="number"
                value={draft.terminal.timeout}
                min={1}
                max={3600}
                disabled={disabled}
                onChange={(e) => {
                  if (locked) return
                  const v = Math.max(1, Math.min(3600, Number(e.target.value) || 1))
                  updateDraft((prev) => ({ ...prev, terminal: { ...prev.terminal, timeout: v } }))
                }}
                style={{
                  width: 110,
                  background: SLATE.elevated,
                  border: `1px solid ${SLATE.border}`,
                  color: SLATE.textBright,
                  padding: '6px 8px',
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 11,
                  outline: 'none',
                  borderRadius: 8,
                  opacity: locked ? 0.5 : 1,
                  textAlign: 'right',
                }}
              />
            </div>

            <div style={{ marginTop: 8, fontSize: 10, color: SLATE.muted }}>
              backend: <span style={{ color: AMBER[500] }}>{draft.terminal.backend}</span>
            </div>
          </div>
        </>
      )}
    </>
  )
}
