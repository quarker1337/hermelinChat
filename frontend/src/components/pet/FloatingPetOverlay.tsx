import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { SLATE } from '../../theme/index'

const DEFAULT_FRAME_W = 192
const DEFAULT_FRAME_H = 208
const DEFAULT_FRAMES = 6
const DEFAULT_LOOP_MS = 1100
const DEFAULT_SCALE = 0.33
const OVERLAY_ZOOM = 1.4
const PET_POLL_MS = 3000
const PET_ACTIVE_REFRESH_MS = 15000
const DEFAULT_STATE_ROWS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
]

type PetState = 'idle' | 'waiting'

interface PetInfo {
  enabled?: boolean
  terminalEnabled?: boolean
  slug?: string | null
  displayName?: string
  description?: string
  mime?: string
  spritesheetBase64?: string
  spritesheetRevision?: string
  frameW?: number
  frameH?: number
  framesPerState?: number
  loopMs?: number
  scale?: number
  stateRows?: string[]
}

interface PetCanvasProps {
  info: PetInfo
  state: PetState
}

function rowIndexForState(rows: string[], state: PetState): number {
  const aliases = state === 'waiting' ? ['waiting', 'idle'] : ['idle']
  for (const alias of aliases) {
    const idx = rows.indexOf(alias)
    if (idx >= 0) return idx
  }
  return 0
}

const PetCanvas = memo(function PetCanvas({ info, state }: PetCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<PetState>(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const frameW = info.frameW ?? DEFAULT_FRAME_W
  const frameH = info.frameH ?? DEFAULT_FRAME_H
  const frames = Math.max(1, info.framesPerState ?? DEFAULT_FRAMES)
  const loopMs = Math.max(120, info.loopMs ?? DEFAULT_LOOP_MS)
  const scale = Math.max(0.1, Math.min(3, info.scale ?? DEFAULT_SCALE)) * OVERLAY_ZOOM
  const rows = info.stateRows?.length ? info.stateRows : DEFAULT_STATE_ROWS
  const drawW = Math.max(1, Math.round(frameW * scale))
  const drawH = Math.max(1, Math.round(frameH * scale))

  const image = useMemo(() => {
    if (!info.spritesheetBase64) return null
    const img = new Image()
    img.src = `data:${info.mime ?? 'image/webp'};base64,${info.spritesheetBase64}`
    return img
  }, [info.spritesheetBase64, info.mime])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let frame = 0
    let lastStep = performance.now()
    let drawnFrame = -1
    let drawnRow = -1

    const render = (now: number) => {
      const row = rowIndexForState(rows, stateRef.current)
      const stepMs = loopMs / frames
      if (now - lastStep >= stepMs) {
        frame += 1
        lastStep = now
      }
      frame %= frames

      if ((frame !== drawnFrame || row !== drawnRow) && image.complete && image.naturalWidth > 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(image, frame * frameW, row * frameH, frameW, frameH, 0, 0, drawW, drawH)
        drawnFrame = frame
        drawnRow = row
      }

      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [image, frameW, frameH, frames, loopMs, drawW, drawH, rows])

  return (
    <canvas
      aria-label={info.displayName ? `${info.displayName} pet` : 'Hermes pet'}
      height={drawH}
      ref={canvasRef}
      style={{
        display: 'block',
        height: drawH,
        imageRendering: 'pixelated',
        width: drawW,
      }}
      width={drawW}
    />
  )
})

export function FloatingPetOverlay({ paused = false, visible = true }: { paused?: boolean; visible?: boolean }) {
  const [info, setInfo] = useState<PetInfo | null>(null)

  const active = Boolean(info?.enabled && info?.spritesheetBase64)
  useEffect(() => {
    if (!visible) {
      setInfo(null)
      return
    }

    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch('/api/pet/info', { cache: 'no-store' })
        if (!response.ok) return
        const next = (await response.json()) as PetInfo
        if (cancelled) return
        setInfo((current) => {
          if (
            current?.enabled === next?.enabled &&
            current?.slug === next?.slug &&
            current?.spritesheetRevision === next?.spritesheetRevision &&
            current?.scale === next?.scale
          ) {
            return current
          }
          return next
        })
      } catch {
        // Cosmetic only — keep the terminal usable if the pet endpoint is absent.
      }
    }

    void pull()
    const timer = window.setInterval(() => void pull(), active ? PET_ACTIVE_REFRESH_MS : PET_POLL_MS)
    window.addEventListener('focus', pull)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', pull)
    }
  }, [active, visible])

  if (!visible || !active || !info) return null

  const frameW = info.frameW ?? DEFAULT_FRAME_W
  const frameH = info.frameH ?? DEFAULT_FRAME_H
  const scale = Math.max(0.1, Math.min(3, info.scale ?? DEFAULT_SCALE)) * OVERLAY_ZOOM
  const drawW = Math.round(frameW * scale)
  const drawH = Math.round(frameH * scale)
  const shellW = Math.max(148, drawW + 38)
  const shellH = Math.max(124, drawH + 24)
  const state: PetState = paused ? 'waiting' : 'idle'

  return (
    <div
      aria-hidden
      title={info.displayName || info.slug || 'Hermes pet'}
      style={{
        alignItems: 'flex-end',
        background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.52) 56%, rgba(0,0,0,0) 72%)',
        bottom: 12,
        display: 'flex',
        height: shellH,
        justifyContent: 'center',
        pointerEvents: 'none',
        position: 'absolute',
        right: 14,
        width: shellW,
        zIndex: 9,
      }}
    >
      <div
        style={{
          background: `linear-gradient(180deg, ${SLATE.bg}22, ${SLATE.bg}05)`,
          borderRadius: '999px',
          bottom: 4,
          boxShadow: '0 18px 34px rgba(0,0,0,0.4)',
          height: Math.max(8, Math.round(drawW * 0.18)),
          left: '50%',
          position: 'absolute',
          transform: 'translateX(-50%)',
          width: Math.max(42, Math.round(drawW * 0.62)),
        }}
      />
      <div style={{ filter: 'drop-shadow(0 12px 22px rgba(0,0,0,0.5))', lineHeight: 0, position: 'relative' }}>
        <PetCanvas info={info} state={state} />
      </div>
    </div>
  )
}
