import { memo, useEffect, useMemo, useRef, useState } from 'react'

import type { PetActivityState, PetOverlayPrefs, PetOverlayPosition } from '../../types'
import { DEFAULT_UI_PREFS } from '../../utils/ui-prefs'

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

type PetState = PetActivityState

interface PetSummary {
  slug: string
  displayName?: string
  description?: string
}

interface PetInfo {
  enabled?: boolean
  terminalEnabled?: boolean
  slug?: string | null
  configuredSlug?: string | null
  source?: 'configured' | 'override'
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
  installedPets?: PetSummary[]
}

interface PetCanvasProps {
  info: PetInfo
  state: PetState
  sizePct: number
}

function clampSizePct(size: unknown): number {
  const n = Number(size)
  if (!Number.isFinite(n)) return DEFAULT_UI_PREFS.petOverlay.size
  return Math.max(50, Math.min(180, n))
}

function rowAliasesForState(state: PetState): string[] {
  switch (state) {
    case 'waiting': return ['waiting', 'idle']
    case 'running': return ['running', 'running-right', 'running-left', 'waiting', 'idle']
    case 'review': return ['review', 'waving', 'idle']
    case 'failed': return ['failed', 'idle']
    case 'waving': return ['waving', 'idle']
    case 'jumping': return ['jumping', 'idle']
    default: return ['idle']
  }
}

function rowIndexForState(rows: string[], state: PetState): number {
  for (const alias of rowAliasesForState(state)) {
    const idx = rows.indexOf(alias)
    if (idx >= 0) return idx
  }
  return 0
}

function placementStyle(position: PetOverlayPosition, shellW: number, shellH: number): React.CSSProperties {
  const base: React.CSSProperties = {
    alignItems: position.startsWith('top') ? 'flex-start' : 'flex-end',
    display: 'flex',
    height: shellH,
    justifyContent: 'center',
    pointerEvents: 'none',
    position: 'absolute',
    width: shellW,
    zIndex: 9,
  }

  if (position.includes('left')) base.left = 14
  else base.right = 14

  if (position.startsWith('top')) base.top = 12
  else base.bottom = 12

  return base
}

function petInfoUrl(slugOverride: string): string {
  const slug = (slugOverride || '').trim()
  if (!slug) return '/api/pet/info'
  return `/api/pet/info?slug=${encodeURIComponent(slug)}`
}

const PetCanvas = memo(function PetCanvas({ info, state, sizePct }: PetCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<PetState>(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const frameW = info.frameW ?? DEFAULT_FRAME_W
  const frameH = info.frameH ?? DEFAULT_FRAME_H
  const frames = Math.max(1, info.framesPerState ?? DEFAULT_FRAMES)
  const loopMs = Math.max(120, info.loopMs ?? DEFAULT_LOOP_MS)
  const scale = Math.max(0.1, Math.min(3, info.scale ?? DEFAULT_SCALE)) * OVERLAY_ZOOM * (clampSizePct(sizePct) / 100)
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

interface FloatingPetOverlayProps {
  activityState?: PetActivityState
  paused?: boolean
  settings?: PetOverlayPrefs
  visible?: boolean
}

export function FloatingPetOverlay({
  activityState = 'idle',
  paused = false,
  settings = DEFAULT_UI_PREFS.petOverlay,
  visible = true,
}: FloatingPetOverlayProps) {
  const [info, setInfo] = useState<PetInfo | null>(null)

  const petSettings = settings || DEFAULT_UI_PREFS.petOverlay
  const slugOverride = (petSettings.slug || '').trim()
  const sizePct = clampSizePct(petSettings.size)
  const position = petSettings.position || DEFAULT_UI_PREFS.petOverlay.position
  const active = Boolean(info?.enabled && info?.spritesheetBase64)

  useEffect(() => {
    if (!visible) {
      setInfo(null)
      return
    }

    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch(petInfoUrl(slugOverride), { cache: 'no-store' })
        if (!response.ok) return
        const next = (await response.json()) as PetInfo
        if (cancelled) return
        setInfo((current) => {
          if (
            current?.enabled === next?.enabled &&
            current?.slug === next?.slug &&
            current?.configuredSlug === next?.configuredSlug &&
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
  }, [active, slugOverride, visible])

  if (!visible || !active || !info) return null

  const frameW = info.frameW ?? DEFAULT_FRAME_W
  const frameH = info.frameH ?? DEFAULT_FRAME_H
  const scale = Math.max(0.1, Math.min(3, info.scale ?? DEFAULT_SCALE)) * OVERLAY_ZOOM * (sizePct / 100)
  const drawW = Math.round(frameW * scale)
  const drawH = Math.round(frameH * scale)
  const shellW = Math.max(96, drawW + 18)
  const shellH = Math.max(104, drawH + 8)
  const state: PetState = paused ? 'waiting' : activityState

  return (
    <div
      aria-hidden
      title={`${info.displayName || info.slug || 'Hermes pet'} · ${state}`}
      style={placementStyle(position, shellW, shellH)}
    >
      <div style={{ filter: 'drop-shadow(0 8px 12px rgba(0,0,0,0.32))', lineHeight: 0, position: 'relative' }}>
        <PetCanvas info={info} state={state} sizePct={sizePct} />
      </div>
    </div>
  )
}
