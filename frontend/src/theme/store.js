import { DEFAULT_THEME_ID, THEMES, normalizeThemeId } from './themes.js'

let _activeThemeId = DEFAULT_THEME_ID
let _activeTheme = THEMES[_activeThemeId]

export function getActiveThemeId() {
  return _activeThemeId
}

export function getActiveTheme() {
  return _activeTheme
}

export function setActiveThemeId(raw) {
  const nextId = normalizeThemeId(raw)
  _activeThemeId = nextId
  _activeTheme = THEMES[nextId]
  return _activeThemeId
}

export const AMBER = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === Symbol.toStringTag) return 'AMBER'
      const key = String(prop)
      return _activeTheme?.AMBER?.[key]
    },
  },
)

export const SLATE = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === Symbol.toStringTag) return 'SLATE'
      const key = String(prop)
      return _activeTheme?.SLATE?.[key]
    },
  },
)
