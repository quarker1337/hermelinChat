import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { useUiPrefsStore } from '../../stores/ui-prefs'
import { AMBER, SLATE } from '../../theme/index'

const DEFAULT_HERMES_DASHBOARD_PROXY_URL = '/api/runners/hermes-dashboard/'
const HERMES_DASHBOARD_STATUS_URL = '/api/hermes-dashboard/status'
const HERMES_DASHBOARD_THEME_URL = '/api/hermes-dashboard/theme'
const HERMES_DASHBOARD_START_URL = '/api/hermes-dashboard/start'
const HERMES_DASHBOARD_RESTART_URL = '/api/hermes-dashboard/restart'
const HERMES_DASHBOARD_STOP_URL = '/api/hermes-dashboard/stop'

interface DashboardStatus {
  ok?: boolean
  enabled?: boolean
  running?: boolean
  host?: string
  port?: number | null
  pid?: number | null
  base_path?: string
  proxy_path?: string
  tui?: boolean
  base_path_supported?: boolean | null
  stopped_by_user?: boolean
  dashboard_theme?: string
  theme_sync?: DashboardThemeSyncStatus
  last_error?: string
  started_at?: number | null
}

interface DashboardThemeSyncStatus {
  ok?: boolean
  ui_theme?: string
  dashboard_theme?: string
  config_changed?: boolean
  theme_files_changed?: boolean
  changed?: boolean
}

interface HermesDashboardSettingsProps {
  locked?: boolean
}

async function fetchDashboardStatus(): Promise<DashboardStatus> {
  const res = await fetch(HERMES_DASHBOARD_STATUS_URL)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.detail || data?.error || `http ${res.status}`)
  return data as DashboardStatus
}

async function syncDashboardTheme(uiTheme: string): Promise<DashboardThemeSyncStatus> {
  const res = await fetch(HERMES_DASHBOARD_THEME_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui_theme: uiTheme }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.detail || data?.error || `http ${res.status}`)
  return data as DashboardThemeSyncStatus
}

async function postDashboardAction(url: string, uiTheme: string): Promise<DashboardStatus> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui_theme: uiTheme }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.detail || data?.error || `http ${res.status}`)
  return data as DashboardStatus
}

function normalizeDashboardProxyUrl(value?: string): string {
  const raw = (value || DEFAULT_HERMES_DASHBOARD_PROXY_URL).trim() || DEFAULT_HERMES_DASHBOARD_PROXY_URL
  return raw.endsWith('/') ? raw : `${raw}/`
}

export const HermesDashboardSettings = ({ locked = false }: HermesDashboardSettingsProps) => {
  const uiTheme = useUiPrefsStore((s) => s.prefs.theme)
  const [status, setStatus] = useState<DashboardStatus | null>(null)
  const [themeSync, setThemeSync] = useState<DashboardThemeSyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [frameNonce, setFrameNonce] = useState(0)
  const [showFrame, setShowFrame] = useState(true)

  const refresh = useCallback(async () => {
    if (locked) {
      setStatus(null)
      setLoading(false)
      return
    }

    try {
      const next = await fetchDashboardStatus()
      setStatus(next)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'dashboard status unavailable')
    } finally {
      setLoading(false)
    }
  }, [locked])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await refresh()
    }
    run()
    const timer = window.setInterval(() => {
      if (!cancelled) refresh()
    }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (locked) {
      setThemeSync(null)
      return
    }

    let cancelled = false
    syncDashboardTheme(uiTheme)
      .then((next) => {
        if (cancelled) return
        setThemeSync(next)
        setStatus((prev) => (prev ? { ...prev, dashboard_theme: next.dashboard_theme, theme_sync: next } : prev))
        if (next.changed) setFrameNonce((n) => n + 1)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'dashboard theme sync failed')
      })

    return () => {
      cancelled = true
    }
  }, [locked, uiTheme])

  const runAction = useCallback(
    async (url: string, reloadFrame = false) => {
      if (locked || busy) return
      setBusy(true)
      setError('')
      try {
        const next = await postDashboardAction(url, uiTheme)
        setStatus(next)
        if (reloadFrame) setFrameNonce((n) => n + 1)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'dashboard action failed')
      } finally {
        setBusy(false)
      }
    },
    [busy, locked, uiTheme],
  )

  const buttonStyle = (active = true): CSSProperties => ({
    padding: '7px 9px',
    border: `1px solid ${active && !locked ? AMBER[700] : SLATE.border}`,
    background: active && !locked ? `${AMBER[900]}44` : SLATE.elevated,
    color: active && !locked ? AMBER[400] : SLATE.muted,
    cursor: active && !locked ? 'pointer' : 'default',
    fontSize: 11,
    borderRadius: 8,
    userSelect: 'none',
    opacity: active && !locked ? 1 : 0.55,
  })

  const running = !!status?.running
  const enabled = status?.enabled !== false
  const lastError = error || status?.last_error || ''
  const unsupportedBasePath = status?.base_path_supported === false && !!lastError
  const dashboardProxyUrl = normalizeDashboardProxyUrl(status?.proxy_path || status?.base_path)
  const matchedDashboardTheme = themeSync?.dashboard_theme || status?.dashboard_theme || status?.theme_sync?.dashboard_theme || ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 10, color: SLATE.muted, lineHeight: 1.45 }}>
        Native Hermes Agent dashboard, started on loopback and exposed through hermelinChat auth. hermelinChat also installs matching native dashboard themes and keeps <span style={{ color: AMBER[500] }}>dashboard.theme</span> synced to the selected UI theme.
      </div>

      <div
        style={{
          border: `1px solid ${running ? SLATE.success : SLATE.border}`,
          background: running ? `${SLATE.success}11` : SLATE.elevated,
          borderRadius: 10,
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div style={{ color: running ? SLATE.success : SLATE.muted, fontSize: 11, fontWeight: 700 }}>
          {locked ? 'locked' : loading ? 'checking...' : running ? 'running' : enabled ? 'stopped' : 'disabled'}
        </div>
        <div style={{ flex: 1 }} />
        {status?.pid && <div style={{ color: SLATE.muted, fontSize: 10 }}>pid {status.pid}</div>}
        {status?.host && status?.port && <div style={{ color: SLATE.muted, fontSize: 10 }}>{status.host}:{status.port}</div>}
      </div>

      {lastError && (
        <div
          style={{
            border: `1px solid ${unsupportedBasePath ? AMBER[700] : SLATE.danger}66`,
            background: unsupportedBasePath ? `${AMBER[900]}22` : `${SLATE.danger}11`,
            color: unsupportedBasePath ? AMBER[400] : SLATE.danger,
            borderRadius: 10,
            padding: '8px 10px',
            fontSize: 10,
            lineHeight: 1.45,
          }}
        >
          {lastError}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          disabled={locked || busy || !enabled}
          onClick={() => runAction(HERMES_DASHBOARD_START_URL, true)}
          style={buttonStyle(!running && !busy && enabled)}
        >
          {busy ? 'working...' : running ? 'started' : 'start'}
        </button>
        <button
          type="button"
          disabled={locked || busy || !enabled}
          onClick={() => runAction(HERMES_DASHBOARD_RESTART_URL, true)}
          style={buttonStyle(!busy && enabled)}
        >
          restart
        </button>
        <button
          type="button"
          disabled={locked || busy || !enabled}
          onClick={() => runAction(HERMES_DASHBOARD_STOP_URL, true)}
          style={buttonStyle(running && !busy && enabled)}
        >
          stop
        </button>
        <button
          type="button"
          disabled={locked || !running}
          onClick={() => window.open(dashboardProxyUrl, '_blank', 'noopener,noreferrer')}
          style={buttonStyle(running)}
        >
          open tab
        </button>
        <button
          type="button"
          disabled={locked || !running}
          onClick={() => setShowFrame((v) => !v)}
          style={buttonStyle(running)}
        >
          {showFrame ? 'hide frame' : 'show frame'}
        </button>
      </div>

      <div style={{ fontSize: 10, color: SLATE.muted, lineHeight: 1.45 }}>
        iframe source: <span style={{ color: AMBER[500] }}>{dashboardProxyUrl}</span>
        {matchedDashboardTheme && (
          <>
            {' · '}dashboard theme: <span style={{ color: AMBER[500] }}>{matchedDashboardTheme}</span>
          </>
        )}
      </div>

      {running && showFrame && (
        // Same-origin on purpose: this is the first-party Hermes config UI behind hermelinChat auth, not an untrusted artifact sandbox.
        <iframe
          key={frameNonce}
          title="Hermes Agent Dashboard"
          src={dashboardProxyUrl}
          style={{
            width: '100%',
            height: 'min(68vh, 720px)',
            minHeight: 520,
            border: `1px solid ${SLATE.border}`,
            borderRadius: 12,
            background: '#05070b',
          }}
        />
      )}
    </div>
  )
}
