import { AMBER, SLATE } from '../../theme/index'
import type { UiPrefs } from '../../types'

// ─── Types ──────────────────────────────────────────────────────────

interface TerminalCursorSettingsProps {
  ui: UiPrefs
  onUpdate: (updater: (prev: UiPrefs) => UiPrefs) => void
}

// ─── Component ──────────────────────────────────────────────────────

export const TerminalCursorSettings = ({ ui, onUpdate }: TerminalCursorSettingsProps) => {
  return (
    <div style={{ marginTop: 8 }}>
      {/* Cursor style */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Cursor style</div>
        <div style={{ flex: 1 }} />
        <select
          value={ui.terminal.cursorStyle}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              terminal: { ...prev.terminal, cursorStyle: e.target.value as 'bar' | 'block' | 'underline' },
            }))
          }}
          style={{
            background: SLATE.elevated,
            border: `1px solid ${SLATE.border}`,
            color: SLATE.textBright,
            padding: '6px 8px',
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 11,
            outline: 'none',
            borderRadius: 8,
          }}
          title="xterm cursor style"
        >
          <option value="bar">bar</option>
          <option value="block">block</option>
          <option value="underline">underline</option>
        </select>
      </div>

      {/* Cursor blink */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Cursor blink</div>
        <div style={{ flex: 1 }} />
        <input
          type="checkbox"
          checked={!!ui.terminal.cursorBlink}
          onChange={(e) => {
            onUpdate((prev) => ({
              ...prev,
              terminal: { ...prev.terminal, cursorBlink: e.target.checked },
            }))
          }}
          style={{ accentColor: AMBER[400] }}
        />
      </div>
    </div>
  )
}
