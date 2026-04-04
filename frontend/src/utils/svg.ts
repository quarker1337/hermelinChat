export function normalizeInlineSvg(svgRaw: unknown): string {
  const s = (svgRaw || '').toString()
  if (!s) return ''
  return s
    .replace('<svg ', '<svg width="100%" height="100%" style="display:block" ')
    .replace(/fill="black"/g, 'fill="currentColor"')
}

export function svgViewBoxAspect(svgRaw: unknown): number {
  const s = (svgRaw || '').toString()
  if (!s) return 1
  const m = s.match(/viewBox\s*=\s*"([^"]+)"/)
  if (!m) return 1
  const parts = m[1].trim().split(/[\s,]+/).map((v) => Number(v))
  if (parts.length !== 4) return 1
  const w = parts[2]
  const h = parts[3]
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) return 1
  return w / h
}
