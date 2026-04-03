import { SLATE } from '../../theme/index.js'
import { THEME_OPTIONS } from '../../theme/index.js'
import { DEFAULT_UI_PREFS } from '../../utils/ui-prefs'
import type { UiPrefs } from '../../types'

// ─── Types ──────────────────────────────────────────────────────────

interface AppearanceSettingsProps {
  ui: UiPrefs
  onUpdate: (updater: (prev: UiPrefs) => UiPrefs) => void
}

// ─── Component ──────────────────────────────────────────────────────

export const AppearanceSettings = ({ ui, onUpdate }: AppearanceSettingsProps) => {
  const selectStyle: React.CSSProperties = {
    background: SLATE.elevated,
    border: `1px solid ${SLATE.border}`,
    color: SLATE.textBright,
    padding: '6px 8px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    outline: 'none',
    borderRadius: 8,
  }

  return (
    <>
      {/* App name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>App name</div>
        <div style={{ flex: 1 }} />
        <input
          type="text"
          value={ui.appName}
          placeholder={DEFAULT_UI_PREFS.appName}
          maxLength={64}
          onChange={(e) => {
            onUpdate((prev) => ({ ...prev, appName: e.target.value }))
          }}
          style={{
            width: 220,
            background: SLATE.elevated,
            border: `1px solid ${SLATE.border}`,
            color: SLATE.textBright,
            padding: '6px 8px',
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 11,
            outline: 'none',
            borderRadius: 8,
          }}
        />
      </div>

      <div style={{ marginTop: 6, fontSize: 10, color: SLATE.muted, lineHeight: 1.35 }}>
        sidebar + browser tab label
      </div>

      <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

      {/* Theme */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Theme</div>
        <div style={{ flex: 1 }} />
        <select
          value={ui.theme}
          onChange={(e) => {
            onUpdate((prev) => ({ ...prev, theme: e.target.value }))
          }}
          style={selectStyle}
          title="UI theme"
        >
          {THEME_OPTIONS.map((opt: { id: string; label: string }) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

      {/* Show timestamps */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Show timestamps</div>
        <div style={{ flex: 1 }} />
        <input
          type="checkbox"
          checked={!!ui.timestamps.enabled}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              timestamps: { ...prev.timestamps, enabled: e.target.checked },
            }))
          }}
          style={{ accentColor: '#f5b731' }}
        />
      </div>
    </>
  )
}
