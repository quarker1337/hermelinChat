import { AMBER, SLATE } from './store'

export { DEFAULT_THEME_ID, THEMES, THEME_OPTIONS, normalizeThemeId } from './themes'
export type { Theme, SlateColors, ThemeIcons, ThemeBackground } from './themes'
export { AMBER, SLATE, getActiveTheme, getActiveThemeId, setActiveThemeId } from './store'
export { hexToRgb } from './utils'

export function levelColor(level: unknown): string {
  const key = String(level || '').toUpperCase()
  if (key === 'ERROR' || key === 'ERR' || key === 'CRITICAL') return SLATE.danger
  if (key === 'WARN' || key === 'WARNING') return AMBER[400]
  if (key === 'DEBUG' || key === 'TRACE') return SLATE.muted
  return SLATE.text
}

export function semanticColor(value: unknown): string {
  const key = String(value || '').toLowerCase()
  if (key === 'danger' || key === 'error' || key === 'critical') return SLATE.danger
  if (key === 'success' || key === 'ok' || key === 'healthy') return SLATE.success
  if (key === 'warning' || key === 'warn') return AMBER[400]
  if (key === 'info') return SLATE.info
  return SLATE.text
}

export function formatTimeAgo(timestamp: unknown): string {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return 'unknown'
  const delta = Math.max(0, Math.round(Date.now() / 1000 - value))
  if (delta < 5) return 'just now'
  if (delta < 60) return `${delta}s ago`
  const minutes = Math.round(delta / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function formatTimestamp(timestamp: unknown): string {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  try {
    return new Date(value * 1000).toLocaleString()
  } catch {
    return ''
  }
}
