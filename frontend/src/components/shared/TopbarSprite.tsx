import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// TopbarSprite — animated spritesheet for the topbar icon
//
// Blink animation: loops continuously like the easter egg (eyes-open most of
// the time, brief blink cycle). Same CSS keyframe approach as nousBlink.
// ---------------------------------------------------------------------------

interface TopbarSpriteProps {
  /** Blink spritesheet URL (4 frames: open, half, closed, half) */
  blinkHref: string
  /** Frames in the blink sheet (default 4) */
  blinkFrames?: number
  /** Per-frame width in px (default 64) */
  frameWidth?: number
  /** Per-frame height in px (default 64) */
  frameHeight?: number
  /** Display width (default frameWidth) */
  width?: number
  /** Display height (default frameHeight) */
  height?: number
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
  blinkFrames = 4,
  frameWidth = 64,
  frameHeight = 64,
  width,
  height,
  paused = false,
  tintColor,
  tintOpacity = 0.25,
  title,
}: TopbarSpriteProps) => {
  const sw = width ?? frameWidth
  const sh = height ?? frameHeight

  // Keyframe name
  const blinkKf = 'topbarNousBlink'

  // Build keyframe string
  const blinkKfCss = buildBlinkKeyframes(blinkKf, blinkFrames, frameWidth)

  const maskImage = `url(${blinkHref})`

  return (
    <>
      <style>{blinkKfCss}</style>
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
            backgroundImage: `url(${blinkHref})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: `${frameWidth * blinkFrames}px ${frameHeight}px`,
            imageRendering: 'pixelated',
            animation: paused ? 'none' : `${blinkKf} 4000ms steps(1) infinite`,
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
 * Build a CSS @keyframes string for a blink spritesheet using steps(1).
 * Stay on open frame most of the time, quick blink cycle:
 *   0-85%: open (frame 0)
 *   88%: half-closed (frame 1)
 *   91%: closed (frame 2)
 *   94%: half-open (frame 3)
 *   97-100%: open (frame 0)
 */
function buildBlinkKeyframes(name: string, frames: number, frameWidth: number): string {
  if (frames <= 1) return ''

  const positions = [85, 88, 91, 94, 97, 100]
  const frameIdx = [0, 1, 2, 3, 0, 0]
  const steps: string[] = []
  for (let i = 0; i < positions.length; i++) {
    steps.push(`  ${positions[i]}% { background-position: -${frameWidth * frameIdx[i]}px 0; }`)
  }

  return `@keyframes ${name} {\n${steps.join('\n')}\n}`
}
