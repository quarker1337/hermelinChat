import { useState, useEffect, useCallback } from 'react'
import { AMBER, SLATE } from '../../theme/index'

// ─── Types ──────────────────────────────────────────────────────────

interface KeyMap {
  OPENROUTER_API_KEY: string
  FIRECRAWL_API_KEY: string
  BROWSERBASE_API_KEY: string
  BROWSERBASE_PROJECT_ID: string
  GITHUB_TOKEN: string
}

interface KeyStatusEntry {
  set?: boolean
}

interface KeyStatusState {
  loading: boolean
  keys: Record<string, KeyStatusEntry>
}

export interface KeySettingsHandle {
  dirty: boolean
  save: () => Promise<boolean>
}

interface KeySettingsProps {
  locked?: boolean
  handleRef?: (handle: KeySettingsHandle | null) => void
}

const INITIAL_DRAFT: KeyMap = {
  OPENROUTER_API_KEY: '',
  FIRECRAWL_API_KEY: '',
  BROWSERBASE_API_KEY: '',
  BROWSERBASE_PROJECT_ID: '',
  GITHUB_TOKEN: '',
}

// ─── Component ──────────────────────────────────────────────────────

export const KeySettings = ({ locked = false, handleRef }: KeySettingsProps) => {
  const [keyStatus, setKeyStatus] = useState<KeyStatusState>({ loading: true, keys: {} })
  const [draftKeys, setDraftKeys] = useState<KeyMap>({ ...INITIAL_DRAFT })

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      if (locked) {
        if (!cancelled) setKeyStatus({ loading: false, keys: {} })
        return
      }

      try {
        const r = await fetch('/api/settings/keys')
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail || `http ${r.status}`)

        const keys = data?.keys && typeof data.keys === 'object' ? data.keys : {}
        if (!cancelled) setKeyStatus({ loading: false, keys })
      } catch {
        if (!cancelled) setKeyStatus({ loading: false, keys: {} })
      }
    }

    run()
    return () => { cancelled = true }
  }, [locked])

  const keyUpdates = Object.entries(draftKeys).filter(([, v]) => (v || '').toString().trim())
  const dirty = keyUpdates.length > 0

  const doSave = useCallback(async (): Promise<boolean> => {
    const updates = keyUpdates.map(([k, v]) => [k, (v || '').toString().trim()])
    if (updates.length === 0) return true

    try {
      for (const [k, v] of updates) {
        const r = await fetch('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: k, value: v }),
        })

        const data = await r.json().catch(() => ({}))
        if (!r.ok) {
          return false
        }
        void data
      }

      setDraftKeys((prev) => {
        const next = { ...prev }
        for (const [k] of updates) (next as Record<string, string>)[k] = ''
        return next
      })

      // best-effort status refresh
      try {
        const r = await fetch('/api/settings/keys')
        const data = await r.json().catch(() => ({}))
        if (r.ok) {
          const keys = data?.keys && typeof data.keys === 'object' ? data.keys : {}
          setKeyStatus({ loading: false, keys })
        }
      } catch {
        // ignore
      }

      return true
    } catch {
      return false
    }
  }, [keyUpdates])

  // Expose handle to parent
  useEffect(() => {
    handleRef?.({ dirty, save: doSave })
    return () => handleRef?.(null)
  }, [dirty, doSave, handleRef])

  const isKeySet = (name: string) => !!keyStatus.keys?.[name]?.set

  const setDraftKey = (name: keyof KeyMap, value: string) => {
    setDraftKeys((prev) => ({ ...prev, [name]: value }))
  }

  const inputStyle = (disabled: boolean): React.CSSProperties => ({
    width: '100%',
    background: SLATE.elevated,
    border: `1px solid ${SLATE.border}`,
    color: SLATE.textBright,
    padding: '10px 10px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 12,
    outline: 'none',
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  })

  return (
    <>
      <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 8 }}>
        ~/.hermes/.env · blank = keep current
      </div>

      {keyStatus.loading && (
        <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 10 }}>loading key status...</div>
      )}

      {/* Model Provider */}
      <div style={{ fontSize: 10, color: SLATE.muted, letterSpacing: 0.9, textTransform: 'uppercase' }}>
        Model Provider
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>OpenRouter API Key</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 10, color: isKeySet('OPENROUTER_API_KEY') ? SLATE.success : SLATE.muted }}>
            {isKeySet('OPENROUTER_API_KEY') ? '● set' : '○ not set'}
          </div>
        </div>
        <input
          type="password"
          value={draftKeys.OPENROUTER_API_KEY}
          onChange={(e) => {
            if (locked) return
            setDraftKey('OPENROUTER_API_KEY', e.target.value)
          }}
          placeholder={isKeySet('OPENROUTER_API_KEY') ? 'update key... (leave blank to keep)' : 'sk-or-...'}
          disabled={locked}
          autoComplete="new-password"
          style={inputStyle(locked)}
        />
      </div>

      {/* Tools */}
      <div
        style={{
          marginTop: 14,
          fontSize: 10,
          color: SLATE.muted,
          letterSpacing: 0.9,
          textTransform: 'uppercase',
        }}
      >
        Tools
      </div>

      {/* Firecrawl */}
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>
            Web Search & Scraping (Firecrawl)
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 10, color: isKeySet('FIRECRAWL_API_KEY') ? SLATE.success : SLATE.muted }}>
            {isKeySet('FIRECRAWL_API_KEY') ? '● set' : '○ not set'}
          </div>
        </div>
        <input
          type="password"
          value={draftKeys.FIRECRAWL_API_KEY}
          onChange={(e) => {
            if (locked) return
            setDraftKey('FIRECRAWL_API_KEY', e.target.value)
          }}
          placeholder={isKeySet('FIRECRAWL_API_KEY') ? 'update key... (leave blank to keep)' : 'fc-...'}
          disabled={locked}
          autoComplete="new-password"
          style={inputStyle(locked)}
        />
      </div>

      {/* Browserbase */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>
            Browser Automation (Browserbase)
          </div>
          <div style={{ flex: 1 }} />
          <div
            style={{
              fontSize: 10,
              color:
                isKeySet('BROWSERBASE_API_KEY') && isKeySet('BROWSERBASE_PROJECT_ID')
                  ? SLATE.success
                  : isKeySet('BROWSERBASE_API_KEY') || isKeySet('BROWSERBASE_PROJECT_ID')
                    ? AMBER[500]
                    : SLATE.muted,
            }}
          >
            {isKeySet('BROWSERBASE_API_KEY') && isKeySet('BROWSERBASE_PROJECT_ID')
              ? '● set'
              : isKeySet('BROWSERBASE_API_KEY') || isKeySet('BROWSERBASE_PROJECT_ID')
                ? '◐ partial'
                : '○ not set'}
          </div>
        </div>

        <input
          type="password"
          value={draftKeys.BROWSERBASE_API_KEY}
          onChange={(e) => {
            if (locked) return
            setDraftKey('BROWSERBASE_API_KEY', e.target.value)
          }}
          placeholder={
            isKeySet('BROWSERBASE_API_KEY')
              ? 'Browserbase API key... (leave blank to keep)'
              : 'Browserbase API key...'
          }
          disabled={locked}
          autoComplete="new-password"
          style={inputStyle(locked)}
        />

        <input
          type="text"
          value={draftKeys.BROWSERBASE_PROJECT_ID}
          onChange={(e) => {
            if (locked) return
            setDraftKey('BROWSERBASE_PROJECT_ID', e.target.value)
          }}
          placeholder={
            isKeySet('BROWSERBASE_PROJECT_ID')
              ? 'Browserbase project id... (leave blank to keep)'
              : 'Browserbase project id...'
          }
          disabled={locked}
          autoComplete="off"
          style={{ ...inputStyle(locked), marginTop: 8 }}
        />
      </div>

      {/* GitHub Token */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Skills Hub (GitHub Token)</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 10, color: isKeySet('GITHUB_TOKEN') ? SLATE.success : SLATE.muted }}>
            {isKeySet('GITHUB_TOKEN') ? '● set' : '○ not set'}
          </div>
        </div>
        <input
          type="password"
          value={draftKeys.GITHUB_TOKEN}
          onChange={(e) => {
            if (locked) return
            setDraftKey('GITHUB_TOKEN', e.target.value)
          }}
          placeholder={isKeySet('GITHUB_TOKEN') ? 'update token... (leave blank to keep)' : 'ghp_...'}
          disabled={locked}
          autoComplete="new-password"
          style={inputStyle(locked)}
        />
      </div>
    </>
  )
}
