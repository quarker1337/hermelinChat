import { useCallback, useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// TopbarSprite — animated spritesheet for the topbar icon
//
// Blink animation: loops continuously like the easter egg (eyes-open most of
// the time, brief blink cycle). Same CSS keyframe approach as nousBlink.
//
// Vibe animation: fires randomly on a timer. When triggered, the vibe sheet
// replaces the blink sheet for one full play-through, then snaps back.
// ---------------------------------------------------------------------------

interface TopbarSpriteProps {
  /** Blink spritesheet URL (4 frames: open, half, closed, half) */
  blinkHref: string
  /** Vibe spritesheet URL (8 frames) */
  vibeHref?: string
  /** Frames in the blink sheet (default 4) */
  blinkFrames?: number
  /** Frames in the vibe sheet (default 8) */
  vibeFrames?: number
  /** Per-frame width in px (default 64) */
  frameWidth?: number
  /** Per-frame height in px (default 64) */
  frameHeight?: number
  /** Display width (default frameWidth) */
  width?: number
  /** Display height (default frameHeight) */
  height?: number
  /** Probability of vibing on each check (0–1, default 0.12) */
  vibeChance?: number
  /** Interval between vibe checks in ms (default 8000) */
  vibeIntervalMs?: number
  /** Pause all animation */
  paused?: boolean
  /** Tint overlay color */
  tintColor?: string
  /** Tint overlay opacity (default 0.25) */
  tintOpacity?: number
  title?: string
}

export const TopbarSprite = ({
  blinkHref,
  vibeHref,
  blinkFrames = 4,
  vibeFrames = 8,
  frameWidth = 64,
  frameHeight = 64,
  width,
  height,
  vibeChance = 0.25,
  vibeIntervalMs = 5000,
  paused = false,
  tintColor,
  tintOpacity = 0.25,
  title,
}: TopbarSpriteProps) => {
  const [vibing, setVibing] = useState(false)
  const vibingRef = useRef(false)

  // Keep ref in sync so the scheduler can read current state without re-running
  useEffect(() => { vibingRef.current = vibing }, [vibing])

  const sw = width ?? frameWidth
  const sh = height ?? frameHeight

  // Random vibe trigger — uses setInterval so it doesn't break on re-renders
  useEffect(() => {
    if (paused || !vibeHref) return

    const check = () => {
      // Don't trigger if already vibing
      if (vibingRef.current) return
      if (Math.random() < vibeChance) {
        setVibing(true)
      }
    }

    // First check after a short delay so it feels alive early on
    const firstTimeout = setTimeout(check, 2000)
    const interval = setInterval(check, vibeIntervalMs)

    return () => {
      clearTimeout(firstTimeout)
      clearInterval(interval)
    }
  }, [paused, vibeHref, vibeChance, vibeIntervalMs])

  // When vibing starts, set a timer to end it after one full cycle
  // Vibe animation: 8 frames at ~120ms each ≈ 960ms
  const vibeDuration = vibeFrames * 120
  useEffect(() => {
    if (!vibing) return
    const t = setTimeout(() => setVibing(false), vibeDuration)
    return () => clearTimeout(t)
  }, [vibing, vibeDuration])

  // Keyframe names — use unique-enough names to avoid collisions
  const blinkKf = 'topbarNousBlink'
  const vibeKf = 'topbarNousVibe'

  // Active spritesheet
  const activeHref = vibing ? vibeHref! : blinkHref
  const activeFrames = vibing ? vibeFrames : blinkFrames

  // Animation style: blink loops, vibe plays once
  const animName = vibing ? vibeKf : blinkKf
  const animDuration = vibing ? `${vibeDuration}ms` : '4000ms'
  const animIter = vibing ? '1' : 'infinite'
  const animFill = vibing ? 'forwards' : 'none'

  // Build keyframe strings
  const blinkKfCss = buildStepKeyframes(blinkKf, blinkFrames, frameWidth)
  const vibeKfCss = vibeHref ? buildStepKeyframes(vibeKf, vibeFrames, frameWidth) : ''

  const maskImage = `url(${activeHref})`

  return (
    <>
      <style>{blinkKfCss}</style>
      {vibeKfCss ? <style>{vibeKfCss}</style> : null}
      <span
        style={{
          position: 'relative',
          display: 'inline-block',
          width: sw,
          height: sh,
          flexShrink: 0,
          lineHeight: 0,
        }}
        title={title || undefined}
      >
        <div
          style={{
            width: sw,
            height: sh,
            backgroundImage: `url(${activeHref})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${frameWidth * activeFrames}px ${frameHeight}px`,
            imageRendering: 'pixelated',
            animation: paused ? 'none' : `${animName} ${animDuration} steps(1) ${animIter} ${animFill}`,
          }}
        />
        {tintColor ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background: tintColor,
              opacity: tintOpacity,
              mixBlendMode: 'color',
              pointerEvents: 'none',
              WebkitMaskImage: maskImage,
              maskImage,
              WebkitMaskSize: '100% 100%',
              maskSize: '100% 100%',
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
            }}
          />
        ) : null}
      </span>
    </>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a CSS @keyframes string for a horizontal spritesheet using steps(1).
 * Each frame is a background-position shift of -frameWidth * i.
 *
 * For a 4-frame blink: open(85%) → half(88%) → closed(91%) → half(94%) → open(97%)
 * For an 8-frame vibe: evenly spaced, play once through.
 */
function buildStepKeyframes(name: string, frames: number, frameWidth: number): string {
  if (frames <= 1) return ''

  const isBlink = name.toLowerCase().includes('blink')

  const steps: string[] = []
  if (isBlink) {
    // Blink pattern: stay on open frame most of the time, quick blink cycle
    // 0-85%: open (frame 0)
    // 88%: half-closed (frame 1)
    // 91%: closed (frame 2)
    // 94%: half-open (frame 3)
    // 97-100%: open (frame 0)
    const positions = [85, 88, 91, 94, 97, 100]
    const frameIdx = [0, 1, 2, 3, 0, 0]
    for (let i = 0; i < positions.length; i++) {
      steps.push(`  ${positions[i]}% { background-position: -${frameWidth * frameIdx[i]}px 0; }`)
    }
  } else {
    // Vibe: even steps, play through all frames sequentially
    const pctStep = 100 / frames
    for (let i = 0; i < frames; i++) {
      const from = Math.round(i * pctStep)
      const to = Math.round((i + 1) * pctStep)
      // First frame starts at 0%
      if (i === 0) {
        steps.push(`  ${from}% { background-position: -${frameWidth * i}px 0; }`)
      } else {
        steps.push(`  ${from}% { background-position: -${frameWidth * i}px 0; }`)
      }
      // Last frame also covers to 100%
      if (i === frames - 1) {
        steps.push(`  100% { background-position: -${frameWidth * i}px 0; }`)
      }
    }
  }

  return `@keyframes ${name} {\n${steps.join('\n')}\n}`
}
