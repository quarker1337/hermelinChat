export const DEFAULT_THEME_ID = 'hermilin'

export const THEMES = {
  hermilin: {
    id: 'hermilin',
    label: 'Hermilin (amber)',
    AMBER: {
      300: '#ffd480',
      400: '#f5b731',
      500: '#e0a020',
      600: '#c48a18',
      700: '#9a6c12',
      800: '#6b4a0e',
      900: '#3d2a08',
    },
    SLATE: {
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
    },
  },

  matrix: {
    id: 'matrix',
    label: 'Matrix (emerald)',
    AMBER: {
      // Keep the token name AMBER for compatibility; in this theme it represents the accent scale.
      300: '#a7f3d0',
      400: '#34d399',
      500: '#10b981',
      600: '#059669',
      700: '#047857',
      800: '#065f46',
      900: '#064e3b',
    },
    SLATE: {
      bg: '#060a08',
      surface: '#0a120e',
      elevated: '#0f1a14',
      border: '#1a2a22',
      muted: '#4b5f57',
      text: '#b7d6c9',
      textBright: '#e6fff3',
      accent: '#34d399',
      danger: '#fb7185',
      success: '#34d399',
      info: '#60a5fa',
      purple: '#a78bfa',
      cyan: '#22d3ee',
    },
  },
}

export const THEME_OPTIONS = Object.values(THEMES).map((t) => ({ id: t.id, label: t.label }))

export function normalizeThemeId(raw) {
  const id = String(raw || '').trim()
  if (id && Object.prototype.hasOwnProperty.call(THEMES, id)) return id
  return DEFAULT_THEME_ID
}
