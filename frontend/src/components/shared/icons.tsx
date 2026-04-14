import { useMemo } from 'react'
import { AMBER, SLATE } from '../../theme/index'
import { normalizeInlineSvg, svgViewBoxAspect } from '../../utils/svg'

// ─── InvertelinSmall ────────────────────────────────────────────────

interface InvertelinSmallProps {
  size?: number
  href?: string
}

export const InvertelinSmall = ({ size = 22, href = '/favicon.svg' }: InvertelinSmallProps) => (
  <img
    src={href}
    width={size}
    height={size}
    alt=""
    draggable={false}
    style={{ display: 'block' }}
  />
)

// ─── InlineSvgIcon ──────────────────────────────────────────────────

interface InlineSvgIconProps {
  svgRaw?: string
  size?: number
  color?: string
  title?: string
}

interface ThemeIconProps extends InlineSvgIconProps {
  imageHref?: string
  width?: number
  height?: number
  pixelated?: boolean
}

export const InlineSvgIcon = ({
  svgRaw,
  size = 18,
  color = AMBER[400],
  title = '',
}: InlineSvgIconProps) => {
  const svg = useMemo(() => normalizeInlineSvg(svgRaw), [svgRaw])
  const aspect = svgViewBoxAspect(svgRaw)
  const w = Math.round(size * aspect)

  return (
    <span
      title={title || undefined}
      style={{
        display: 'inline-block',
        width: w,
        height: size,
        color,
        lineHeight: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export const ThemeIcon = ({
  svgRaw,
  imageHref,
  size = 18,
  width,
  height,
  color = AMBER[400],
  title = '',
  pixelated = true,
}: ThemeIconProps) => {
  if (imageHref) {
    return (
      <img
        src={imageHref}
        width={width ?? size}
        height={height ?? size}
        title={title || undefined}
        alt=""
        draggable={false}
        style={{
          display: 'block',
          imageRendering: pixelated ? 'pixelated' : 'auto',
          flexShrink: 0,
        }}
      />
    )
  }

  return <InlineSvgIcon svgRaw={svgRaw} size={size} color={color} title={title} />
}

// ─── SidebarDockIcon ────────────────────────────────────────────────

interface SidebarDockIconProps {
  expand?: boolean
  size?: number
}

export const SidebarDockIcon = ({ expand = false, size = 16 }: SidebarDockIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
    <polyline points={expand ? '12 9 15 12 12 15' : '15 9 12 12 15 15'} />
  </svg>
)

// ─── SettingsIcon ───────────────────────────────────────────────────

interface SettingsIconProps {
  size?: number
}

export const SettingsIcon = ({ size = 16 }: SettingsIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

// ─── PlusIcon ───────────────────────────────────────────────────────

interface PlusIconProps {
  size?: number
}

export const PlusIcon = ({ size = 16 }: PlusIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

// ─── LogoutIcon ─────────────────────────────────────────────────────

interface LogoutIconProps {
  size?: number
}

export const LogoutIcon = ({ size = 16 }: LogoutIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)
