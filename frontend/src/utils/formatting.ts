export function formatModelLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return null

    // Sometimes the backend leaks a dict-ish string here (e.g.
    // "{'default': 'z-ai/glm-5', 'provider': 'openrouter'}").
    // Try to extract a real model id for display.
    const mDefault = s.match(/['"]default['"]\s*:\s*['"]([^'"]+)['"]/)
    if (mDefault && mDefault[1]) return mDefault[1].trim() || s

    const mModel = s.match(/['"]model['"]\s*:\s*['"]([^'"]+)['"]/)
    if (mModel && mModel[1]) return mModel[1].trim() || s

    // YAML-ish mapping (no quotes): "{default: z-ai/glm-5, provider: openrouter}"
    const mYamlDefault = s.match(/\bdefault\s*:\s*([^,}]+)/)
    if (mYamlDefault && mYamlDefault[1]) {
      const v = mYamlDefault[1].trim().replace(/^['"]|['"]$/g, '')
      return v || s
    }

    return s
  }

  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const v = o.default ?? o.model ?? o.value ?? o.id ?? o.name
    if (typeof v === 'string') {
      const s = v.trim()
      return s || null
    }
    return null
  }

  return String(raw)
}

export function isoToLocalLabel(iso: string | number | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

export function isoToTimeLabel(iso: string | number | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function isoToRelativeLabel(iso: string | number | null | undefined): string {
  if (!iso) return ''
  try {
    const ts = new Date(iso).getTime()
    if (!Number.isFinite(ts)) return ''

    const now = new Date()
    const date = new Date(ts)
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour
    const diffMs = Math.max(0, now.getTime() - ts)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const dayDiff = Math.floor((startOfToday - startOfThatDay) / day)

    if (dayDiff <= 0) {
      if (diffMs < minute) return 'just now'
      if (diffMs < hour) {
        const mins = Math.max(1, Math.floor(diffMs / minute))
        return `${mins} min${mins === 1 ? '' : 's'} ago`
      }
      const hours = Math.max(1, Math.floor(diffMs / hour))
      return `${hours} hr${hours === 1 ? '' : 's'} ago`
    }

    if (dayDiff === 1) return 'Yesterday'
    if (dayDiff < 7) return `${dayDiff} day${dayDiff === 1 ? '' : 's'} ago`

    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    })
  } catch {
    return ''
  }
}
