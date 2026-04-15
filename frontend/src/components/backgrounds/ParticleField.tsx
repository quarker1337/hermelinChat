import { useEffect, useRef } from 'react'
import { AMBER } from '../../theme/index'

function clampNum(n: unknown, min: number, max: number): number {
  const x = Number(n)
  if (!Number.isFinite(x)) return min
  return Math.min(max, Math.max(min, x))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
}

interface ParticleFieldProps {
  intensity?: number
  paused?: boolean
}

export function ParticleField({ intensity = 50, paused = false }: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(paused)
  const resumeFnRef = useRef<(() => void) | null>(null)
  pausedRef.current = paused

  const pct = clampNum(intensity, 0, 100)
  const factor = pct / 50
  const canvasOpacity = clampNum(0.5 * factor, 0, 1)

  const accentHex = AMBER[400] || '#f5b731'
  const accentRgb = hexToRgb(accentHex) || { r: 245, g: 183, b: 49 }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches
    if (prefersReducedMotion) return

    let animId = 0
    const TARGET_FPS = 20
    const FRAME_MS = 1000 / TARGET_FPS
    let lastFrame = 0

    const count = Math.max(0, Math.round(30 * factor))

    const particles = Array.from({ length: count }, () => ({
      x: 0,
      y: 0,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.5 + 0.5,
      o: Math.min(0.22, (Math.random() * 0.15 + 0.03) * factor),
    }))

    const particleColors = particles.map(p =>
      `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${p.o})`
    )

    const connBase = Math.min(0.08, 0.04 * factor)

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800
      canvas.height = canvas.parentElement?.offsetHeight || 600
      for (const p of particles) {
        p.x = Math.random() * canvas.width
        p.y = Math.random() * canvas.height
      }
    }

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
      ctx.clearRect(0, 0, W, H)

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        p.x += p.vx * dtScale
        p.y += p.vy * dtScale
        if (p.x < 0) p.x = W
        if (p.x > W) p.x = 0
        if (p.y < 0) p.y = H
        if (p.y > H) p.y = 0

        ctx.fillStyle = particleColors[i]
        const s = p.r * 2
        ctx.fillRect(p.x - p.r, p.y - p.r, s, s)
      }

      ctx.lineWidth = 0.5
      ctx.beginPath()
      let hasLines = false

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const d2 = dx * dx + dy * dy
          if (d2 < 14400) {
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            hasLines = true
          }
        }
      }

      if (hasLines) {
        ctx.strokeStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${connBase})`
        ctx.stroke()
      }
    }

    // Resume function — kicks the animation loop back to life
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
    document.addEventListener('visibilitychange', handleVisibility)
    if (!paused) animId = requestAnimationFrame(draw)

    return () => {
      resumeFnRef.current = null
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [factor, accentRgb.r, accentRgb.g, accentRgb.b])

  // Resume animation when paused flips to false
  useEffect(() => {
    if (!paused && resumeFnRef.current) {
      resumeFnRef.current()
    }
  }, [paused])

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
