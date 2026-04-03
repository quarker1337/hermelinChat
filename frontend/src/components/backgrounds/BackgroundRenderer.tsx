import { useUiPrefsStore } from '../../stores/ui-prefs'
import { ParticleField } from './ParticleField'
import { MatrixRainField } from './MatrixRainField'
import { NousCRTField } from './NousCRTField'
import { SamaritanField } from './SamaritanField'
import { GrainOverlay } from './GrainOverlay'
import { ScanlinesOverlay } from './ScanlinesOverlay'

export function BackgroundRenderer() {
  const effectiveBgKind = useUiPrefsStore((s) => s.effectiveBgKind)
  const prefs = useUiPrefsStore((s) => s.prefs)
  const activeTheme = useUiPrefsStore((s) => s.activeTheme)

  const intensity = prefs.particles.intensity
  const overlayKind = activeTheme?.background?.overlay?.kind
  const overlayOpacity = activeTheme?.background?.overlay?.opacity

  return (
    <>
      {prefs.particles.enabled && intensity > 0 && (
        <>
          {effectiveBgKind === 'matrix-rain' ? (
            <MatrixRainField intensity={intensity} config={activeTheme?.background?.matrixRain} />
          ) : effectiveBgKind === 'nous-crt' ? (
            <NousCRTField intensity={intensity} />
          ) : effectiveBgKind === 'samaritan' ? (
            <SamaritanField intensity={intensity} />
          ) : (
            <ParticleField intensity={intensity} />
          )}
        </>
      )}
      {overlayKind === 'scanlines' ? (
        <ScanlinesOverlay opacity={overlayOpacity ?? 0.06} />
      ) : overlayKind === 'grain' ? (
        <GrainOverlay opacity={overlayOpacity ?? 0.03} />
      ) : null}
    </>
  )
}
