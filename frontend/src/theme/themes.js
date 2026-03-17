import HERMELIN_NOT_FLIPPED_RAW from '../assets/hermelin-not-flipped.svg?raw'
import STOUT_MASCOT_RAW from '../assets/stout-mascot.svg?raw'
import MATRIX_SKULL_RAW from '../assets/matrix-skull.svg?raw'
import WHITE_RABBIT_RAW from '../assets/white-rabbit.svg?raw'
import NOUS_ALIGNMENT_RAW from '../assets/nous-alignment.svg?raw'
import NOUS_MARK_RAW from '../assets/nous-alignment-flipped.svg?raw'
import NOUS_MARK_URL from '../assets/nous-alignment-flipped.svg'

import SAMARITAN_MARK_RAW from '../assets/samaritan-mark.svg?raw'
import SAMARITAN_FAVICON_URL from '../assets/samaritan-favicon.svg'

export const DEFAULT_THEME_ID = 'hermelin'

export const THEMES = {
  hermelin: {
    id: 'hermelin',
    label: 'Hermelin (amber)',
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
    icons: {
      // Browser tab icon + small mark (used in headers).
      faviconHref: '/favicon.svg',

      // Topbar session mark.
      topbarSvgRaw: HERMELIN_NOT_FLIPPED_RAW,

      // Bottom-right easter egg.
      alignmentSvgRaw: STOUT_MASCOT_RAW,
      alignmentTitle: 'the stout knows…',
      alignmentWhisperText: 'aligned to you…',
      alignmentFetchWhisper: true,
    },
    background: {
      kind: 'particles',
      overlay: { kind: 'grain', opacity: 0.03 },
    },
  },

  matrix: {
    id: 'matrix',
    label: 'Matrix (rabbit)',
    AMBER: {
      // Keep the token name AMBER for compatibility; in this theme it represents the accent scale.
      300: '#b7ffd6',
      400: '#4dffa1',
      500: '#2da565',
      600: '#248a53',
      700: '#1a6b3f',
      800: '#114d2c',
      900: '#0a3019',
    },
    SLATE: {
      bg: '#0c0f0e',
      surface: '#111514',
      elevated: '#1a201f',
      border: '#2a3533',
      muted: '#5a6f6a',
      text: '#c8d8d3',
      textBright: '#e8f0ec',
      accent: '#4dffa1',
      danger: '#fb7185',
      success: '#4dffa1',
      info: '#60a5fa',
      purple: '#a78bfa',
      cyan: '#22d3ee',
      yellow: '#f5e642',
    },
    icons: {
      // Skull is great in the UI, but too thin for tiny favicons.
      // Use the dedicated Hans favicon assets instead.
      faviconHref: '/hans/hans-favicon.svg',
      favicons: [
        { rel: 'icon', type: 'image/svg+xml', sizes: 'any', href: '/hans/hans-favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/hans/favicon-32x32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/hans/favicon-16x16.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/hans/apple-touch-icon-180x180.png' },
      ],

      topbarSvgRaw: MATRIX_SKULL_RAW,
      topbarSize: 20,
      alignmentSvgRaw: WHITE_RABBIT_RAW,
      alignmentTitle: 'follow the white rabbit...',
      alignmentWhisperText: 'follow the white rabbit...',
      alignmentFetchWhisper: false,
    },
    background: {
      kind: 'matrix-rain',
      matrixRain: {
        colWidth: 14,
        fontSize: 12,
        fadeAlpha: 0.04,
        opacity: 0.3,

        // Throttle draws so the animation doesn't smear at low speeds.
        frameMs: 50,

        // Slower fall speed so the effect feels ambient, not distracting.
        // Units are roughly "cells per frame" scaled by dt/16 inside MatrixRainField.
        speedBase: 0.025,
        speedJitter: 0.03,

        // A little "glitch" red, per matrix_effect.js reference.
        redChance: 0.18,

        // When a column is past the bottom, chance per draw to reset back to the top.
        resetChance: 0.985,
      },
      overlay: { kind: 'scanlines', opacity: 0.06 },
    },
  },

  nous: {
    id: 'nous',
    label: 'Nous (aqua)',
    AMBER: {
      300: '#9ae1f2',
      400: '#5cc8e6',
      500: '#3aa8c8',
      600: '#2a88a8',
      700: '#1e6888',
      800: '#144868',
      900: '#0a2838',
    },
    SLATE: {
      bg: '#06181e',
      surface: '#0a2028',
      elevated: '#0e2830',
      border: '#1a3a44',
      muted: '#4a7a88',
      text: '#8acade',
      textBright: '#c0e8f4',
      accent: '#5cc8e6',
      danger: '#e84057',
      success: '#38c878',
      info: '#5cc8e6',
      purple: '#a78bfa',
      cyan: '#22d3ee',
    },
    icons: {
      faviconHref: NOUS_MARK_URL,
      topbarSvgRaw: NOUS_MARK_RAW,
      alignmentSvgRaw: NOUS_ALIGNMENT_RAW,
      alignmentTitle: 'nous research',
      alignmentWhisperText: 'aligned to nous…',
      alignmentFetchWhisper: true,
    },
    background: {
      kind: 'nous-crt',
      overlay: { kind: 'grain', opacity: 0.03 },
    },
  },

  samaritan: {
    id: 'samaritan',
    label: 'Samaritan (light)',
    AMBER: {
      // Keep the token name AMBER for compatibility; in this theme it represents the accent scale.
      300: '#e06666',
      400: '#cc3333',
      500: '#aa2020',
      600: '#881818',
      700: '#661212',
      800: '#440c0c',
      900: '#220606',
    },
    SLATE: {
      bg: '#e8e6e1',
      surface: '#dddbd6',
      elevated: '#d2d0cb',
      border: '#bab8b3',
      muted: '#7a7872',
      text: '#3a3835',
      textBright: '#1a1816',
      accent: '#cc3333',
      danger: '#aa2020',
      success: '#2da565',
      info: '#60a5fa',
      purple: '#a78bfa',
      cyan: '#22d3ee',
      yellow: '#cc3333',
    },
    icons: {
      faviconHref: SAMARITAN_FAVICON_URL,
      topbarSvgRaw: SAMARITAN_MARK_RAW,
      alignmentSvgRaw: SAMARITAN_MARK_RAW,
      alignmentTitle: 'samaritan',
      alignmentWhisperText: 'the machine sees you…',
      alignmentFetchWhisper: false,
    },
    background: {
      kind: 'samaritan',
      overlay: { kind: 'grain', opacity: 0.02 },
    },
  },
}

export const THEME_OPTIONS = Object.values(THEMES).map((t) => ({ id: t.id, label: t.label }))

export function normalizeThemeId(raw) {
  const id = String(raw || '').trim()
  if (id && Object.prototype.hasOwnProperty.call(THEMES, id)) return id
  return DEFAULT_THEME_ID
}
