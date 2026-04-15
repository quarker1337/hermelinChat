import { useEffect, useRef, useState } from 'react'
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

interface NousCRTFieldProps {
  intensity?: number
  paused?: boolean
}

export function NousCRTField({ intensity = 50, paused = false }: NousCRTFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  const resumeFnRef = useRef<(() => void) | null>(null)
  pausedRef.current = paused

  // Snapshot: flatten canvas to static image when paused — trivial for blur
  const [snapshot, setSnapshot] = useState<string | null>(null)

  useEffect(() => {
    if (paused && canvasRef.current) {
      try { setSnapshot(canvasRef.current.toDataURL('image/jpeg', 0.7)) } catch { setSnapshot(null) }
    } else {
      setSnapshot(null)
    }
  }, [paused])

  const pct = clampNum(intensity, 0, 100)
  const factor = pct / 75
  const canvasOpacity = clampNum(0.92 * factor, 0, 1)

  const bgHex = SLATE.bg || '#0e1028'
  const borderHex = SLATE.border || '#2e3860'
  const textHex = SLATE.text || '#a0b0d0'
  const accentHex = AMBER[400] || SLATE.accent || '#88b8f0'
  const accentSoftHex = AMBER[600] || '#5888c0'
  const yellowHex = SLATE.yellow || '#e0c868'

  const bgRgb = hexToRgb(bgHex) || { r: 14, g: 16, b: 40 }
  const borderRgb = hexToRgb(borderHex) || { r: 46, g: 56, b: 96 }
  const textRgb = hexToRgb(textHex) || { r: 160, g: 176, b: 208 }
  const accentRgb = hexToRgb(accentHex) || { r: 136, g: 184, b: 240 }
  const accentSoftRgb = hexToRgb(accentSoftHex) || { r: 88, g: 136, b: 192 }
  const yellowRgb = hexToRgb(yellowHex) || { r: 224, g: 200, b: 104 }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    let animId = 0
    let tick = 0

    const f = clampNum(factor, 0, 2)
    const gridSize = 16
    const quant = 4

    const palette = [accentRgb, accentSoftRgb, yellowRgb, textRgb]
    const particleCount = Math.max(6, Math.round(14 * Math.max(0.35, f)))
    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random(),
      y: Math.random(),
      size: Math.random() * 2 + 1,
      speed: Math.random() * 0.00035 + 0.00008,
      drift: Math.random() * 0.0002 - 0.0001,
      phase: Math.random() * Math.PI * 2,
      opacity: Math.random() * 0.22 + 0.08,
      color: palette[Math.floor(Math.random() * palette.length)],
    }))

    let staticLayer: HTMLCanvasElement | null = null
    let backdropLayer: HTMLCanvasElement | null = null

    const initStaticLayer = (W: number, H: number) => {
      staticLayer = document.createElement('canvas')
      staticLayer.width = W
      staticLayer.height = H
      const sCtx = staticLayer.getContext('2d')!

      sCtx.strokeStyle = `rgba(${borderRgb.r},${borderRgb.g},${borderRgb.b},${(0.22 * Math.min(1, f)).toFixed(4)})`
      sCtx.lineWidth = 1
      for (let x = 0; x < W; x += gridSize) {
        sCtx.beginPath(); sCtx.moveTo(x + 0.5, 0); sCtx.lineTo(x + 0.5, H); sCtx.stroke()
      }
      for (let y = 0; y < H; y += gridSize) {
        sCtx.beginPath(); sCtx.moveTo(0, y + 0.5); sCtx.lineTo(W, y + 0.5); sCtx.stroke()
      }

      const scanAlpha = 0.035 * Math.min(1.15, f)
      if (scanAlpha > 0.001) {
        sCtx.fillStyle = `rgba(0,0,0,${scanAlpha.toFixed(4)})`
        for (let y = 0; y < H; y += 3) {
          sCtx.fillRect(0, y, W, 1)
        }
      }
    }

    const initBackdrop = (W: number, H: number) => {
      backdropLayer = document.createElement('canvas')
      backdropLayer.width = W
      backdropLayer.height = H
      const bCtx = backdropLayer.getContext('2d')!

      bCtx.fillStyle = bgHex
      bCtx.fillRect(0, 0, W, H)

      const vignette = bCtx.createRadialGradient(W / 2, H / 2, W * 0.08, W / 2, H / 2, W * 0.7)
      vignette.addColorStop(0, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${0.06 * f})`)
      vignette.addColorStop(0.45, `rgba(${accentSoftRgb.r},${accentSoftRgb.g},${accentSoftRgb.b},${0.025 * f})`)
      vignette.addColorStop(1, `rgba(${bgRgb.r},${bgRgb.g},${bgRgb.b},0)`)
      bCtx.fillStyle = vignette
      bCtx.fillRect(0, 0, W, H)
    }

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight
      initBackdrop(canvas.width, canvas.height)
      initStaticLayer(canvas.width, canvas.height)
    }

    const drawParticles = (W: number, H: number, dtScale: number) => {
      for (const p of particles) {
        p.y -= p.speed * dtScale
        p.x += p.drift * dtScale + Math.sin(tick * 0.01 + p.phase) * 0.0001 * dtScale
        if (p.y < -0.04) {
          p.y = 1.04
          p.x = Math.random()
        }
        if (p.x < -0.04) p.x = 1.04
        if (p.x > 1.04) p.x = -0.04

        const pulse = (Math.sin(tick * 0.018 + p.phase) + 1) * 0.5
        const alpha = p.opacity * pulse * Math.max(0.3, Math.min(1.2, f))
        const px = Math.round((p.x * W) / quant) * quant
        const py = Math.round((p.y * H) / quant) * quant

        ctx.fillStyle = `rgba(${p.color.r},${p.color.g},${p.color.b},${alpha.toFixed(4)})`
        ctx.fillRect(px, py, p.size * 2, p.size * 2)
      }
    }

    const drawSweep = (W: number, H: number) => {
      const sweepY = (tick * 0.18) % (H + 120) - 60
      const grad = ctx.createLinearGradient(0, sweepY, 0, sweepY + 48)
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(0.35, `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${(0.035 * f).toFixed(4)})`)
      grad.addColorStop(0.7, `rgba(${yellowRgb.r},${yellowRgb.g},${yellowRgb.b},${(0.012 * f).toFixed(4)})`)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, sweepY, W, 48)
    }

    const TARGET_FPS = 15
    const FRAME_MS = 1000 / TARGET_FPS
    let lastFrame = 0

    const draw = (timestamp: number) => {
      if (pausedRef.current) {
        animId = 0
        return
      }
      animId = requestAnimationFrame(draw)
      if (timestamp - lastFrame < FRAME_MS) return

      const dt = Math.min(timestamp - lastFrame, 100)
      const dtScale = dt / 16.67
      lastFrame = timestamp

      const W = canvas.width
      const H = canvas.height

      if (backdropLayer) ctx.drawImage(backdropLayer, 0, 0)
      if (staticLayer) ctx.drawImage(staticLayer, 0, 0)

      drawParticles(W, H, dtScale)
      drawSweep(W, H)

      tick += dtScale
    }

    const resume = () => {
      if (!pausedRef.current && !animId) {
        lastFrame = 0
        animId = requestAnimationFrame(draw)
      }
    }
    resumeFnRef.current = resume

    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(animId)
        animId = 0
      } else {
        resume()
      }
    }

    init()
    window.addEventListener('resize', init)

    if (prefersReducedMotion) {
      if (backdropLayer) ctx.drawImage(backdropLayer, 0, 0)
      if (staticLayer) ctx.drawImage(staticLayer, 0, 0)
      drawParticles(canvas.width, canvas.height, 1)
      return () => {
        resumeFnRef.current = null
        window.removeEventListener('resize', init)
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    if (!paused) animId = requestAnimationFrame(draw)

    return () => {
      resumeFnRef.current = null
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [factor, canvasOpacity, bgHex, bgRgb.r, bgRgb.g, bgRgb.b, borderRgb.r, borderRgb.g, borderRgb.b, textRgb.r, textRgb.g, textRgb.b, accentRgb.r, accentRgb.g, accentRgb.b, accentSoftRgb.r, accentSoftRgb.g, accentSoftRgb.b, yellowRgb.r, yellowRgb.g, yellowRgb.b])

  useEffect(() => {
    if (!paused && resumeFnRef.current) {
      resumeFnRef.current()
    }
  }, [paused])

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          opacity: snapshot ? 0 : canvasOpacity,
          zIndex: 0,
        }}
      />
      {snapshot && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            backgroundImage: `url(${snapshot})`,
            backgroundSize: 'cover',
            opacity: canvasOpacity,
            zIndex: 0,
          }}
        />
      )}
    </>
  )
}
