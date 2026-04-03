import { useCallback, useEffect, useState } from 'react'
import { AMBER, SLATE } from '../theme/index.js'
import { InlineSvgIcon } from './shared/icons'
import { useToastStore } from '../stores/toast'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AlignmentEasterEggProps {
  svgRaw?: string
  title?: string
  whisperText?: string
  fetchFromApi?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AlignmentEasterEgg = ({
  svgRaw,
  title,
  whisperText,
  fetchFromApi = true,
}: AlignmentEasterEggProps) => {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)

  const toast = useToastStore((s) => s.toast)

  const baseWhisper = ((whisperText || '').toString().trim() || 'aligned to you\u2026').slice(0, 80)
  const [whisper, setWhisper] = useState(baseWhisper)

  const toastText = (toast?.text || '').toString().trim()
  const toastActive = !!toastText
  const toastId = toast?.id || ''

  const opacity = open ? 0.75 : toastActive ? 0.75 : hovered ? 0.25 : 0.08

  const fetchWhisper = useCallback(async () => {
    try {
      const r = await fetch('/api/whisper')
      if (!r.ok) throw new Error(`http ${r.status}`)
      const data = await r.json()
      const t = (data?.text || '').toString().trim()
      setWhisper((t || baseWhisper || 'aligned to you\u2026').slice(0, 80))
    } catch {
      setWhisper((baseWhisper || 'aligned to you\u2026').slice(0, 80))
    }
  }, [baseWhisper])

  useEffect(() => {
    if (!open) {
      // Keep the default whisper in sync with theme changes.
      setWhisper(baseWhisper)
      return
    }

    // Always show the theme-appropriate whisper immediately.
    setWhisper(baseWhisper)

    // Optionally override with a server-provided whisper.
    if (fetchFromApi) fetchWhisper()
  }, [open, fetchWhisper, fetchFromApi, baseWhisper])

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation()
        setOpen((v) => !v)
        // keep typing without needing another click
        setTimeout(() => {
          try {
            document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
          } catch {
            // ignore
          }
        }, 0)
      }}
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        cursor: 'pointer',
        zIndex: 12,
        opacity,
        transition: 'all 0.35s ease',
        transform: open ? 'scale(1.15)' : toastActive ? 'scale(1.1)' : 'scale(1)',
        filter: open || toastActive ? `drop-shadow(0 0 10px ${AMBER[400]}70)` : 'none',
        userSelect: 'none',
      }}
      title={title || 'the stout knows\u2026'}
    >
      <InlineSvgIcon svgRaw={svgRaw} size={18} />

      {toastActive && (
        <div
          key={toastId}
          className="egg-toast-anim"
          style={{
            position: 'absolute',
            bottom: 24,
            right: 0,
            whiteSpace: 'nowrap',
            fontSize: 9,
            color: AMBER[400],
            textShadow: `0 0 8px ${AMBER[400]}40`,
            padding: '3px 7px',
            borderRadius: 999,
            background: `${SLATE.surface}dd`,
            border: `1px solid ${AMBER[900]}55`,
            pointerEvents: 'none',
            animation: `eggToastFade 2600ms ease-in-out forwards`,
            willChange: 'opacity, transform',
          }}
        >
          {toastText}
        </div>
      )}

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: toastActive ? 42 : 24,
            right: 0,
            whiteSpace: 'nowrap',
            fontSize: 9,
            color: AMBER[400],
            textShadow: `0 0 8px ${AMBER[400]}40`,
          }}
        >
          {whisper}
        </div>
      )}
    </div>
  )
}
