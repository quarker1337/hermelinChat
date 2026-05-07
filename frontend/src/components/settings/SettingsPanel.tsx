import { useState, useEffect, useCallback, useRef } from 'react'
import { AMBER, SLATE } from '../../theme/index'
import { normalizeUiPrefs, DEFAULT_UI_PREFS } from '../../utils/ui-prefs'
import { CollapsiblePanel } from '../shared/CollapsiblePanel'
import { SettingsIcon } from '../shared/icons'

import { AgentSettings, type AgentSettingsHandle } from './AgentSettings'
import { ArtifactSettings, type ArtifactSettingsHandle } from './ArtifactSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { BackgroundSettings } from './BackgroundSettings'
import { TerminalCursorSettings } from './TerminalCursorSettings'
import { VideoFxSettings } from './VideoFxSettings'
import { HermesDashboardSettings } from './HermesDashboardSettings'

import type { UiPrefs } from '../../types'

// ─── Version ────────────────────────────────────────────────────────

const HERMELINCHAT_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.15'

// ─── Types ──────────────────────────────────────────────────────────

interface SettingsPanelProps {
  onClose: () => void
  locked?: boolean
  onSaved?: () => void
  uiPrefs: UiPrefs
  onUiPrefsChange?: (updater: UiPrefs | ((prev: UiPrefs) => UiPrefs)) => void
}

// ─── Component ──────────────────────────────────────────────────────

export const SettingsPanel = ({
  onClose,
  locked = false,
  onSaved,
  uiPrefs,
  onUiPrefsChange,
}: SettingsPanelProps) => {
  const ui = normalizeUiPrefs(uiPrefs)

  // ─── Update check ──────────────────────────────────────────────

  const [updateInfo, setUpdateInfo] = useState<{
    current: string
    latest: string
    update_available: boolean
    url: string
    commits_behind_main?: number | null
    compare_url?: string | null
  } | null>(null)

  useEffect(() => {
    fetch('/api/update-check')
      .then((r) => r.json())
      .then((data) => setUpdateInfo(data))
      .catch(() => {}) // silently fail
  }, [])

  const [openPanel, setOpenPanel] = useState<string | null>(null)
  const togglePanel = (id: string) => {
    setOpenPanel((cur) => (cur === id ? null : id))
  }

  // ─── Sub-panel handles ──────────────────────────────────────────

  const agentRef = useRef<AgentSettingsHandle | null>(null)
  const artifactRef = useRef<ArtifactSettingsHandle | null>(null)

  const [, forceUpdate] = useState(0)
  const bump = useCallback(() => forceUpdate((n) => n + 1), [])

  // Callbacks that both store the handle AND trigger a re-render so the
  // dirty count in the footer stays accurate.
  const setAgentHandle = useCallback(
    (h: AgentSettingsHandle | null) => { agentRef.current = h; bump() },
    [bump],
  )
  const setArtifactHandle = useCallback(
    (h: ArtifactSettingsHandle | null) => { artifactRef.current = h; bump() },
    [bump],
  )

  // ─── Dirty tracking ────────────────────────────────────────────

  const agentDirty = !!agentRef.current?.dirty
  const artifactDirty = !!artifactRef.current?.dirty

  const dirtyCount = (agentDirty ? 1 : 0) + (artifactDirty ? 1 : 0)
  const dirty = dirtyCount > 0

  // ─── Save ──────────────────────────────────────────────────────

  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: '' | 'ok' | 'error'; text: string }>({ kind: '', text: '' })

  const doSave = useCallback(async () => {
    if (locked || saving) return
    if (!dirty) return

    setSaving(true)
    setStatus({ kind: '', text: '' })

    try {
      // Save each dirty sub-panel sequentially
      if (agentRef.current?.dirty) {
        const ok = await agentRef.current.save()
        if (!ok) {
          setStatus({ kind: 'error', text: 'agent save failed' })
          return
        }
      }

      if (artifactRef.current?.dirty) {
        const ok = await artifactRef.current.save()
        if (!ok) {
          setStatus({ kind: 'error', text: 'artifact save failed' })
          return
        }
      }

      setStatus({ kind: 'ok', text: 'saved' })
      onSaved?.()
      onClose?.()
    } catch {
      setStatus({ kind: 'error', text: 'save failed' })
    } finally {
      setSaving(false)
    }
  }, [locked, saving, dirty, onSaved, onClose])

  // ─── Close handling ────────────────────────────────────────────

  const attemptClose = useCallback(() => {
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes?')
      if (!ok) return
    }
    onClose?.()
  }, [dirty, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') attemptClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [attemptClose])

  // ─── Derived ───────────────────────────────────────────────────

  const statusColor =
    status.kind === 'error' ? SLATE.danger : status.kind === 'ok' ? SLATE.success : SLATE.muted

  const canSave = !locked && !saving && dirty
  const commitsBehindMain =
    typeof updateInfo?.commits_behind_main === 'number' && updateInfo.commits_behind_main > 0
      ? updateInfo.commits_behind_main
      : null
  const commitsBehindLabel = commitsBehindMain === null
    ? ''
    : `${commitsBehindMain} commit${commitsBehindMain === 1 ? '' : 's'} behind main`
  const showUpdateNotice = !!updateInfo && (updateInfo.update_available || commitsBehindMain !== null)
  const updateNoticeTitle = updateInfo?.update_available
    ? `Update from ${updateInfo.current} → ${updateInfo.latest}`
    : commitsBehindLabel
  const updateNoticeUrl = updateInfo
    ? updateInfo.update_available
      ? updateInfo.url
      : updateInfo.compare_url || updateInfo.url
    : ''

  const onUiUpdate = useCallback(
    (updater: (prev: UiPrefs) => UiPrefs) => {
      onUiPrefsChange?.(updater)
    },
    [onUiPrefsChange],
  )

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div
      onClick={attemptClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          borderLeft: `1px solid ${SLATE.border}`,
          background: `${SLATE.surface}f8`,
          padding: 16,
          boxShadow: `0 0 30px ${AMBER[900]}55`,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SettingsIcon size={18} />
          <div style={{ color: AMBER[400], fontWeight: 700, fontSize: 12 }}>
            {`settings${dirty ? ' *' : ''}`}
          </div>
          <div style={{ flex: 1 }} />
          <div
            onClick={attemptClose}
            style={{ fontSize: 11, color: SLATE.muted, cursor: 'pointer', userSelect: 'none' }}
            title="Close (Esc)"
          >
            close
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CollapsiblePanel
            title="Hermes Agent"
            open={openPanel === 'agent'}
            onToggle={() => togglePanel('agent')}
          >
            <AgentSettings locked={locked} saving={saving} handleRef={setAgentHandle} />
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Hermes Dashboard"
            open={openPanel === 'hermesDashboard'}
            onToggle={() => togglePanel('hermesDashboard')}
          >
            <HermesDashboardSettings locked={locked} />
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Default artifacts"
            open={openPanel === 'defaultArtifacts'}
            onToggle={() => togglePanel('defaultArtifacts')}
          >
            <ArtifactSettings locked={locked} saving={saving} handleRef={setArtifactHandle} />
          </CollapsiblePanel>

          <CollapsiblePanel title="UI" open={openPanel === 'ui'} onToggle={() => togglePanel('ui')}>
            <div style={{ fontSize: 10, color: SLATE.muted, marginBottom: 8 }}>local to this browser</div>

            <AppearanceSettings ui={ui} onUpdate={onUiUpdate} />

            <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

            <BackgroundSettings ui={ui} onUpdate={onUiUpdate} />

            <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

            <div
              style={{
                marginTop: 12,
                fontSize: 10,
                color: SLATE.muted,
                letterSpacing: 0.9,
                textTransform: 'uppercase',
              }}
            >
              Terminal
            </div>

            <TerminalCursorSettings ui={ui} onUpdate={onUiUpdate} />

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <div
                onClick={() => onUiPrefsChange?.(DEFAULT_UI_PREFS)}
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
                title="Reset UI settings"
              >
                reset UI
              </div>
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Video FX (recording)"
            open={openPanel === 'videoFx'}
            onToggle={() => togglePanel('videoFx')}
          >
            <VideoFxSettings ui={ui} onUpdate={onUiUpdate} />
          </CollapsiblePanel>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: statusColor }}>
              {locked
                ? 'login required'
                : saving
                  ? 'saving...'
                  : status.text || (dirty ? 'unsaved changes' : 'saved')}
            </div>
            <div style={{ flex: 1 }} />
            <div
              onClick={doSave}
              style={{
                padding: '9px 12px',
                border: `1px solid ${canSave ? AMBER[700] : SLATE.border}`,
                background: canSave ? `${AMBER[900]}55` : SLATE.elevated,
                color: canSave ? AMBER[400] : SLATE.muted,
                cursor: canSave ? 'pointer' : 'default',
                fontSize: 12,
                userSelect: 'none',
                borderRadius: 8,
                opacity: canSave ? 1 : 0.5,
              }}
              title={dirty ? 'Save settings' : 'No changes'}
            >
              save{dirtyCount ? ` (${dirtyCount})` : ''}
            </div>
          </div>

          <div style={{ fontSize: 10, textAlign: 'right' }}>
            <span style={{ color: SLATE.muted }}>
              hermelinChat Version: {HERMELINCHAT_VERSION}
            </span>
            {showUpdateNotice && updateInfo && (
              <div style={{ marginTop: 4 }}>
                <span
                  style={{
                    color: AMBER[400],
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                  onClick={() => window.open(updateNoticeUrl, '_blank')}
                  title={updateNoticeTitle}
                >
                  {updateInfo.update_available
                    ? `⚡ Update available: v${updateInfo.latest}`
                    : '⚡ Main branch is newer'}
                </span>
                {commitsBehindLabel && (
                  <div style={{ color: SLATE.muted, marginTop: 2 }}>
                    {commitsBehindLabel}
                  </div>
                )}
                <div style={{ color: SLATE.muted, marginTop: 2 }}>
                  Run from your hermelinChat checkout: ./scripts/update.sh --restart
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
