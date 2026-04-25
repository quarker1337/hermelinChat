import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

// Theme module is still plain JS — will be properly typed when theme/ converts
// to TypeScript in Task 19.
import { THEMES, DEFAULT_THEME_ID, normalizeThemeId, setActiveThemeId } from '../theme/index'

import {
  loadUiPrefs,
  saveUiPrefs,
  normalizeUiPrefs,
  DEFAULT_UI_PREFS,
} from '../utils/ui-prefs'

import type { UiPrefs } from '../types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTheme = any

interface UiPrefsStore {
  prefs: UiPrefs
  activeTheme: AnyTheme
  effectiveBgKind: string
  appNameLabel: string
  update: (updater: UiPrefs | ((prev: UiPrefs) => UiPrefs)) => void
}

function resolveActiveTheme(themeId: string): AnyTheme {
  const id = normalizeThemeId(themeId)
  const themes = THEMES as Record<string, AnyTheme>
  return themes[id] || themes[DEFAULT_THEME_ID]
}

function resolveEffectiveBgKind(prefs: UiPrefs, activeTheme: AnyTheme): string {
  const bgEffectPref = prefs.background?.effect || 'auto'
  const themeBgKind = (activeTheme?.background?.kind || 'particles').toString()
  return bgEffectPref === 'auto' ? themeBgKind : bgEffectPref
}

function resolveAppNameLabel(prefs: UiPrefs): string {
  const s = (prefs.appName || '').toString().trim()
  return s || DEFAULT_UI_PREFS.appName
}

// Init: load prefs and set theme before store creation.
const _initPrefs = (() => {
  const prefs = loadUiPrefs()
  setActiveThemeId(prefs.theme)
  return prefs
})()

const _initTheme = resolveActiveTheme(_initPrefs.theme)

export const useUiPrefsStore = create<UiPrefsStore>()(
  subscribeWithSelector((set) => ({
    prefs: _initPrefs,
    activeTheme: _initTheme,
    effectiveBgKind: resolveEffectiveBgKind(_initPrefs, _initTheme),
    appNameLabel: resolveAppNameLabel(_initPrefs),

    update: (updater) => {
      set((state) => {
        const base = normalizeUiPrefs(state.prefs)
        const nextRaw = typeof updater === 'function' ? updater(base) : updater
        const next = normalizeUiPrefs(nextRaw)
        setActiveThemeId(next.theme)
        const activeTheme = resolveActiveTheme(next.theme)
        return {
          prefs: next,
          activeTheme,
          effectiveBgKind: resolveEffectiveBgKind(next, activeTheme),
          appNameLabel: resolveAppNameLabel(next),
        }
      })
    },
  })),
)

// ─── DOM helpers (title + favicon) ─────────────────────────────────────────

function applyTitle(appNameLabel: string) {
  if (typeof document === 'undefined') return
  try {
    document.title = appNameLabel
  } catch {
    // ignore
  }
}

function applyFavicons(activeTheme: AnyTheme) {
  if (typeof document === 'undefined') return

  try {
    const icons = activeTheme?.icons || {}
    const desired =
      Array.isArray(icons.favicons) && icons.favicons.length
        ? icons.favicons
        : [{ rel: 'icon', href: icons.faviconHref || '/favicon.svg' }]

    const entries = desired.filter(
      (e: unknown) => e && typeof e === 'object' && (e as Record<string, unknown>).href,
    )
    if (!entries.length) return

    // Remove any previous theme-managed icons.
    document.querySelectorAll('link[data-hermelin-theme-icon="1"]').forEach((el) => el.remove())

    const applyLink = (el: HTMLLinkElement, cfg: Record<string, string>) => {
      el.setAttribute('data-hermelin-theme-icon', '1')
      el.setAttribute('rel', cfg.rel || 'icon')
      if (cfg.type) el.setAttribute('type', cfg.type)
      else el.removeAttribute('type')
      if (cfg.sizes) el.setAttribute('sizes', cfg.sizes)
      else el.removeAttribute('sizes')
      el.setAttribute('href', cfg.href)
    }

    // Reuse the existing <link rel="icon"> from index.html (first load) if present.
    let base =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ||
      document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]') ||
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]')

    if (!base) {
      base = document.createElement('link')
      document.head.appendChild(base)
    }

    applyLink(base, entries[0])

    for (const cfg of entries.slice(1)) {
      const el = document.createElement('link')
      applyLink(el, cfg)
      document.head.appendChild(el)
    }
  } catch {
    // ignore
  }
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

// 1. Persist prefs to localStorage whenever they change.
useUiPrefsStore.subscribe(
  (s) => s.prefs,
  (prefs) => saveUiPrefs(prefs),
)

// 2. Update document.title when appNameLabel changes.
useUiPrefsStore.subscribe(
  (s) => s.appNameLabel,
  (appNameLabel) => applyTitle(appNameLabel),
)

// 3. Update favicon when activeTheme changes.
useUiPrefsStore.subscribe(
  (s) => s.activeTheme,
  (activeTheme) => applyFavicons(activeTheme),
)

// ─── Eager init ──────────────────────────────────────────────────────────────
// subscribe() only fires on *changes*, so on first page load the saved theme
// is already set in the store but the subscriptions never fire — leaving the
// browser showing the hardcoded index.html defaults. Apply eagerly.
applyTitle(useUiPrefsStore.getState().appNameLabel)
applyFavicons(_initTheme)
