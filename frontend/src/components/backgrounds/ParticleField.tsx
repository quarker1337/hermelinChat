import { useEffect, useRef } from 'react'
import { AMBER } from '../../theme/index.js'

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
}

export function ParticleField({ intensity = 50 }: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const pct = clampNum(intensity, 0, 100)
  // 50 == current look
  const factor = pct / 50
  const canvasOpacity = clampNum(0.5 * factor, 0, 1)

  const accentHex = AMBER[400] || '#f5b731'
  const accentRgb = hexToRgb(accentHex) || { r: 245, g: 183, b: 49 }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    let particles: { x: number; y: number; vx: number; vy: number; r: number; o: number }[] = []

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800
      canvas.height = canvas.parentElement?.offsetHeight || 600

      const count = Math.max(0, Math.round(60 * factor))
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        o: Math.min(0.22, (Math.random() * 0.15 + 0.03) * factor),
      }))
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = canvas.width
        if (p.x > canvas.width) p.x = 0
        if (p.y < 0) p.y = canvas.height
        if (p.y > canvas.height) p.y = 0
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${p.o})`
        ctx.fill()
      }

      const connBase = Math.min(0.08, 0.04 * factor)
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < 120) {
            ctx.beginPath()
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            ctx.strokeStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${connBase * (1 - d / 120)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }
      animId = requestAnimationFrame(draw)
    }

    init()
    window.addEventListener('resize', init)
    draw()
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
    }
  }, [factor, accentRgb.r, accentRgb.g, accentRgb.b])

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
