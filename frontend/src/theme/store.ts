import { DEFAULT_THEME_ID, THEMES, normalizeThemeId, Theme } from './themes'

let _activeThemeId: string = DEFAULT_THEME_ID
let _activeTheme: Theme = THEMES[_activeThemeId]

export function getActiveThemeId(): string {
  return _activeThemeId
}

export function getActiveTheme(): Theme {
  return _activeTheme
}

export function setActiveThemeId(raw: unknown): string {
  const nextId = normalizeThemeId(raw)
  _activeThemeId = nextId
  _activeTheme = THEMES[nextId]
  return _activeThemeId
}

export const AMBER: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop) {
      if (prop === Symbol.toStringTag) return 'AMBER'
      const key = String(prop)
      return _activeTheme?.AMBER?.[key]
    },
  },
)

export const SLATE: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop) {
      if (prop === Symbol.toStringTag) return 'SLATE'
      const key = String(prop)
      return _activeTheme?.SLATE?.[key]
    },
  },
)
