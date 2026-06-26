import { useEffect, useMemo, useState } from 'react'

import { AMBER, SLATE } from '../../theme/index'
import { DEFAULT_UI_PREFS, PET_OVERLAY_POSITION_VALUES } from '../../utils/ui-prefs'
import type { PetOverlayPosition, UiPrefs } from '../../types'

interface PetSummary {
  slug: string
  displayName?: string
  description?: string
}

interface PetInfoResponse {
  slug?: string | null
  configuredSlug?: string | null
  installedPets?: PetSummary[]
}

interface PetOverlaySettingsProps {
  ui: UiPrefs
  onUpdate: (updater: (prev: UiPrefs) => UiPrefs) => void
}

function positionLabel(pos: string): string {
  switch (pos) {
    case 'bottom-left': return 'Bottom left'
    case 'top-right': return 'Top right'
    case 'top-left': return 'Top left'
    default: return 'Bottom right'
  }
}

export const PetOverlaySettings = ({ ui, onUpdate }: PetOverlaySettingsProps) => {
  const [info, setInfo] = useState<PetInfoResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch('/api/pet/info', { cache: 'no-store' })
        if (!response.ok) return
        const next = (await response.json()) as PetInfoResponse
        if (!cancelled) setInfo(next)
      } catch {
        // cosmetic settings panel only
      }
    }
    void pull()
    return () => {
      cancelled = true
    }
  }, [])

  const pets = useMemo(() => {
    const seen = new Set<string>()
    const out: PetSummary[] = []
    for (const pet of info?.installedPets || []) {
      const slug = String(pet?.slug || '').trim()
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      out.push({ ...pet, slug })
    }
    return out
  }, [info])

  const configuredLabel = info?.configuredSlug || info?.slug || 'current pet'
  const petOverlay = ui.petOverlay || DEFAULT_UI_PREFS.petOverlay
  const updatePetOverlay = (patch: Partial<typeof DEFAULT_UI_PREFS.petOverlay>) => {
    onUpdate((prev) => ({
      ...prev,
      petOverlay: { ...(prev.petOverlay || DEFAULT_UI_PREFS.petOverlay), ...patch },
    }))
  }
  const selectStyle: React.CSSProperties = {
    background: SLATE.elevated,
    border: `1px solid ${SLATE.border}`,
    color: SLATE.textBright,
    padding: '6px 8px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    outline: 'none',
    borderRadius: 8,
    maxWidth: 220,
  }

  return (
    <>
      <div style={{ fontSize: 11, color: SLATE.muted, lineHeight: 1.45, marginBottom: 10 }}>
        Browser-only canvas pet controls. Leave pet set to{' '}
        <span style={{ color: AMBER[500] }}>Hermes active</span> to follow your global Hermes pet.
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          border: `1px solid ${petOverlay.enabled ? `${AMBER[700]}66` : SLATE.border}`,
          background: petOverlay.enabled ? `${AMBER[900]}22` : SLATE.elevated,
          color: SLATE.textBright,
          cursor: 'pointer',
          fontSize: 11,
          borderRadius: 8,
          userSelect: 'none',
          marginBottom: 12,
        }}
        title="Show or hide the HermelinChat browser pet overlay for this browser"
      >
        <input
          type="checkbox"
          checked={petOverlay.enabled}
          onChange={(e) => updatePetOverlay({ enabled: e.target.checked })}
        />
        <span style={{ fontWeight: 700 }}>Show browser pet overlay</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: petOverlay.enabled ? AMBER[500] : SLATE.muted }}>
          {petOverlay.enabled ? 'on' : 'off'}
        </span>
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Pet</div>
        <div style={{ flex: 1 }} />
        <select
          value={petOverlay.slug || ''}
          onChange={(e) => updatePetOverlay({ slug: e.target.value })}
          style={selectStyle}
          title="HermelinChat overlay pet"
        >
          <option value="">Hermes active ({configuredLabel})</option>
          {pets.map((pet) => (
            <option key={pet.slug} value={pet.slug}>
              {pet.displayName || pet.slug} ({pet.slug})
            </option>
          ))}
        </select>
      </div>

      <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Position</div>
        <div style={{ flex: 1 }} />
        <select
          value={petOverlay.position}
          onChange={(e) => {
            const position = e.target.value as PetOverlayPosition
            updatePetOverlay({ position })
          }}
          style={selectStyle}
          title="Pet overlay position"
        >
          {PET_OVERLAY_POSITION_VALUES.map((pos) => (
            <option key={pos} value={pos}>
              {positionLabel(pos)}
            </option>
          ))}
        </select>
      </div>

      <div style={{ height: 1, background: SLATE.border, margin: '12px 0' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: SLATE.textBright, fontWeight: 600 }}>Size</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: AMBER[500] }}>{petOverlay.size}%</div>
      </div>
      <input
        type="range"
        min={50}
        max={180}
        step={5}
        value={petOverlay.size}
        onChange={(e) => updatePetOverlay({ size: Number(e.target.value) })}
        style={{ width: '100%' }}
      />

      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <div
          onClick={() =>
            onUpdate((prev) => ({
              ...prev,
              petOverlay: { ...DEFAULT_UI_PREFS.petOverlay },
            }))
          }
          style={{
            padding: '8px 10px',
            border: `1px solid ${SLATE.border}`,
            background: SLATE.elevated,
            color: SLATE.muted,
            cursor: 'pointer',
            fontSize: 11,
            borderRadius: 8,
            userSelect: 'none',
          }}
          title="Reset pet overlay settings"
        >
          reset pet
        </div>
      </div>
    </>
  )
}
