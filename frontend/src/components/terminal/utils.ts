// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = new RegExp('\\u001b\\[[0-9;]*[a-zA-Z]', 'g')
// eslint-disable-next-line no-control-regex
const ANSI_OSC_RE = new RegExp('\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)', 'g')

export function stripAnsi(s: string): string {
  // Best-effort ANSI escape stripping for parsing session IDs from terminal output.
  // (We still render the raw bytes to xterm; this is only for metadata detection.)
  return (s || '').replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '')
}

export function buildWsUrl(
  resumeId: string | null,
  opts: { cols?: number; rows?: number; themeId?: string } = {},
): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams()

  if (resumeId) params.set('resume', resumeId)

  const cols = Number(opts?.cols || 0)
  const rows = Number(opts?.rows || 0)
  if (cols > 0) params.set('cols', String(cols))
  if (rows > 0) params.set('rows', String(rows))

  const themeId = String(opts?.themeId || '').trim()
  if (themeId) params.set('ui_theme', themeId)

  const q = params.toString()
  return `${proto}://${window.location.host}/ws/pty${q ? `?${q}` : ''}`
}
