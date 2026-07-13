import { AMBER, SLATE } from '../../theme/index'
import type { HermesRuntime, PetActivityState } from '../../types'

interface RemoteTarget {
  node: string
  runtimeId: string
}

interface ActiveRuntimeListProps {
  localRuntimes: HermesRuntime[]
  remoteRuntimes: HermesRuntime[]
  activeLocalRuntimeId: string | null
  activeRemoteTarget: RemoteTarget | null
  currentActivityState: PetActivityState
  onSelectLocal: (runtimeId: string) => void
  onSelectRemote: (runtime: HermesRuntime) => void
}

function runtimeNode(runtime: HermesRuntime): string {
  return String(runtime.node || runtime.metadata?.node || '').trim()
}

export function runtimeActivityLabel(
  runtime: HermesRuntime,
  current: boolean,
  currentActivityState: PetActivityState,
): 'idle' | 'working' {
  if (current && !['idle', 'wave', 'jump', 'failed'].includes(currentActivityState)) return 'working'
  const activity = String(runtime.runtime_activity || runtime.state || '').toLowerCase()
  return ['working', 'starting', 'busy'].includes(activity) ? 'working' : 'idle'
}

function RuntimeRow({
  runtime,
  location,
  current,
  activity,
  onClick,
}: {
  runtime: HermesRuntime
  location: string
  current: boolean
  activity: 'idle' | 'working'
  onClick: () => void
}) {
  const color = current ? AMBER[300] : SLATE.textBright
  const dotColor = activity === 'working' ? AMBER[400] : SLATE.success
  return (
    <button
      type="button"
      className="hm-btn"
      onClick={onClick}
      title={current ? 'Current Hermes session' : `Switch to ${runtime.title || runtime.runtime_id}`}
      style={{
        width: '100%',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 8,
        padding: '7px 8px',
        border: `1px solid ${current ? AMBER[800] : SLATE.border}`,
        borderRadius: 8,
        background: current ? `${AMBER[900]}38` : SLATE.elevated,
        textAlign: 'left',
      }}
    >
      <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <span style={{ color, fontSize: 11, fontWeight: current ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {runtime.title || runtime.runtime_id}
        </span>
        <span style={{ color: SLATE.muted, fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {`${location} · ${runtime.profile || 'default'}`}
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: activity === 'working' ? AMBER[400] : SLATE.muted, fontSize: 9 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor, boxShadow: activity === 'working' ? `0 0 5px ${dotColor}` : 'none' }} />
        {activity}
      </span>
    </button>
  )
}

export function ActiveRuntimeList({
  localRuntimes,
  remoteRuntimes,
  activeLocalRuntimeId,
  activeRemoteTarget,
  currentActivityState,
  onSelectLocal,
  onSelectRemote,
}: ActiveRuntimeListProps) {
  if (localRuntimes.length === 0 && remoteRuntimes.length === 0) {
    return (
      <div style={{ color: SLATE.muted, fontSize: 10, padding: '18px 8px', textAlign: 'center' }}>
        No active Hermes sessions
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 2 }}>
      {localRuntimes.length > 0 && (
        <section style={{ display: 'grid', gap: 5 }}>
          <div style={{ color: SLATE.dim, fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase' }}>Local</div>
          {localRuntimes.map((runtime) => {
            const current = !activeRemoteTarget && runtime.runtime_id === activeLocalRuntimeId
            return (
              <RuntimeRow
                key={`local:${runtime.runtime_id}`}
                runtime={runtime}
                location="local"
                current={current}
                activity={runtimeActivityLabel(runtime, current, currentActivityState)}
                onClick={() => onSelectLocal(runtime.runtime_id)}
              />
            )
          })}
        </section>
      )}

      {remoteRuntimes.length > 0 && (
        <section style={{ display: 'grid', gap: 5 }}>
          <div style={{ color: SLATE.dim, fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase' }}>Fleet</div>
          {remoteRuntimes.map((runtime) => {
            const node = runtimeNode(runtime)
            const current = activeRemoteTarget?.node === node && activeRemoteTarget.runtimeId === runtime.runtime_id
            return (
              <RuntimeRow
                key={`remote:${node}:${runtime.runtime_id}`}
                runtime={runtime}
                location={node || 'remote'}
                current={current}
                activity={runtimeActivityLabel(runtime, current, currentActivityState)}
                onClick={() => onSelectRemote(runtime)}
              />
            )
          })}
        </section>
      )}
    </div>
  )
}
