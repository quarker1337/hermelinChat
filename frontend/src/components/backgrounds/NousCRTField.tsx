import { useEffect, useRef } from 'react'
import { AMBER, SLATE } from '../../theme/index.js'

function clampNum(n: unknown, min: number, max: number): number {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
}

interface NousCRTFieldProps {
  intensity?: number
}

export function NousCRTField({ intensity = 50 }: NousCRTFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const pct = clampNum(intensity, 0, 100)
  // 75 == "normal" intensity
  const factor = pct / 75
  const canvasOpacity = clampNum(0.9 * factor, 0, 1)

  const accentHex = AMBER[400] || '#5cc8e6'
  const accentRgb = hexToRgb(accentHex) || { r: 92, g: 200, b: 230 }

  const bgHex = SLATE.bg || '#06181e'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    if (prefersReducedMotion) return

    let animId: number
    let t = 0

    const f = clampNum(factor, 0, 2)

    const baseCount = 25
    const phosphorCount = Math.max(0, Math.round(baseCount * f))

    const phosphors = Array.from({ length: phosphorCount }, () => ({
      x: 0,
      y: 0,
      r: (Math.random() * 60 + 20) * clampNum(f, 0.7, 1.3),
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.003 + 0.001,
      maxOpacity: Math.min(0.08, (Math.random() * 0.04 + 0.01) * f),
    }))

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight
      for (const p of phosphors) {
        p.x = Math.random() * canvas.width
        p.y = Math.random() * canvas.height
      }
    }

    const draw = () => {
      const W = canvas.width
      const H = canvas.height

      // Base fill
      ctx.fillStyle = bgHex
      ctx.fillRect(0, 0, W, H)

      // Phosphor glow patches
      for (const p of phosphors) {
        const pulse = (Math.sin(t * p.speed + p.phase) + 1) * 0.5
        const opacity = p.maxOpacity * pulse
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
        g.addColorStop(0, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${opacity})`)
        g.addColorStop(1, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0)`)
        ctx.fillStyle = g
        ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2)
      }

      // Heavy scanlines
      const scanAlpha = 0.12 * f
      if (scanAlpha > 0.001) {
        ctx.fillStyle = `rgba(0,0,0,${scanAlpha})`
        for (let y = 0; y < H; y += 2) {
          ctx.fillRect(0, y, W, 1)
        }
      }

      // Vertical sub-pixel columns
      const colAlpha = 0.02 * f
      if (colAlpha > 0.001) {
        ctx.fillStyle = `rgba(0,0,0,${colAlpha})`
        for (let x = 0; x < W; x += 3) {
          ctx.fillRect(x, 0, 1, H)
        }
      }

      // Screen curvature vignette
      const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.15, W / 2, H / 2, W * 0.65)
      vig.addColorStop(0, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${0.02 * f})`)
      vig.addColorStop(0.6, 'rgba(0,0,0,0)')
      vig.addColorStop(1, `rgba(0,0,0,${0.35 * Math.min(1, f)})`)
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Rolling interference bar
      const rollY = ((t * 0.3) % (H + 120)) - 60
      ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${0.015 * f})`
      ctx.fillRect(0, rollY, W, 40)
      ctx.fillStyle = `rgba(0,0,0,${0.03 * f})`
      ctx.fillRect(0, rollY + 40, W, 20)

      // Whole-screen flicker removed (too distracting)

      // Occasional horizontal glitch line
      if (Math.random() < 0.01 * f) {
        const gy = Math.random() * H
        const a = Math.random() * 0.08 * f + 0.02 * f
        ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${a})`
        ctx.fillRect(0, gy, W, 1 + Math.random() * 2)
      }

      // Corner shadows for CRT bezel feel
      const corners: [number, number][] = [
        [0, 0],
        [W, 0],
        [0, H],
        [W, H],
      ]

      const cornerAlpha = 0.25 * Math.min(1, f)
      for (const [cx, cy] of corners) {
        const c = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.35)
        c.addColorStop(0, `rgba(0,0,0,${cornerAlpha})`)
        c.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = c
        const rx = cx === 0 ? 0 : W * 0.6
        const ry = cy === 0 ? 0 : H * 0.6
        ctx.fillRect(rx, ry, W * 0.4, H * 0.4)
      }

      t++
      animId = requestAnimationFrame(draw)
    }

    init()
    window.addEventListener('resize', init)
    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
    }
  }, [factor, accentRgb.r, accentRgb.g, accentRgb.b, bgHex])

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
