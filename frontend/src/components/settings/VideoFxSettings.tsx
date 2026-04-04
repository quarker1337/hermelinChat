import { AMBER, SLATE } from '../../theme/index'
import { DEFAULT_UI_PREFS } from '../../utils/ui-prefs'
import type { UiPrefs } from '../../types'

// ─── Types ──────────────────────────────────────────────────────────

interface VideoFxSettingsProps {
  ui: UiPrefs
  onUpdate: (updater: (prev: UiPrefs) => UiPrefs) => void
}

// ─── Component ──────────────────────────────────────────────────────

export const VideoFxSettings = ({ ui, onUpdate }: VideoFxSettingsProps) => {
  return (
    <>
      <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
        Extra CRT/glitch post-processing that sits on top of the{' '}
        <span style={{ color: AMBER[500] }}>whole interface</span>. Stored locally in your browser
        (useful for OBS browser sources).
      </div>

      {/* Enable toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Enable</div>
        <div style={{ flex: 1 }} />
        <input
          type="checkbox"
          checked={!!ui.videoFx.enabled}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              videoFx: { ...(prev.videoFx || {}), enabled: e.target.checked },
            }))
          }}
          style={{ accentColor: AMBER[400] }}
        />
      </div>

      <div
        style={{
          marginTop: 10,
          opacity: ui.videoFx.enabled ? 1 : 0.45,
          pointerEvents: ui.videoFx.enabled ? 'auto' : 'none',
        }}
      >
        {/* Intensity slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Intensity</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: AMBER[500] }}>{ui.videoFx.intensity}%</div>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={ui.videoFx.intensity}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              videoFx: { ...(prev.videoFx || {}), intensity: Number(e.target.value) },
            }))
          }}
          style={{ width: '100%' }}
        />

        {/* Glitch pulses */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Glitch pulses</div>
          <div style={{ flex: 1 }} />
          <input
            type="checkbox"
            checked={!!ui.videoFx.glitchPulses}
            onChange={(e) => {
              onUpdate((prev) => ({
                ...prev,
                videoFx: { ...(prev.videoFx || {}), glitchPulses: e.target.checked },
              }))
            }}
            style={{ accentColor: AMBER[400] }}
          />
        </div>

        {/* Reset button */}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <div
            onClick={() =>
              onUpdate((prev) => ({
                ...prev,
                videoFx: { ...DEFAULT_UI_PREFS.videoFx },
              }))
            }
            style={{
              padding: '8px 10px',
              border: `1px solid ${SLATE.border}`,
              background: SLATE.elevated,
              color: SLATE.muted,
              cursor: 'pointer',
              fontSize: 11,
              borderRadius: 8,
              userSelect: 'none',
            }}
            title="Reset Video FX settings"
          >
            reset video fx
          </div>
        </div>
      </div>
    </>
  )
}
