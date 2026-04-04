import { AMBER } from '../../theme/index'

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
}

interface ScanlinesOverlayProps {
  opacity?: number
}

export function ScanlinesOverlay({ opacity = 0.06 }: ScanlinesOverlayProps) {
  const accentHex = AMBER[400] || '#34d399'
  const accentRgb = hexToRgb(accentHex) || { r: 52, g: 211, b: 153 }
  const stripe = `rgba(${accentRgb.r},${accentRgb.g},${accentRgb.b},0.12)`

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 10,
        opacity,
        mixBlendMode: 'overlay',
        backgroundImage: `repeating-linear-gradient(to bottom, ${stripe} 0, ${stripe} 1px, rgba(0,0,0,0) 4px, rgba(0,0,0,0) 7px)`,
      }}
    />
  )
}
