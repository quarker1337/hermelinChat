const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const COMPILED_ROOT = process.env.HERMELIN_FRONTEND_CJS_ROOT || '/tmp/hermelin-frontend-cjs'

function ensureCompiledRoot() {
  assert.ok(fs.existsSync(COMPILED_ROOT), `compiled frontend output not found: ${COMPILED_ROOT}`)
}

function clearCompiledModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(COMPILED_ROOT)) delete require.cache[key]
  }
}

function loadCompiled(relativePath) {
  ensureCompiledRoot()
  return require(path.join(COMPILED_ROOT, relativePath))
}

function jsonResponse(data, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return data
    },
  }
}

test('api client reports malformed server responses without leaking a JSON parser exception', async () => {
  clearCompiledModules()
  const originalFetch = global.fetch
  global.fetch = async () => ({
    status: 502,
    ok: false,
    async json() {
      throw new SyntaxError('JSON.parse: unexpected character at line 1 column 1')
    },
  })

  try {
    const { apiCall, ApiError } = loadCompiled('api/client.js')
    await assert.rejects(
      () => apiCall('/api/fleet/snapshot'),
      (err) => {
        assert.ok(err instanceof ApiError)
        assert.equal(err.status, 502)
        assert.equal(err.message, 'server returned an invalid JSON response (http 502)')
        assert.doesNotMatch(err.message, /JSON\.parse/)
        return true
      },
    )
  } finally {
    global.fetch = originalFetch
  }
})

test('fleet store normalizes disabled config without probing bridge endpoints', async () => {
  clearCompiledModules()
  const calls = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} })
    assert.equal(String(url), '/api/fleet/config')
    return jsonResponse({ mode: 'off', enabled: false, configured: false, available: false, admin_token_configured: false })
  }

  try {
    const { useFleetStore, normalizeFleetConfig } = loadCompiled('stores/fleet.js')
    assert.deepEqual(normalizeFleetConfig(null), {
      mode: 'off',
      enabled: false,
      configured: false,
      available: false,
      admin_token_configured: false,
    })

    useFleetStore.getState().reset()
    await useFleetStore.getState().refreshSnapshot()

    assert.equal(calls.length, 1)
    assert.equal(useFleetStore.getState().config.enabled, false)
    assert.equal(useFleetStore.getState().agents.length, 0)
    assert.equal(useFleetStore.getState().selectedAgentId, null)
  } finally {
    useFleetStoreSafeReset()
    global.fetch = originalFetch
  }
})

test('fleet store refreshes bridge data and injects without browser-side token handling', async () => {
  clearCompiledModules()
  const calls = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    const path = String(url)
    calls.push({ url: path, opts: opts || {} })
    if (path === '/api/fleet/config') {
      return jsonResponse({ mode: 'external', enabled: true, configured: true, available: true, admin_token_configured: true })
    }
    if (path === '/api/fleet/snapshot') {
      return jsonResponse({
        config: { mode: 'external', enabled: true, configured: true, available: true, admin_token_configured: true },
        status: { ok: true, nodes: 1, agents: 3, sessions: 1, capabilities: ['inject_task'] },
        nodes: [{ node: 'node-a', state: 'running', agent_count: 1, agent_ids: ['agent-1'], capabilities: ['inject_task'], state_counts: { idle: 1 } }],
        agents: [
          { agent_id: 'raw-process-1', kind: 'hermes', host: 'node-a', node: 'node-a', state: 'idle', capabilities: [], can_inject: false, session: null },
          { agent_id: 'agent-1', kind: 'hermes', host: 'node-a', node: 'node-a', state: 'idle', capabilities: ['inject_task'], can_inject: true, session: { session_id: 'sess-1', title: 'Fleet smoke' } },
          { agent_id: 'raw-process-2', kind: 'hermes', host: 'node-b', node: 'node-b', state: 'running', capabilities: [], can_inject: false, session: null },
        ],
        runtimes: { runtimes: [{ runtime_id: 'remote-rt-1', node: 'node-a', title: 'Remote Hermes', profile: 'fleet', cwd: '/home/test', state: 'idle', source: 'fleet_remote', backend: 'fleet-tmux', can_attach: true, can_stop: true }] },
        sessions: [{ session_id: 'sess-1', title: 'Fleet smoke', state: 'idle', agent_id: 'agent-1', agent_ids: ['agent-1'], nodes: ['node-a'], capabilities: ['inject_task'], can_inject: true }],
        capabilities: { verbs: ['inject_task'], by_kind: { hermes: ['inject_task'] }, by_node: { 'node-a': ['inject_task'] }, by_agent: [{ agent_id: 'agent-1', kind: 'hermes', node: 'node-a', verbs: ['inject_task'] }], inject_agents: ['agent-1'] },
      })
    }
    if (path === '/api/fleet/agents/agent-1/inject') {
      assert.equal(opts.method, 'POST')
      assert.deepEqual(JSON.parse(opts.body), { message: 'Continue', session_id: 'sess-1' })
      assert.equal(JSON.stringify(opts.headers || {}).includes('server-token'), false)
      return jsonResponse({ agent_id: 'agent-1', result: { ok: true } })
    }
    throw new Error(`unexpected fetch: ${path}`)
  }

  try {
    const { useFleetStore } = loadCompiled('stores/fleet.js')
    useFleetStore.getState().reset()

    await useFleetStore.getState().refreshSnapshot()
    assert.equal(useFleetStore.getState().selectedAgentId, 'agent-1')
    assert.equal(useFleetStore.getState().nodes[0].node, 'node-a')
    assert.equal(useFleetStore.getState().runtimes[0].runtime_id, 'remote-rt-1')
    assert.equal(useFleetStore.getState().runtimes[0].node, 'node-a')
    assert.equal(useFleetStore.getState().capabilities.inject_agents[0], 'agent-1')
    assert.deepEqual(calls.map((call) => call.url), ['/api/fleet/config', '/api/fleet/snapshot'])

    await useFleetStore.getState().injectAgent('agent-1', ' Continue ', 'sess-1')
    const injectCall = calls.find((call) => call.url === '/api/fleet/agents/agent-1/inject')
    assert.ok(injectCall, 'inject endpoint was called')
  } finally {
    useFleetStoreSafeReset()
    global.fetch = originalFetch
  }
})


test('fleet polling backoff is bounded and jittered after failures', () => {
  clearCompiledModules()
  const { fleetBackoffDelay } = loadCompiled('stores/fleet.js')
  assert.equal(fleetBackoffDelay(1, () => 0), 5_000)
  assert.equal(fleetBackoffDelay(2, () => 0), 10_000)
  assert.equal(fleetBackoffDelay(3, () => 0), 30_000)
  assert.equal(fleetBackoffDelay(4, () => 0), 60_000)
  assert.equal(fleetBackoffDelay(99, () => 1), 72_000)
})

test('disabled Fleet mode hides cockpit and remote runtime surfaces', () => {
  const shell = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/AppShell.tsx'), 'utf8')
  const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/fleet/FleetPanel.tsx'), 'utf8')
  assert.match(shell, /\{fleetConfig\.enabled && \(\s*<div style=\{\{ marginTop: 12/)
  assert.match(shell, /\{fleetConfig\.enabled && \(\s*<button/)
  assert.doesNotMatch(panel, /config\.base_url/)
  assert.doesNotMatch(panel, /window\.open/)
})


test('fleet panel stays above terminal chrome and shows only online host fallback when there are no agent rows', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/fleet/FleetPanel.tsx'), 'utf8')
  const z = source.match(/zIndex:\s*(\d+)/)
  assert.ok(z, 'FleetPanel should define a z-index')
  assert.ok(Number(z[1]) > 80, 'FleetPanel should stack above the AppShell topbar/runtime menu layer')
  assert.match(source, /store\.nodes\.filter\(isOnlineFleetNode\)/, 'FleetPanel should filter node fallback rows to online hosts')
  assert.match(source, /fallbackNodes\.length \?/, 'FleetPanel should render host fallback rows from filtered nodes when agents are empty')
  assert.match(source, /Online Fleet host/, 'FleetPanel host fallback rows should be labeled as online hosts')
  assert.match(source, /offline Fleet host\{hiddenOfflineNodeCount === 1 \? '' : 's'\} hidden/, 'FleetPanel should summarize hidden offline node heartbeats')
})

test('fleet panel restores compact cost summary and selected-agent usage drawer', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/fleet/FleetPanel.tsx'), 'utf8')
  assert.match(source, /function usage\(agent: FleetAgent\): AgentUsage/, 'FleetPanel should normalize per-agent cost and token usage')
  assert.match(source, /recordValue\(rawUsage, 'metered_usd'\)/, 'usage should support normalized metered usage payloads')
  assert.match(source, /meta\.api_estimate_session_usd/, 'usage should support session API-equivalent estimates from Fleet metadata')
  assert.match(source, /meta\.api_estimate_weekly_usd/, 'usage should support 7d API-equivalent estimates from Fleet metadata')
  assert.match(source, /<CostMetric label="metered"/, 'FleetPanel should render fleet-wide metered cost')
  assert.match(source, /<CostMetric label="session est"/, 'FleetPanel should render fleet-wide session estimate')
  assert.match(source, /<CostMetric label="7d est"/, 'FleetPanel should render fleet-wide rolling estimate')
  assert.match(source, /<CostMetric label="prompt tokens"/, 'FleetPanel should render compact token totals')
  assert.match(source, /<AgentCostView agent=\{selectedAgent\} \/>/, 'selected drawer should include exact cost / usage table')
  assert.match(source, /usage · cost/, 'row rail header should advertise usage and cost')
  assert.match(source, /~\$\{formatUSD\(u\.session\.estimateUSD\)\} est/, 'row rail should show the single session estimate calculation')
  assert.match(source, /cache \{abbr\(u\.session\.cacheRead\)\} · prompt \{abbr\(u\.session\.promptTotal\)\}/, 'row rail should show cache-read and prompt-total calculations')
  assert.match(source, /7d ~\{formatUSD\(u\.weekly\.estimateUSD\)\}/, 'row rail should show the single 7d estimate calculation')
  assert.match(source, /function formatInteger\(value: number\): string/, 'selected drawer should use exact integer token formatting')
  assert.match(source, /function trimFixed\(value: number\): string/, 'abbreviated row rail token counts should preserve one decimal like Fleetmanager')
  assert.match(source, /trimFixed\(n \/ 1_000_000\)\}M/, 'million-scale token abbreviations should use uppercase M with one decimal')
  assert.match(source, /<span>window<\/span><span>in<\/span><span>cache read<\/span><span>prompt total<\/span><span>out<\/span><span>est<\/span>/, 'selected drawer should expose the old session/7d token table columns')
  assert.match(source, /<UsageBucketRow label="session" bucket=\{u\.session\} \/>/, 'selected drawer should include a session usage row')
  assert.match(source, /<UsageBucketRow label="7d" bucket=\{u\.weekly\} \/>/, 'selected drawer should include a 7d usage row')
})

test('remote Fleet runtime create propagates the active HermelinChat theme as Hermes skin', async () => {
  clearCompiledModules()
  const calls = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    const requestPath = String(url)
    calls.push({ url: requestPath, opts })
    if (requestPath === '/api/fleet/nodes/node-a/runtimes') {
      assert.equal(opts.method, 'POST')
      assert.deepEqual(JSON.parse(opts.body), { title: 'Hermes 1', ui_theme: 'nous', skin: 'nous' })
      return jsonResponse({ runtime: { runtime_id: 'remote-nous', node: 'node-a', title: 'Hermes 1', profile: 'default', cwd: '/home/test', state: 'idle', source: 'fleet_remote', backend: 'fleet-tmux', can_attach: true, can_stop: true } })
    }
    throw new Error(`unexpected fetch: ${requestPath}`)
  }

  try {
    const { useFleetStore, hermesSkinForUiTheme } = loadCompiled('stores/fleet.js')
    assert.equal(hermesSkinForUiTheme('nous'), 'nous')
    assert.equal(hermesSkinForUiTheme('unknown-theme'), '')
    useFleetStore.getState().reset()
    const runtime = await useFleetStore.getState().createRuntime('node-a', 'Hermes 1', { uiTheme: 'nous' })
    assert.equal(runtime.runtime_id, 'remote-nous')
    assert.ok(calls.some((call) => call.url === '/api/fleet/nodes/node-a/runtimes'))
  } finally {
    useFleetStoreSafeReset()
    if (originalFetch === undefined) delete global.fetch
    else global.fetch = originalFetch
  }
})

function useFleetStoreSafeReset() {
  try {
    const { useFleetStore } = loadCompiled('stores/fleet.js')
    useFleetStore.getState().reset()
  } catch {
    // ignore cleanup failures
  }
}
