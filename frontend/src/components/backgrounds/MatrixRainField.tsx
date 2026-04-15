import { useEffect, useRef } from 'react'
import { AMBER, SLATE } from '../../theme/index'

function clampNum(n: unknown, min: number, max: number): number {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
}

interface MatrixRainFieldProps {
  intensity?: number
  config?: unknown
}

export function MatrixRainField({ intensity = 50, config }: MatrixRainFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const pct = clampNum(intensity, 0, 100)
  // 75 == "normal" intensity
  const factor = pct / 75

  const cfg = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}

  const colWidth = clampNum(cfg.colWidth ?? 14, 8, 32)
  const fontSize = clampNum(cfg.fontSize ?? 12, 8, 24)
  const fadeAlpha = clampNum(cfg.fadeAlpha ?? 0.04, 0.01, 0.2)
  const baseOpacity = clampNum(cfg.opacity ?? 0.3, 0, 1)
  const canvasOpacity = clampNum(baseOpacity * factor, 0, 1)

  const speedBase = clampNum(cfg.speedBase ?? 0.04, 0.01, 5)
  const speedJitter = clampNum(cfg.speedJitter ?? 0.05, 0, 5)

  // Optional throttling + palette tweaks for the matrix-rain effect
  const frameMs = clampNum(cfg.frameMs ?? 50, 0, 250)
  const redChance = clampNum(cfg.redChance ?? 0, 0, 1)
  // When a drop is past the bottom, chance (per draw) to reset it back to the top.
  const resetChance = clampNum(cfg.resetChance ?? 0.98, 0, 1)

  const redBrightHex = (cfg.redBright as string) ?? '#ff4d4d'
  const redMidHex = (cfg.redMid as string) ?? '#cc2a2a'
  const redDimHex = (cfg.redDim as string) ?? '#7a1616'

  const redBright = hexToRgb(redBrightHex) || { r: 255, g: 77, b: 77 }
  const redMid = hexToRgb(redMidHex) || redBright
  const redDim = hexToRgb(redDimHex) || redMid

  const brightHex = AMBER[400] || '#4dffa1'
  const midHex = AMBER[500] || brightHex
  const dimHex = AMBER[700] || midHex

  const bright = hexToRgb(brightHex) || { r: 77, g: 255, b: 161 }
  const mid = hexToRgb(midHex) || bright
  const dim = hexToRgb(dimHex) || mid

  const bgHex = SLATE.bg || '#0c0f0e'
  const bgRgb = hexToRgb(bgHex) || { r: 12, g: 15, b: 14 }

  const chars =
    'アウエオカキクケコサシスセソタチツテトナニネノハヒフヘホマミムメモヤユヨラリルレロワン01234589ABCDEF'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    if (prefersReducedMotion) return

    let animId: number
    let drops: number[] = []
    let columns = 0
    let lastDraw = 0

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800
      canvas.height = canvas.parentElement?.offsetHeight || 600

      columns = Math.max(1, Math.floor(canvas.width / colWidth))
      drops = Array(columns)
        .fill(0)
        .map(() => Math.random() * -80)

      ctx.font = `${fontSize}px monospace`
      ctx.textBaseline = 'top'
    }

    const draw = (ts: number) => {
      animId = requestAnimationFrame(draw)

      // Throttle draws (prevents smear when speed is low).
      if (frameMs > 0 && lastDraw && ts - lastDraw < frameMs) return

      const dt = lastDraw ? Math.min(200, ts - lastDraw) : 16
      lastDraw = ts

      // Fade to background (creates trails).
      ctx.fillStyle = `rgba(${bgRgb.r},${bgRgb.g},${bgRgb.b},${fadeAlpha})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      const step = (dt / 16) * factor

      for (let i = 0; i < drops.length; i++) {
        const c = chars[Math.floor(Math.random() * chars.length)]
        const b = Math.random()
        const isRed = redChance > 0 && Math.random() < redChance

        if (isRed) {
          if (b > 0.96) {
            ctx.fillStyle = `rgba(${redBright.r},${redBright.g},${redBright.b},0.5)`
          } else if (b > 0.85) {
            ctx.fillStyle = `rgba(${redMid.r},${redMid.g},${redMid.b},0.18)`
          } else {
            ctx.fillStyle = `rgba(${redDim.r},${redDim.g},${redDim.b},0.08)`
          }
        } else {
          if (b > 0.96) {
            ctx.fillStyle = `rgba(${bright.r},${bright.g},${bright.b},0.5)`
          } else if (b > 0.85) {
            ctx.fillStyle = `rgba(${mid.r},${mid.g},${mid.b},0.18)`
          } else {
            ctx.fillStyle = `rgba(${dim.r},${dim.g},${dim.b},0.08)`
          }
        }

        const x = i * colWidth
        const y = drops[i] * colWidth

        ctx.fillText(c, x, y)

        if (y > canvas.height && Math.random() > resetChance) {
          drops[i] = 0
        } else {
          drops[i] += (speedBase + Math.random() * speedJitter) * step
        }
      }
    }

    init()
    window.addEventListener('resize', init)

    // Pause when tab is hidden
    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(animId)
        animId = 0
      } else if (!animId) {
        lastDraw = 0
        animId = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [
    colWidth,
    fontSize,
    fadeAlpha,
    factor,
    speedBase,
    speedJitter,
    frameMs,
    redChance,
    resetChance,

    redBrightHex,
    redBright.r,
    redBright.g,
    redBright.b,

    redMidHex,
    redMid.r,
    redMid.g,
    redMid.b,

    redDimHex,
    redDim.r,
    redDim.g,
    redDim.b,

    brightHex,
    bright.r,
    bright.g,
    bright.b,

    midHex,
    mid.r,
    mid.g,
    mid.b,

    dimHex,
    dim.r,
    dim.g,
    dim.b,

    bgHex,
    bgRgb.r,
    bgRgb.g,
    bgRgb.b,
  ])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity: canvasOpacity,
        zIndex: 0,
      }}
    />
  )
}
