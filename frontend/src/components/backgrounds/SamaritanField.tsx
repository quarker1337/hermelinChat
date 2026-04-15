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

interface SamaritanFieldProps {
  intensity?: number
}

export function SamaritanField({ intensity = 50 }: SamaritanFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const pct = clampNum(intensity, 0, 100)
  // 75 == "normal" intensity
  const factor = pct / 75
  const canvasOpacity = clampNum(0.85 * factor, 0, 1)

  const bgHex = SLATE.bg || '#e8e6e1'
  const bgRgb = hexToRgb(bgHex) || { r: 232, g: 230, b: 225 }

  const textHex = SLATE.text || '#3a3835'
  const textRgb = hexToRgb(textHex) || { r: 58, g: 56, b: 53 }

  const borderHex = SLATE.border || '#bab8b3'
  const borderRgb = hexToRgb(borderHex) || { r: 186, g: 184, b: 179 }

  const accentHex = AMBER[400] || '#cc3333'
  const accentRgb = hexToRgb(accentHex) || { r: 204, g: 51, b: 51 }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const prefersReducedMotion =
      !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches

    if (prefersReducedMotion) return

    let animId = 0
    let t = 0

    const f = clampNum(factor, 0, 2)
    let blocks: {
      x: number
      y: number
      vx: number
      vy: number
      w: number
      h: number
      depth: number
      opacity: number
      life: number
      maxLife: number
    }[] = []
    const maxBlocks = Math.max(8, Math.round(25 * f))

    const nodeCount = Math.max(4, Math.round(8 * f))
    const nodes = Array.from({ length: nodeCount }, () => ({
      x: 0,
      y: 0,
      vx: (Math.random() - 0.5) * 0.04,
      vy: (Math.random() - 0.5) * 0.04,
      phase: Math.random() * Math.PI * 2,
    }))

    const spawnBlock = (W: number, H: number) => {
      const isH = Math.random() > 0.35
      const depth = Math.random()
      let x: number, y: number, vx: number, vy: number

      const speedScale = 0.8 + f * 0.6

      if (isH) {
        const left = Math.random() > 0.5
        x = left ? -120 : W + 120
        y = Math.random() * H
        vx = (left ? 1 : -1) * (0.1 + depth * 0.5) * speedScale
        vy = (Math.random() - 0.5) * 0.05
      } else {
        const top = Math.random() > 0.5
        x = Math.random() * W
        y = top ? -80 : H + 80
        vx = (Math.random() - 0.5) * 0.05
        vy = (top ? 1 : -1) * (0.1 + depth * 0.5) * speedScale
      }

      let w = (Math.random() * 35 + 8) * (0.3 + depth * 0.7)
      let h = (Math.random() * 6 + 2) * (0.3 + depth * 0.7)
      if (Math.random() < 0.2) {
        const tmp = w
        w = h * 0.6
        h = tmp * 1.2
      }

      return {
        x,
        y,
        vx,
        vy,
        w,
        h,
        depth,
        opacity: (0.06 + depth * 0.2) * (0.4 + Math.random() * 0.6) * (0.7 + f * 0.6),
        life: 0,
        maxLife: 600 + Math.random() * 800,
      }
    }

    // ─── Pre-rendered static layers ──────────────────────────────────────────

    let staticLayer: HTMLCanvasElement | null = null

    const initStaticLayers = (W: number, H: number) => {
      staticLayer = document.createElement('canvas')
      staticLayer.width = W
      staticLayer.height = H
      const sCtx = staticLayer.getContext('2d')!

      // Background fill
      sCtx.fillStyle = bgHex
      sCtx.fillRect(0, 0, W, H)

      // Vignette (never changes)
      const vig = sCtx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.8)
      vig.addColorStop(0, `rgba(${bgRgb.r},${bgRgb.g},${bgRgb.b},0)`)
      vig.addColorStop(1, `rgba(${borderRgb.r},${borderRgb.g},${borderRgb.b},${(0.22 * f).toFixed(4)})`)
      sCtx.fillStyle = vig
      sCtx.fillRect(0, 0, W, H)

      // Grid (never changes)
      const gridAlpha = 0.025 * f
      if (gridAlpha > 0.001) {
        sCtx.strokeStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${gridAlpha.toFixed(4)})`
        sCtx.lineWidth = 0.5
        for (let x = 0; x < W; x += 70) {
          sCtx.beginPath(); sCtx.moveTo(x, 0); sCtx.lineTo(x, H); sCtx.stroke()
        }
        for (let y = 0; y < H; y += 70) {
          sCtx.beginPath(); sCtx.moveTo(0, y); sCtx.lineTo(W, y); sCtx.stroke()
        }
      }

      // Scanlines (never change)
      const scanAlpha = 0.012 * f
      if (scanAlpha > 0.001) {
        sCtx.fillStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${scanAlpha.toFixed(4)})`
        for (let y = 0; y < H; y += 3) {
          sCtx.fillRect(0, y, W, 1)
        }
      }
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight
      initStaticLayers(canvas.width, canvas.height)

      blocks = []
      const seedCount = Math.max(0, Math.round(20 * f))
      for (let i = 0; i < seedCount; i++) {
        const b = spawnBlock(canvas.width, canvas.height)
        b.life = Math.random() * b.maxLife
        blocks.push(b)
      }

      for (const n of nodes) {
        n.x = Math.random() * canvas.width
        n.y = Math.random() * canvas.height
      }
    }

    // ─── Draw loop (throttled to 20fps) ──────────────────────────────────────

    const TARGET_FPS = 20
    const FRAME_MS = 1000 / TARGET_FPS
    let lastFrame = 0

    const draw = (timestamp: number) => {
      animId = requestAnimationFrame(draw)
      if (timestamp - lastFrame < FRAME_MS) return

      // Delta time compensation — same visual speed at any framerate
      const dt = Math.min(timestamp - lastFrame, 100)
      const dtScale = dt / 16.67
      lastFrame = timestamp

      const W = canvas.width
      const H = canvas.height

      // Static layers — one blit
      if (staticLayer) ctx.drawImage(staticLayer, 0, 0)

      // Connection nodes (only 8, O(n²) is fine)
      for (const n of nodes) {
        n.x += (n.vx + Math.sin(t * 0.0008 + n.phase) * 0.02) * dtScale
        n.y += (n.vy + Math.cos(t * 0.0006 + n.phase) * 0.015) * dtScale
        if (n.x < 0) n.x = W
        if (n.x > W) n.x = 0
        if (n.y < 0) n.y = H
        if (n.y > H) n.y = 0
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 < 90000) { // 300²
            const dist = Math.sqrt(d2)
            const alpha = (1 - dist / 300) * 0.03 * f
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            if ((i + j) % 2 === 0) {
              ctx.lineTo(b.x, a.y)
              ctx.lineTo(b.x, b.y)
            } else {
              ctx.lineTo(a.x, b.y)
              ctx.lineTo(b.x, b.y)
            }
            ctx.strokeStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${alpha.toFixed(4)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }

      // Spawn blocks
      if (blocks.length < maxBlocks && Math.random() < 0.03 * f) {
        blocks.push(spawnBlock(W, H))
      }

      // Draw blocks (skip save/restore — offset fillRect directly)
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        b.x += b.vx * dtScale
        b.y += b.vy * dtScale
        b.life += dtScale

        if (
          b.life > b.maxLife ||
          b.x < -200 ||
          b.x > W + 200 ||
          b.y < -200 ||
          b.y > H + 200
        ) {
          blocks.splice(i, 1)
          continue
        }

        const alpha =
          b.opacity *
          Math.min(b.life / 60, 1) *
          Math.min((b.maxLife - b.life) / 80, 1)

        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
        const bl = sp * 3 * b.depth

        ctx.fillStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${alpha.toFixed(4)})`
        ctx.fillRect(b.x - b.w / 2 - (b.vx > 0 ? bl : 0), b.y - b.h / 2, b.w + bl, b.h)
        if (bl > 1) {
          ctx.fillStyle = `rgba(${textRgb.r},${textRgb.g},${textRgb.b},${(alpha * 0.15).toFixed(4)})`
          ctx.fillRect(b.vx > 0 ? b.x - b.w / 2 - bl * 1.5 : b.x + b.w / 2, b.y - b.h / 2, bl * 1.5, b.h)
        }
      }

      // Moving scan bar (slight accent)
      const scanY = (t * 0.15) % (H + 60) - 30
      ctx.fillStyle = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},${(0.01 * f).toFixed(4)})`
      ctx.fillRect(0, scanY, W, 30)

      t += dtScale
    }

    // Tab visibility
    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(animId)
        animId = 0
      } else if (!animId) {
        lastFrame = 0
        animId = requestAnimationFrame(draw)
      }
    }

    init()
    window.addEventListener('resize', init)
    document.addEventListener('visibilitychange', handleVisibility)
    animId = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', init)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [
    factor,
    bgHex,
    bgRgb.r,
    bgRgb.g,
    bgRgb.b,
    textRgb.r,
    textRgb.g,
    textRgb.b,
    borderRgb.r,
    borderRgb.g,
    borderRgb.b,
    accentRgb.r,
    accentRgb.g,
    accentRgb.b,
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
