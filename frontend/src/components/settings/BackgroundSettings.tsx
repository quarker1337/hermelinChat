import { AMBER, SLATE } from '../../theme/index'
import type { UiPrefs } from '../../types'

// ─── Types ──────────────────────────────────────────────────────────

interface BackgroundSettingsProps {
  ui: UiPrefs
  onUpdate: (updater: (prev: UiPrefs) => UiPrefs) => void
}

// ─── Component ──────────────────────────────────────────────────────

export const BackgroundSettings = ({ ui, onUpdate }: BackgroundSettingsProps) => {
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
      {/* Background effect toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Background effect</div>
        <div style={{ flex: 1 }} />
        <input
          type="checkbox"
          checked={!!ui.particles.enabled}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              particles: { ...prev.particles, enabled: e.target.checked },
            }))
          }}
          style={{ accentColor: AMBER[400] }}
        />
      </div>

      {/* Intensity slider */}
      <div
        style={{
          marginTop: 10,
          opacity: ui.particles.enabled ? 1 : 0.4,
          pointerEvents: ui.particles.enabled ? 'auto' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Intensity</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: AMBER[500] }}>{ui.particles.intensity}%</div>
        </div>
        <input
          type="range"
          min={50}
          max={100}
          step={1}
          value={ui.particles.intensity}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              particles: { ...prev.particles, intensity: Number(e.target.value) },
            }))
          }}
          style={{ width: '100%' }}
        />
      </div>

      {/* Effect dropdown */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 10,
          opacity: ui.particles.enabled ? 1 : 0.4,
          pointerEvents: ui.particles.enabled ? 'auto' : 'none',
        }}
      >
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Effect</div>
        <div style={{ flex: 1 }} />
        <select
          value={ui.background?.effect || 'auto'}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              background: { ...(prev.background || {}), effect: e.target.value },
            }))
          }}
          style={selectStyle}
          title="Background effect"
        >
          <option value="auto">theme default</option>
          <option value="particles">particles</option>
          <option value="matrix-rain">matrix rain</option>
          <option value="nous-crt">nous crt</option>
          <option value="samaritan">samaritan</option>
        </select>
      </div>
    </>
  )
}
