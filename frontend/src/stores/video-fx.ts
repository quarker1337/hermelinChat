import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { useUiPrefsStore } from './ui-prefs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VideoFxStore {
  // State
  enabled: boolean
  factor: number       // 0-1 (intensity / 100)
  glitchNow: boolean
  glitchSeed: number
  filter: string       // computed CSS filter string
  transform: string    // computed CSS transform string

  // Actions
  startGlitchLoop: () => void
  stopGlitchLoop: () => void
  recompute: () => void
}

// ---------------------------------------------------------------------------
// Module-level timer refs (not inside store state)
// ---------------------------------------------------------------------------

let _loopTimer: ReturnType<typeof setTimeout> | null = null
let _offTimer: ReturnType<typeof setTimeout> | null = null
let _loopCancelled = false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeFilter(enabled: boolean, factor: number, glitchNow: boolean): string {
  if (!enabled || factor <= 0) return 'none'

  const f = factor
  const contrast = 1 + 0.16 * f + (glitchNow ? 0.08 * f : 0)
  const saturate = 1 + 0.22 * f + (glitchNow ? 0.14 * f : 0)
  const brightness = 1 + 0.06 * f

  const dx = 0.6 + 1.1 * f
  const a1 = 0.06 + 0.10 * f
  const a2 = 0.05 + 0.08 * f

  let s = `contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)}) brightness(${brightness.toFixed(3)})`
  s += ` drop-shadow(${dx.toFixed(2)}px 0 0 rgba(255,50,120,${a1.toFixed(3)}))`
  s += ` drop-shadow(${(-dx).toFixed(2)}px 0 0 rgba(0,220,255,${a2.toFixed(3)}))`

  if (glitchNow) {
    s += ` hue-rotate(${(3 + 7 * f).toFixed(1)}deg)`
  }

  return s
}

function computeTransform(enabled: boolean, factor: number, glitchNow: boolean, glitchSeed: number): string {
  if (!enabled || factor <= 0) return 'none'
  if (!glitchNow) return 'translateZ(0)'

  const seed = Number(glitchSeed || 0)
  const frac = (x: number) => x - Math.floor(x)

  const r1 = frac(seed * 1.37 + 0.11)
  const r2 = frac(seed * 2.11 + 0.31)
  const r3 = frac(seed * 3.93 + 0.71)

  const jx = Math.round((r1 - 0.5) * 10 * factor)
  const jy = Math.round((r2 - 0.5) * 6 * factor)
  const skew = (r3 - 0.5) * 0.9 * factor

  return `translate3d(${jx}px, ${jy}px, 0) skewX(${skew}deg)`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useVideoFxStore = create<VideoFxStore>()(
  subscribeWithSelector((set, get) => ({
    enabled: false,
    factor: 0,
    glitchNow: false,
    glitchSeed: 0,
    filter: 'none',
    transform: 'none',

    recompute: () => {
      const prefs = useUiPrefsStore.getState().prefs
      const vxPrefs = prefs.videoFx || { enabled: false, intensity: 65, glitchPulses: true }

      const intensity = Math.min(100, Math.max(0, Number(vxPrefs.intensity ?? 65)))
      const enabled = !!vxPrefs.enabled && intensity > 0
      const factor = enabled ? intensity / 100 : 0

      const { glitchNow, glitchSeed } = get()

      set({
        enabled,
        factor,
        filter: computeFilter(enabled, factor, glitchNow),
        transform: computeTransform(enabled, factor, glitchNow, glitchSeed),
      })
    },

    startGlitchLoop: () => {
      _loopCancelled = false

      const schedule = () => {
        if (_loopCancelled) return

        const { factor } = get()

        // Higher intensity => slightly more frequent pulses.
        const minDelay = Math.max(650, 2200 - 1200 * factor)
        const maxDelay = Math.max(minDelay + 250, 4600 - 2600 * factor)
        const delay = minDelay + Math.random() * (maxDelay - minDelay)

        _loopTimer = setTimeout(() => {
          if (_loopCancelled) return

          if (_offTimer) {
            clearTimeout(_offTimer)
            _offTimer = null
          }

          const glitchSeed = Math.random() * 10000
          const { enabled, factor: f } = get()

          set({
            glitchSeed,
            glitchNow: true,
            filter: computeFilter(enabled, f, true),
            transform: computeTransform(enabled, f, true, glitchSeed),
          })

          const dur = 60 + Math.random() * (120 + 140 * f)
          _offTimer = setTimeout(() => {
            if (!_loopCancelled) {
              const { enabled: en, factor: fa, glitchSeed: gs } = get()
              set({
                glitchNow: false,
                filter: computeFilter(en, fa, false),
                transform: computeTransform(en, fa, false, gs),
              })
            }
          }, dur)

          schedule()
        }, delay)
      }

      schedule()
    },

    stopGlitchLoop: () => {
      _loopCancelled = true
      if (_loopTimer) { clearTimeout(_loopTimer); _loopTimer = null }
      if (_offTimer) { clearTimeout(_offTimer); _offTimer = null }

      const { enabled, factor, glitchSeed } = get()
      set({
        glitchNow: false,
        filter: computeFilter(enabled, factor, false),
        transform: computeTransform(enabled, factor, false, glitchSeed),
      })
    },
  }))
)

// ---------------------------------------------------------------------------
// Subscribe to ui-prefs changes to sync enabled/factor and start/stop loop
// ---------------------------------------------------------------------------

function syncVideoFxFromPrefs() {
  const store = useVideoFxStore.getState()
  store.recompute()

  const prefs = useUiPrefsStore.getState().prefs
  const vxPrefs = prefs.videoFx || { enabled: false, intensity: 65, glitchPulses: true }
  const intensity = Math.min(100, Math.max(0, Number(vxPrefs.intensity ?? 65)))
  const enabled = !!vxPrefs.enabled && intensity > 0
  const glitchPulses = enabled && !!vxPrefs.glitchPulses

  if (glitchPulses) {
    store.stopGlitchLoop()
    store.startGlitchLoop()
  } else {
    store.stopGlitchLoop()
  }
}

useUiPrefsStore.subscribe(
  (s) => s.prefs.videoFx,
  () => {
    syncVideoFxFromPrefs()
  }
)

syncVideoFxFromPrefs()
