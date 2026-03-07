export const AMBER = {
  300: '#ffd480',
  400: '#f5b731',
  500: '#e0a020',
  600: '#c48a18',
  700: '#9a6c12',
  800: '#6b4a0e',
  900: '#3d2a08',
}

export const SLATE = {
  bg: '#08080a',
  surface: '#0e0e12',
  elevated: '#16161d',
  border: '#232330',
  muted: '#55556a',
  text: '#b8b8cc',
  textBright: '#e8e8f0',
  accent: '#f5b731',
  danger: '#e84057',
  success: '#38c878',
  info: '#60a5fa',
  purple: '#a78bfa',
  cyan: '#22d3ee',
}

export function levelColor(level) {
  const key = String(level || '').toUpperCase()
  if (key === 'ERROR' || key === 'ERR' || key === 'CRITICAL') return SLATE.danger
  if (key === 'WARN' || key === 'WARNING') return AMBER[400]
  if (key === 'DEBUG' || key === 'TRACE') return SLATE.muted
  return SLATE.text
}

export function semanticColor(value) {
  const key = String(value || '').toLowerCase()
  if (key === 'danger' || key === 'error' || key === 'critical') return SLATE.danger
  if (key === 'success' || key === 'ok' || key === 'healthy') return SLATE.success
  if (key === 'warning' || key === 'warn') return AMBER[400]
  if (key === 'info') return SLATE.info
  return SLATE.text
}

export function formatTimeAgo(timestamp) {
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

export function formatTimestamp(timestamp) {
  const value = Number(timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  try {
    return new Date(value * 1000).toLocaleString()
  } catch {
    return ''
  }
}
