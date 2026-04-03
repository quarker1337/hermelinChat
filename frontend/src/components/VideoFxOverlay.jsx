import { useEffect, useMemo, useState } from 'react'

import { AMBER, SLATE, hexToRgb } from '../theme/index'

function clampNum(n, min, max) {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

function frac(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return n - Math.floor(n)
}

export default function VideoFxOverlay({
  enabled = false,
  intensity = 65,
  glitchNow = false,
  glitchSeed = 0,
  zIndex = 999,
}) {
  const pct = clampNum(intensity, 0, 100)
  const f = enabled ? pct / 100 : 0

  const [blink, setBlink] = useState(false)

  // A tiny random "phosphor" blink, independent from glitch pulses.
  useEffect(() => {
    if (!enabled || f <= 0) return

    let cancelled = false
    let t = null

    const schedule = () => {
      if (cancelled) return
      const delay = 900 + Math.random() * 1400
      t = setTimeout(() => {
        if (cancelled) return
        setBlink(true)
        const hold = 20 + Math.random() * 40
        setTimeout(() => {
          if (!cancelled) setBlink(false)
        }, hold)
        schedule()
      }, delay)
    }

    schedule()
    return () => {
      cancelled = true
      if (t) clearTimeout(t)
    }
  }, [enabled, f])

  const accentHex = AMBER[400] || '#4dffa1'
  const accentRgb = hexToRgb(accentHex) || { r: 77, g: 255, b: 161 }

  const bgHex = SLATE.bg || '#08080a'
  const bgRgb = hexToRgb(bgHex) || { r: 8, g: 8, b: 10 }

  const scanStripe = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.12)`

  const scanlinesOpacity = clampNum(0.05 * f, 0, 0.12)
  const grainOpacity = clampNum(0.045 * f, 0, 0.12)
  const vignetteOpacity = clampNum(0.22 * f, 0, 0.5)
  const flickerOpacity = clampNum(0.03 * f, 0, 0.08)
  const scanbarOpacity = clampNum(0.05 * f, 0, 0.12)

  const glitchBoost = glitchNow ? clampNum(0.6 + 0.8 * f, 0, 1.6) : 1

  const overlayTransform = useMemo(() => {
    if (!enabled || f <= 0) return 'none'
    if (!glitchNow) return 'none'

    const r1 = frac(glitchSeed * 1.37 + 0.11)
    const r2 = frac(glitchSeed * 2.11 + 0.31)
    const r3 = frac(glitchSeed * 3.93 + 0.71)

    const jx = Math.round((r1 - 0.5) * 6 * f)
    const jy = Math.round((r2 - 0.5) * 4 * f)
    const skew = (r3 - 0.5) * 0.6 * f

    return `translate3d(${jx}px, ${jy}px, 0) skewX(${skew}deg)`
  }, [enabled, f, glitchNow, glitchSeed])

  const tearBars = useMemo(() => {
    if (!enabled || f <= 0 || !glitchNow) return []

    const r1 = frac(glitchSeed * 1.9 + 0.2)
    const r2 = frac(glitchSeed * 3.1 + 0.6)
    const r3 = frac(glitchSeed * 4.7 + 0.9)

    const bars = [
      { topPct: 12 + Math.round(r1 * 58), height: 10 + Math.round(r2 * 16), dx: Math.round((r3 - 0.5) * 22) },
      { topPct: 18 + Math.round(r2 * 60), height: 6 + Math.round(r3 * 14), dx: Math.round((r1 - 0.5) * 18) },
    ]

    return bars
  }, [enabled, f, glitchNow, glitchSeed])

  if (!enabled || f <= 0) return null

  return (
    <>
      <style>{`
        @keyframes videoFx_noiseShift {
          0% { background-position: 0 0; }
          25% { background-position: 10% 10%; }
          50% { background-position: -10% 15%; }
          75% { background-position: 6% -12%; }
          100% { background-position: 0 0; }
        }

        @keyframes videoFx_flicker {
          0% { opacity: 0.75; }
          5% { opacity: 0.92; }
          10% { opacity: 0.82; }
          15% { opacity: 0.96; }
          20% { opacity: 0.78; }
          100% { opacity: 0.85; }
        }

        @keyframes videoFx_scanbar {
          0% { transform: translateY(-30%); }
          100% { transform: translateY(130%); }
        }

        @keyframes videoFx_scanDrift {
          0% { background-position: 0 0; }
          100% { background-position: 0 18px; }
        }
      `}</style>

      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex,
          transform: overlayTransform,
          transformOrigin: '50% 50%',
        }}
      >
        {/* Vignette */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: vignetteOpacity,
            backgroundImage:
              `radial-gradient(circle at 50% 50%, rgba(${bgRgb.r},${bgRgb.g},${bgRgb.b},0) 58%, rgba(0,0,0,0.38) 100%)`,
            mixBlendMode: 'multiply',
          }}
        />

        {/* Scanlines */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: scanlinesOpacity * glitchBoost,
            mixBlendMode: 'overlay',
            backgroundImage: `repeating-linear-gradient(to bottom, ${scanStripe} 0, ${scanStripe} 1px, rgba(0,0,0,0) 4px, rgba(0,0,0,0) 7px)`,
            animation: 'videoFx_scanDrift 2.6s linear infinite',
          }}
        />

        {/* Grain */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: grainOpacity * glitchBoost,
            mixBlendMode: 'overlay',
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
            animation: `videoFx_noiseShift ${1.8 + 1.2 * (1 - f)}s steps(2, end) infinite`,
          }}
        />

        {/* Flicker */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: flickerOpacity * (blink ? 1.8 : 1) * glitchBoost,
            background: 'rgba(255,255,255,0.08)',
            mixBlendMode: 'overlay',
            animation: `videoFx_flicker ${3.2 + 2.0 * (1 - f)}s infinite`,
          }}
        />

        {/* Moving scan bar */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: '38%',
            opacity: scanbarOpacity * glitchBoost,
            mixBlendMode: 'screen',
            backgroundImage: `linear-gradient(to bottom, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0) 0%, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.18) 50%, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0) 100%)`,
            animation: `videoFx_scanbar ${7 + 5 * (1 - f)}s linear infinite`,
          }}
        />

        {/* Glitch tear bars (only during pulses) */}
        {tearBars.map((b, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${b.topPct}%`,
              height: b.height,
              transform: `translateX(${b.dx}px)`,
              opacity: 0.12 + 0.22 * f,
              mixBlendMode: 'screen',
              backgroundImage:
                `linear-gradient(to right, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0) 0%, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.28) 12%, rgba(255,255,255,0.08) 50%, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.22) 88%, rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0) 100%)`,
            }}
          />
        ))}
      </div>
    </>
  )
}
