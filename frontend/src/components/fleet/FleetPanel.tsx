import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useFleetStore } from '../../stores/fleet'
import { useToastStore } from '../../stores/toast'
import { AMBER, SLATE, semanticColor } from '../../theme/index'
import type { FleetAgent, FleetNode } from '../../types'

interface FleetPanelProps {
  onClose: () => void
}

const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 10,
  bottom: 10,
  width: 760,
  maxWidth: 'calc(100vw - 320px)',
  minWidth: 520,
  zIndex: 140,
  display: 'flex',
  flexDirection: 'column',
  border: `1px solid ${SLATE.border}`,
  borderRadius: 6,
  background: SLATE.bg,
  boxShadow: '0 20px 70px rgba(0,0,0,0.68)',
  overflow: 'hidden',
  fontFamily: mono,
}

const stripStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  padding: '9px 14px',
  borderBottom: `1px solid ${SLATE.border}`,
  background: SLATE.surface,
  color: SLATE.muted,
  fontSize: 11,
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 14px',
  borderBottom: `1px solid ${SLATE.border}`,
  background: '#0b0b0e',
}

const headerGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '84px minmax(0,1fr) 190px',
  gap: 14,
  alignItems: 'center',
}

const rowStyle: CSSProperties = {
  ...headerGrid,
  width: '100%',
  border: 0,
  borderLeft: '2px solid transparent',
  borderBottom: `1px solid ${SLATE.border}`,
  background: 'transparent',
  color: SLATE.text,
  padding: '13px 14px',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: mono,
}

function buttonStyle(active = false, disabled = false): CSSProperties {
  return {
    border: `1px solid ${active ? AMBER[700] : SLATE.border}`,
    background: active ? `${AMBER[900]}66` : 'transparent',
    color: active ? AMBER[300] : SLATE.text,
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'default' : 'pointer',
    borderRadius: 3,
    padding: '5px 9px',
    fontSize: 11,
    fontFamily: mono,
    userSelect: 'none',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }
}

function inputStyle(): CSSProperties {
  return {
    background: SLATE.bg,
    border: `1px solid ${SLATE.border}`,
    borderRadius: 3,
    color: SLATE.textBright,
    padding: '6px 8px',
    fontSize: 11,
    fontFamily: mono,
    outline: 'none',
  }
}

function stateDot(state: unknown): CSSProperties {
  const color = semanticColor(state)
  return {
    display: 'inline-block',
    width: 7,
    height: 7,
    borderRadius: 999,
    background: color,
    boxShadow: String(state || '').toLowerCase() === 'idle' || String(state || '').toLowerCase() === 'offline' ? 'none' : `0 0 7px ${color}`,
    flex: 'none',
  }
}

function ago(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return '—'
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return raw
  const delta = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (delta < 60) return `${delta}s`
  const minutes = Math.round(delta / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function truncate(value: unknown, max = 96): string {
  const raw = String(value || '').trim()
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}

function shortId(value: unknown): string {
  const raw = String(value || '').trim()
  return raw.length > 24 ? `${raw.slice(0, 10)}…${raw.slice(-8)}` : raw
}

function recordValue(record: Record<string, unknown> | null | undefined, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const raw = String(value ?? '').trim()
    if (raw) return raw
  }
  return ''
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

interface UsageBucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  promptTotal: number
  estimateUSD: number
  hasTokens: boolean
}

interface AgentUsage {
  meteredUSD: number
  session: UsageBucket
  weekly: UsageBucket
  provider: string
  model: string
  status: string
  source: string
}

function abbr(value: number): string {
  const n = Number(value || 0)
  const abs = Math.abs(n)
  if (!Number.isFinite(n) || abs <= 0) return '0'
  if (abs >= 1_000_000_000) return `${trimFixed(n / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `${trimFixed(n / 1_000_000)}M`
  if (abs >= 1_000) return `${trimFixed(n / 1_000)}k`
  return String(Math.round(n))
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

function formatBytes(value: unknown): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return Math.round(value).toLocaleString()
}

function formatUSD(value: number, zeroAsDash = true): string {
  if (!Number.isFinite(value)) return '—'
  if (value <= 0) return zeroAsDash ? '—' : '$0.000'
  return `$${value.toFixed(3)}`
}

function sessionId(agent: FleetAgent | null): string {
  if (!agent) return ''
  return firstString(agent.session?.session_id, agent.metadata?.session_id)
}

function agentTitle(agent: FleetAgent): string {
  return firstString(agent.session?.title, agent.metadata?.session_title, recordValue(agent.task, 'label'), agent.agent_id)
}

function agentHost(agent: FleetAgent): string {
  return firstString(agent.node, agent.host, 'unknown')
}

function agentKind(agent: FleetAgent): string {
  const rawKind = String(agent.kind || 'agent').toLowerCase()
  const name = rawKind === 'nanohermes' ? 'NanoHermes' : rawKind === 'hermes' ? 'Hermes' : (agent.kind || 'agent')
  const mode = String(agent.metadata?.mode || '').toLowerCase()
  if ((rawKind === 'hermes' || rawKind === 'nanohermes') && (mode === 'interactive' || mode === 'chat')) {
    return `${name} ${mode === 'chat' ? 'chat' : 'interactive'}`
  }
  return name
}

function activity(agent: FleetAgent): string {
  return firstString(agent.metadata?.runtime_activity, agent.metadata?.activity, agent.session?.runtime_activity)
}

function isOnlineFleetNode(node: FleetNode): boolean {
  return String(node.state || '').toLowerCase() !== 'offline'
}

function normalizeUsage(values: {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  reasoning?: unknown
  promptTotal?: unknown
  estimateUSD?: unknown
}): UsageBucket {
  const input = firstNumber(values.input)
  const output = firstNumber(values.output)
  const cacheRead = firstNumber(values.cacheRead)
  const cacheWrite = firstNumber(values.cacheWrite)
  const reasoning = firstNumber(values.reasoning)
  const rawPromptTotal = Number(values.promptTotal)
  const promptTotal = Number.isFinite(rawPromptTotal) && rawPromptTotal > 0 ? rawPromptTotal : input + cacheRead + cacheWrite
  const estimateUSD = firstNumber(values.estimateUSD)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    promptTotal,
    estimateUSD,
    hasTokens: input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 || reasoning > 0 || promptTotal > 0,
  }
}

function usage(agent: FleetAgent): AgentUsage {
  const meta = agent.metadata || {}
  const cost = asRecord(agent.cost)
  const rawUsage = asRecord(recordValue(agent as unknown as Record<string, unknown>, 'usage'))
  const sessionUsage = asRecord(recordValue(rawUsage, 'session'))
  const weeklyUsage = asRecord(recordValue(rawUsage, 'd7') || recordValue(rawUsage, 'week') || recordValue(rawUsage, 'weekly'))
  const session = normalizeUsage({
    input: firstNumber(recordValue(sessionUsage, 'in'), recordValue(sessionUsage, 'input'), recordValue(cost, 'tokens_in'), meta.input_tokens),
    output: firstNumber(recordValue(sessionUsage, 'out'), recordValue(sessionUsage, 'output'), recordValue(cost, 'tokens_out'), meta.output_tokens),
    cacheRead: firstNumber(recordValue(sessionUsage, 'cache_read'), recordValue(sessionUsage, 'cacheRead'), meta.cache_read_tokens),
    cacheWrite: firstNumber(recordValue(sessionUsage, 'cache_write'), recordValue(sessionUsage, 'cacheWrite'), meta.cache_write_tokens),
    reasoning: firstNumber(recordValue(sessionUsage, 'reasoning'), recordValue(sessionUsage, 'reasoning_tokens'), meta.reasoning_tokens),
    promptTotal: firstNumber(recordValue(sessionUsage, 'prompt_total'), recordValue(sessionUsage, 'promptTotal'), meta.prompt_total_tokens),
    estimateUSD: firstNumber(recordValue(sessionUsage, 'est_usd'), recordValue(sessionUsage, 'estimate_usd'), recordValue(sessionUsage, 'estimateUSD'), recordValue(cost, 'session_est'), meta.api_estimate_session_usd),
  })
  const weekly = normalizeUsage({
    input: firstNumber(recordValue(weeklyUsage, 'in'), recordValue(weeklyUsage, 'input'), meta.weekly_input_tokens),
    output: firstNumber(recordValue(weeklyUsage, 'out'), recordValue(weeklyUsage, 'output'), meta.weekly_output_tokens),
    cacheRead: firstNumber(recordValue(weeklyUsage, 'cache_read'), recordValue(weeklyUsage, 'cacheRead'), meta.weekly_cache_read_tokens),
    cacheWrite: firstNumber(recordValue(weeklyUsage, 'cache_write'), recordValue(weeklyUsage, 'cacheWrite'), meta.weekly_cache_write_tokens),
    reasoning: firstNumber(recordValue(weeklyUsage, 'reasoning'), recordValue(weeklyUsage, 'reasoning_tokens'), meta.weekly_reasoning_tokens),
    promptTotal: firstNumber(recordValue(weeklyUsage, 'prompt_total'), recordValue(weeklyUsage, 'promptTotal'), meta.weekly_prompt_total_tokens),
    estimateUSD: firstNumber(recordValue(weeklyUsage, 'est_usd'), recordValue(weeklyUsage, 'estimate_usd'), recordValue(weeklyUsage, 'estimateUSD'), recordValue(cost, 'd7_est'), meta.api_estimate_weekly_usd),
  })
  return {
    meteredUSD: firstNumber(recordValue(rawUsage, 'metered_usd'), recordValue(rawUsage, 'meteredUSD'), recordValue(cost, 'usd'), meta.metered_usd, meta.actual_cost_usd),
    session,
    weekly,
    provider: firstString(meta.provider, meta.billing_provider),
    model: firstString(meta.model, meta.api_estimate_model, agent.session?.profile),
    status: firstString(meta.cost_status),
    source: firstString(meta.cost_source, meta.api_estimate_source),
  }
}

function resourceLine(agent: FleetAgent): string {
  const mem = formatBytes(recordValue(agent.resources, 'mem_bytes'))
  const cpu = Number(recordValue(agent.resources, 'cpu_pct'))
  const cpuLine = agent.metadata?.cpu_sampled === 'true' && Number.isFinite(cpu) ? `${cpu.toFixed(1)}% cpu` : 'n/a cpu'
  return `${mem} · ${cpuLine}`
}

function AgentRow({ agent, selected, onSelect }: { agent: FleetAgent; selected: boolean; onSelect: () => void }) {
  const u = usage(agent)
  const act = activity(agent)
  const last = firstString(agent.metadata?.last_user_message, agent.metadata?.last)
  const sid = sessionId(agent)
  return (
    <button
      type="button"
      className="hm-btn"
      onClick={onSelect}
      style={{
        ...rowStyle,
        background: selected ? `${AMBER[900]}22` : 'transparent',
        borderLeftColor: selected ? AMBER[500] : 'transparent',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: semanticColor(agent.state), fontSize: 11, minWidth: 0 }}>
        <span style={stateDot(agent.state)} />
        {agent.state || 'unknown'}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ color: SLATE.muted, fontSize: 11 }}>
          <span style={{ color: AMBER[400] }}>{agentKind(agent)}</span> · {agentHost(agent)} {sid ? `· ${shortId(sid)}` : ''}
        </span>
        <span style={{ display: 'block', color: SLATE.textBright, fontSize: 12.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agentTitle(agent)}
        </span>
        {act && <span style={{ display: 'block', color: AMBER[400], fontSize: 11, marginTop: 2 }}>▸ {act}</span>}
        {last && <span style={{ display: 'block', color: SLATE.dim, fontSize: 10.5, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>last {truncate(last, 120)}</span>}
      </span>
      <span style={{ textAlign: 'right', color: SLATE.muted, fontSize: 10.5, lineHeight: 1.45 }}>
        <span style={{ color: u.session.estimateUSD > 0 ? AMBER[400] : SLATE.muted, fontSize: 13 }}>{u.session.estimateUSD > 0 ? `~${formatUSD(u.session.estimateUSD)} est` : agent.can_inject ? 'message' : 'monitor'}</span>
        <br />
        {u.session.hasTokens ? <>in {abbr(u.session.input)} · out {abbr(u.session.output)}<br />cache {abbr(u.session.cacheRead)} · prompt {abbr(u.session.promptTotal)}</> : resourceLine(agent)}
        {u.meteredUSD > 0 && <><br />metered {formatUSD(u.meteredUSD, false)}</>}
        {u.weekly.estimateUSD > 0 && <><br />7d ~{formatUSD(u.weekly.estimateUSD)}</>}
      </span>
    </button>
  )
}

function DetailKV({ label, value }: { label: string; value: unknown }) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return (
    <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
      <span style={{ color: AMBER[700], minWidth: 58 }}>{label}</span>
      <span style={{ color: SLATE.text, wordBreak: 'break-all' }}>{raw}</span>
    </div>
  )
}

function CostMetric({ label, value, sub, tone = SLATE.textBright }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ border: `1px solid ${SLATE.border}`, borderRadius: 4, padding: '7px 9px', background: '#09090b', minWidth: 0 }}>
      <div style={{ color: SLATE.muted, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
      <div style={{ color: tone, fontSize: 14, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div style={{ color: SLATE.dim, fontSize: 10, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  )
}

function UsageBucketRow({ label, bucket }: { label: string; bucket: UsageBucket }) {
  if (!bucket.hasTokens && bucket.estimateUSD <= 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px repeat(5, minmax(0, 1fr))', gap: 8, padding: '5px 0', borderTop: `1px solid ${SLATE.border}`, alignItems: 'center' }}>
      <span style={{ color: AMBER[700] }}>{label}</span>
      <span>{formatInteger(bucket.input)}</span>
      <span>{formatInteger(bucket.cacheRead)}</span>
      <span>{formatInteger(bucket.promptTotal)}</span>
      <span>{formatInteger(bucket.output)}</span>
      <span style={{ color: bucket.estimateUSD > 0 ? AMBER[400] : SLATE.muted }}>{bucket.estimateUSD > 0 ? `~${formatUSD(bucket.estimateUSD)}` : '—'}</span>
    </div>
  )
}

function AgentCostView({ agent }: { agent: FleetAgent }) {
  const u = usage(agent)
  const provenance = [u.provider, u.model, u.status, u.source].filter(Boolean).join(' · ')
  return (
    <div style={{ marginTop: 12, border: `1px solid ${SLATE.border}`, borderRadius: 4, background: SLATE.bg, color: SLATE.text, fontSize: 10.5, padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
        <span style={{ color: AMBER[400], fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>token usage</span>
        <span style={{ color: SLATE.muted }}>metered {formatUSD(u.meteredUSD, false)}</span>
        {provenance && <span style={{ color: SLATE.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provenance}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '72px repeat(5, minmax(0, 1fr))', gap: 8, color: SLATE.muted, textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 9.5, paddingBottom: 4 }}>
        <span>window</span><span>in</span><span>cache read</span><span>prompt total</span><span>out</span><span>est</span>
      </div>
      <UsageBucketRow label="session" bucket={u.session} />
      <UsageBucketRow label="7d" bucket={u.weekly} />
    </div>
  )
}

export function FleetPanel({ onClose }: FleetPanelProps) {
  const store = useFleetStore()
  const [message, setMessage] = useState('')
  const [sessionOverride, setSessionOverride] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    store.startPolling()
    return () => store.stopPolling()
  }, [])

  const agents = store.agents
  const fallbackNodes = useMemo(() => store.nodes.filter(isOnlineFleetNode), [store.nodes])
  const hiddenOfflineNodeCount = Math.max(0, store.nodes.length - fallbackNodes.length)
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agent_id === store.selectedAgentId) || null,
    [agents, store.selectedAgentId],
  )

  useEffect(() => {
    setSessionOverride(sessionId(selectedAgent))
  }, [selectedAgent?.agent_id])

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents
    return agents.filter((agent) => [
      agent.agent_id,
      agent.kind,
      agent.host,
      agent.node,
      agent.state,
      agentTitle(agent),
      sessionId(agent),
      JSON.stringify(agent.metadata || {}),
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(q)))
  }, [agents, query])

  const summary = useMemo(() => {
    const states = agents.reduce<Record<string, number>>((acc, agent) => {
      const key = String(agent.state || 'unknown').toLowerCase()
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    const totals = agents.reduce((acc, agent) => {
      const u = usage(agent)
      acc.mem += firstNumber(recordValue(agent.resources, 'mem_bytes'))
      acc.meteredUSD += u.meteredUSD
      acc.sessionEstimateUSD += u.session.estimateUSD
      acc.weeklyEstimateUSD += u.weekly.estimateUSD
      acc.input += u.session.input
      acc.output += u.session.output
      acc.cache += u.session.cacheRead + u.session.cacheWrite
      acc.promptTotal += u.session.promptTotal
      return acc
    }, { mem: 0, meteredUSD: 0, sessionEstimateUSD: 0, weeklyEstimateUSD: 0, input: 0, output: 0, cache: 0, promptTotal: 0 })
    return { running: states.running || 0, idle: states.idle || 0, offline: states.offline || 0, stuck: states.stuck || 0, ...totals }
  }, [agents])

  const logs = selectedAgent ? store.logsByAgent[selectedAgent.agent_id] || '' : ''
  const canInjectTarget = !!selectedAgent?.can_inject && store.config.admin_token_configured
  const canInject = canInjectTarget && !!message.trim()
  const disabledReason = !selectedAgent ? 'select' : !selectedAgent.can_inject ? 'monitor-only' : !store.config.admin_token_configured ? 'no token' : ''

  const sendMessage = async (raw: string) => {
    const text = raw.trim()
    if (!selectedAgent || !canInjectTarget || !text) return
    try {
      await store.injectAgent(selectedAgent.agent_id, text, sessionOverride)
      setMessage('')
      useToastStore.getState().show('fleet message sent')
    } catch {
      useToastStore.getState().show('fleet message failed')
    }
  }

  const status = store.status
  const configured = store.config.enabled

  return (
    <div style={panelStyle}>
      <div style={stripStyle}>
        <span style={{ color: AMBER[400], fontWeight: 700 }}>▮ fleet</span>
        <span>agents <b style={{ color: SLATE.textBright }}>{status?.agents ?? agents.length}</b></span>
        <span style={{ color: SLATE.border }}>·</span>
        <span>run <b style={{ color: SLATE.success }}>{summary.running}</b></span>
        <span style={{ color: SLATE.border }}>·</span>
        <span>idle <b style={{ color: SLATE.textBright }}>{summary.idle}</b></span>
        <span style={{ color: SLATE.border }}>·</span>
        <span>sessions <b style={{ color: AMBER[300] }}>{status?.sessions ?? store.sessions.length}</b></span>
        <span style={{ color: SLATE.border }}>·</span>
        <span>nodes <b style={{ color: SLATE.textBright }}>{fallbackNodes.length === store.nodes.length ? (status?.nodes ?? store.nodes.length) : `${fallbackNodes.length}/${status?.nodes ?? store.nodes.length}`}</b></span>
        <span style={{ color: SLATE.border }}>·</span>
        <span>mem <b style={{ color: SLATE.textBright }}>{formatBytes(summary.mem)}</b></span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: store.error ? SLATE.danger : AMBER[400] }}>
          <span style={{ ...stateDot(store.error ? 'error' : 'running'), width: 6, height: 6 }} />
          {store.loading ? 'sync' : store.error ? 'error' : 'live'}
        </span>
        <button type="button" className="hm-btn" onClick={() => void store.refreshSnapshot()} style={buttonStyle(false, store.loading)}>
          refresh
        </button>
        <button type="button" className="hm-btn" onClick={onClose} style={buttonStyle()}>
          close
        </button>
      </div>

      {store.error && <div style={{ padding: '8px 14px', color: SLATE.danger, borderBottom: `1px solid ${SLATE.border}`, fontSize: 11 }}>{store.error}</div>}

      {!configured ? (
        <div style={{ padding: 18, color: SLATE.text, fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ color: AMBER[400], fontWeight: 700, marginBottom: 8 }}>fleet disabled</div>
          <pre style={{ margin: 0, color: SLATE.textBright, background: SLATE.surface, border: `1px solid ${SLATE.border}`, borderRadius: 4, padding: 10, overflow: 'auto' }}>{`HERMELIN_FLEET_MODE=external
HERMELIN_FLEET_URL=http://127.0.0.1:8080
HERMELIN_FLEET_SERVICE_TOKEN=...`}</pre>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, padding: '8px 14px', borderBottom: `1px solid ${SLATE.border}`, background: '#07070a' }}>
            <CostMetric label="metered" value={formatUSD(summary.meteredUSD, false)} sub="actual / provider billed" tone={summary.meteredUSD > 0 ? AMBER[300] : SLATE.textBright} />
            <CostMetric label="session est" value={summary.sessionEstimateUSD > 0 ? `~${formatUSD(summary.sessionEstimateUSD)}` : '—'} sub={`in ${abbr(summary.input)} · out ${abbr(summary.output)}`} tone={summary.sessionEstimateUSD > 0 ? AMBER[300] : SLATE.textBright} />
            <CostMetric label="7d est" value={summary.weeklyEstimateUSD > 0 ? `~${formatUSD(summary.weeklyEstimateUSD)}` : '—'} sub="API-equivalent rolling estimate" tone={summary.weeklyEstimateUSD > 0 ? AMBER[300] : SLATE.textBright} />
            <CostMetric label="prompt tokens" value={abbr(summary.promptTotal)} sub={`cache ${abbr(summary.cache)}`} />
          </div>

          <div style={toolbarStyle}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="/ filter — agent, host, session"
              autoComplete="off"
              style={{ ...inputStyle(), flex: 1, minWidth: 160 }}
            />
            <span style={{ color: store.config.admin_token_configured ? SLATE.success : SLATE.muted, border: `1px solid ${SLATE.border}`, borderRadius: 3, padding: '5px 8px', fontSize: 11 }}>
              {store.config.admin_token_configured ? 'auth' : 'guest'}
            </span>
            <span style={{ color: SLATE.muted, fontSize: 11 }}>inject {store.capabilities.inject_agents?.length || 0}</span>
          </div>

          <div style={{ ...headerGrid, padding: '8px 14px', borderBottom: `1px solid ${SLATE.border}`, color: SLATE.muted, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <div>state</div>
            <div>host · task</div>
            <div style={{ textAlign: 'right' }}>usage · cost</div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {filteredAgents.length ? filteredAgents.map((agent) => (
              <AgentRow
                key={agent.agent_id}
                agent={agent}
                selected={agent.agent_id === selectedAgent?.agent_id}
                onSelect={() => store.selectAgent(agent.agent_id)}
              />
            )) : fallbackNodes.length ? (
              <>
                {fallbackNodes.map((node) => (
                  <div
                    key={`node:${node.node}`}
                    style={{
                      ...rowStyle,
                      gridTemplateColumns: '84px minmax(0,1fr) 190px',
                      cursor: 'default',
                      color: SLATE.text,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: semanticColor(node.state), fontSize: 11, minWidth: 0 }}>
                      <span style={stateDot(node.state)} />
                      {node.state || 'unknown'}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ color: AMBER[400], fontSize: 11 }}>Online Fleet host</span>
                      <span style={{ display: 'block', color: SLATE.textBright, fontSize: 12.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {node.node || 'unknown'}
                      </span>
                      <span style={{ display: 'block', color: SLATE.dim, fontSize: 10.5, marginTop: 3 }}>
                        last heartbeat {ago(node.last_heartbeat)} ago · agents {node.agent_count ?? 0}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right', color: SLATE.muted, fontSize: 10.5, lineHeight: 1.45 }}>
                      {node.capabilities?.length ? `${node.capabilities.length} caps` : 'host'}
                      <br />
                      runtime start is in the topbar menu
                    </span>
                  </div>
                ))}
                {hiddenOfflineNodeCount > 0 && <div style={{ padding: '9px 14px', color: SLATE.dim, fontSize: 10.5 }}>{hiddenOfflineNodeCount} offline Fleet host{hiddenOfflineNodeCount === 1 ? '' : 's'} hidden</div>}
              </>
            ) : <div style={{ padding: 22, color: SLATE.muted, fontSize: 12 }}>{hiddenOfflineNodeCount > 0 ? `${hiddenOfflineNodeCount} offline Fleet host${hiddenOfflineNodeCount === 1 ? '' : 's'} hidden; no online agents or hosts` : 'no matching agents or hosts'}</div>}
          </div>

          <div style={{ borderTop: `1px solid ${SLATE.border}`, background: '#0b0b0d', padding: 14, maxHeight: '43%', overflow: 'auto' }}>
            {selectedAgent ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '5px 16px', color: SLATE.text, fontSize: 11 }}>
                  <DetailKV label="type" value={agentKind(selectedAgent)} />
                  <DetailKV label="pid" value={recordValue(selectedAgent.resources, 'pid') || selectedAgent.metadata?.pid} />
                  <DetailKV label="host" value={agentHost(selectedAgent)} />
                  <DetailKV label="model" value={selectedAgent.metadata?.model || selectedAgent.session?.profile} />
                  <DetailKV label="profile" value={selectedAgent.metadata?.profile || selectedAgent.session?.profile} />
                  <DetailKV label="session" value={sessionOverride} />
                  <DetailKV label="activity" value={activity(selectedAgent)} />
                  <DetailKV label="messages" value={selectedAgent.metadata?.messages || selectedAgent.session?.message_count} />
                </div>

                <AgentCostView agent={selectedAgent} />

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                  {['Go ahead', 'Continue', 'Commit and Push'].map((text) => (
                    <button key={text} type="button" className="hm-btn" disabled={!canInjectTarget || !!store.injectingAgentId} onClick={() => void sendMessage(text)} style={buttonStyle(false, !canInjectTarget || !!store.injectingAgentId)}>
                      {text}
                    </button>
                  ))}
                  <input
                    value={sessionOverride}
                    onChange={(event) => setSessionOverride(event.target.value)}
                    placeholder="session"
                    style={{ ...inputStyle(), width: 190 }}
                  />
                  <button
                    type="button"
                    className="hm-btn"
                    disabled={store.logsLoadingAgentId === selectedAgent.agent_id}
                    onClick={() => void store.fetchLogs(selectedAgent.agent_id)}
                    style={buttonStyle(false, store.logsLoadingAgentId === selectedAgent.agent_id)}
                  >
                    logs
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, marginTop: 8 }}>
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder={disabledReason || 'message'}
                    rows={2}
                    style={{ ...inputStyle(), resize: 'vertical', minHeight: 44, lineHeight: 1.45 }}
                  />
                  <button type="button" className="hm-btn" disabled={!canInject || !!store.injectingAgentId} onClick={() => void sendMessage(message)} style={{ ...buttonStyle(canInject, !canInject || !!store.injectingAgentId), alignSelf: 'stretch' }}>
                    {store.injectingAgentId ? 'sending' : 'send'}
                  </button>
                </div>

                <pre style={{ margin: '10px 0 0', minHeight: 72, maxHeight: 180, overflow: 'auto', background: SLATE.bg, border: `1px solid ${SLATE.border}`, borderRadius: 3, padding: 10, color: logs ? SLATE.text : SLATE.muted, fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                  {logs || 'no logs'}
                </pre>
              </>
            ) : (
              <div style={{ color: SLATE.muted, fontSize: 12 }}>select an agent</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
