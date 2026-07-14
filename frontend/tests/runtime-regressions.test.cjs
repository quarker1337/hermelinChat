const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const COMPILED_ROOT = process.env.HERMELIN_FRONTEND_CJS_ROOT || '/tmp/hermelin-frontend-cjs'
const SOURCE_ROOT = path.resolve(__dirname, '..', 'src')

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

test('terminal websocket URL sends resume to legacy and Fleet attach paths only', () => {
  clearCompiledModules()
  global.window = { location: { protocol: 'https:', host: 'hermelin.test' } }

  try {
    const { buildWsUrl } = loadCompiled('components/terminal/utils.js')

    assert.equal(
      buildWsUrl('20260630_000000_abcdef', { cols: 100, rows: 30, themeId: 'hermelin' }),
      'wss://hermelin.test/ws/pty?resume=20260630_000000_abcdef&cols=100&rows=30&ui_theme=hermelin',
    )
    assert.equal(
      buildWsUrl('20260630_000000_abcdef', { cols: 100, rows: 30, profile: 'otrod' }),
      'wss://hermelin.test/ws/pty?resume=20260630_000000_abcdef&cols=100&rows=30&profile=otrod',
    )
    assert.equal(
      buildWsUrl('20260630_000000_abcdef', { cols: 100, rows: 30, attachPath: '/ws/runtimes/rt-one/attach' }),
      'wss://hermelin.test/ws/runtimes/rt-one/attach?cols=100&rows=30',
    )
    assert.equal(
      buildWsUrl('20260630_000000_abcdef', { cols: 100, rows: 30, attachPath: '/ws/fleet/agents/hermes-pid-123/attach' }),
      'wss://hermelin.test/ws/fleet/agents/hermes-pid-123/attach?resume=20260630_000000_abcdef&cols=100&rows=30',
    )
    assert.equal(
      buildWsUrl('20260630_000000_abcdef', { cols: 100, rows: 30, attachPath: '/ws/fleet/nodes/hanstest3/runtimes/rt-one/attach' }),
      'wss://hermelin.test/ws/fleet/nodes/hanstest3/runtimes/rt-one/attach?cols=100&rows=30',
    )
    assert.equal(
      buildWsUrl(null, { attachPath: 'https://evil.example/ws' }),
      'wss://hermelin.test/ws/pty',
    )
  } finally {
    delete global.window
  }
})

test('runtime store refresh/create is standalone and never calls fleet endpoints', async () => {
  clearCompiledModules()
  const calls = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    const requestPath = String(url)
    calls.push({ url: requestPath, opts })
    assert.equal(requestPath.startsWith('/api/fleet'), false, 'runtime store must not depend on Fleet')

    if (requestPath === '/api/runtimes/config') {
      return jsonResponse({
        enabled: true,
        backend: 'tmux',
        available: true,
        configured_backend: 'auto',
        autostart_default: true,
        profiles: [
          { name: 'default', label: 'default', is_default: true, configured: true },
          { name: 'otrod', label: 'otrod', model: 'xiaomi/mimo-v2.5-pro', configured: true },
        ],
        default_profile: 'default',
      })
    }
    if (requestPath === '/api/runtimes') {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body)
        if (body.title === 'Resume smoke') {
          assert.deepEqual(body, { title: 'Resume smoke', resume: 'sess-1' })
          return jsonResponse({ runtime: { runtime_id: 'rt-resume', title: 'Resume smoke', profile: 'default', cwd: '/tmp', state: 'idle', source: 'user_ui', backend: 'tmux', can_attach: true, can_stop: true, attach_ws_path: '/ws/runtimes/rt-resume/attach' } })
        }
        assert.deepEqual(body, { title: 'Profile smoke', profile: 'otrod' })
        return jsonResponse({ runtime: { runtime_id: 'rt-otrod', title: 'Profile smoke', profile: 'otrod', cwd: '/tmp', state: 'idle', source: 'user_ui', backend: 'tmux', can_attach: true, can_stop: true, attach_ws_path: '/ws/runtimes/rt-otrod/attach' } })
      }
      return jsonResponse({
        runtimes: [
          { runtime_id: 'rt-old', title: 'Old', profile: 'default', cwd: '/tmp', state: 'idle', runtime_activity: 'working', source: 'user_ui', backend: 'tmux', can_attach: true, can_stop: true, attach_ws_path: '/ws/runtimes/rt-old/attach' },
          { runtime_id: 'rt-stopped', title: 'Stopped ghost', profile: 'default', cwd: '/tmp', state: 'stopped', source: 'user_ui', backend: 'tmux', can_attach: false, can_stop: false, attach_ws_path: '/ws/runtimes/rt-stopped/attach' },
          { runtime_id: 'rt-active', title: 'Active', profile: 'default', cwd: '/tmp', state: 'idle', source: 'user_ui', backend: 'tmux', can_attach: true, can_stop: true, attach_ws_path: '/ws/runtimes/rt-active/attach' },
        ],
        last_active_runtime_id: 'rt-active',
      })
    }
    throw new Error(`unexpected fetch ${requestPath}`)
  }

  try {
    const { useAuthStore } = loadCompiled('stores/auth.js')
    const { useRuntimeStore, runtimeAttachPath } = loadCompiled('stores/runtimes.js')
    useAuthStore.setState({ loading: false, enabled: false, authenticated: true, logoutReason: null })
    useRuntimeStore.getState().reset()

    await useRuntimeStore.getState().refresh()
    assert.equal(useRuntimeStore.getState().config.backend, 'tmux')
    assert.deepEqual(useRuntimeStore.getState().config.profiles.map((profile) => profile.name), ['default', 'otrod'])
    assert.equal(useRuntimeStore.getState().activeRuntimeId, 'rt-active')
    const backgroundRuntime = useRuntimeStore.getState().runtimes.find((runtime) => runtime.runtime_id === 'rt-old')
    assert.equal(backgroundRuntime.runtime_activity, 'working', 'background runtime activity must survive API normalization when focus moves elsewhere')
    assert.equal(runtimeAttachPath(useRuntimeStore.getState().runtimes[2]), '/ws/runtimes/rt-active/attach')

    useRuntimeStore.getState().setActiveRuntimeId('rt-old')
    await useRuntimeStore.getState().refresh()
    assert.equal(useRuntimeStore.getState().activeRuntimeId, 'rt-old', 'runtime polling must not stomp a browser-side switch with stale server last-active')

    useRuntimeStore.getState().setActiveRuntimeId('rt-stopped')
    await useRuntimeStore.getState().refresh()
    assert.equal(useRuntimeStore.getState().activeRuntimeId, 'rt-active', 'runtime polling must not preserve a stopped/non-attachable browser-side runtime')

    const created = await useRuntimeStore.getState().createRuntime('Resume smoke', { resumeId: 'sess-1' })
    assert.equal(created.runtime_id, 'rt-resume')
    assert.equal(useRuntimeStore.getState().activeRuntimeId, 'rt-resume')

    const profileRuntime = await useRuntimeStore.getState().createRuntime('Profile smoke', { profile: 'otrod' })
    assert.equal(profileRuntime.runtime_id, 'rt-otrod')
    assert.equal(profileRuntime.profile, 'otrod')
    assert.equal(useRuntimeStore.getState().activeRuntimeId, 'rt-otrod')
    assert.ok(calls.some((call) => call.url === '/api/runtimes' && call.opts.method === 'POST'))
  } finally {
    try {
      const { useRuntimeStore } = loadCompiled('stores/runtimes.js')
      useRuntimeStore.getState().reset()
    } catch {}
    if (originalFetch === undefined) delete global.fetch
    else global.fetch = originalFetch
  }
})

test('runtime menu selection forces a fresh terminal attach cycle', () => {
  const source = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')
  const match = source.match(/const handleSelectRuntime = useCallback\(\(runtimeId: string\) => \{([\s\S]*?)\n  \}, \[\]\)/)
  assert.ok(match, 'handleSelectRuntime callback not found')
  const body = match[1]

  assert.match(body, /setActiveRuntimeId\(rid\)/, 'runtime selection should update active runtime synchronously')
  assert.match(body, /useTerminalStore\.getState\(\)\.spawn\(null\)/, 'runtime selection must force terminal reconnect')
  assert.match(body, /activateRuntime\(rid\)/, 'runtime selection should persist last-active runtime server-side')
})

test('sidebar new session keeps session-store new-session semantics in tmux mode', () => {
  const source = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')
  const match = source.match(/const handleNewSession = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[\]\)/)
  assert.ok(match, 'handleNewSession callback not found')
  const body = match[1]

  assert.match(body, /startNewSession\(\{ spawn: false \}\)/, 'tmux sidebar new session should snapshot session detection before runtime creation')
  assert.match(body, /createRuntime\(`Hermes \$\{count\}`, \{ profile: selectedRuntimeProfile \}\)/, 'tmux sidebar new session should allocate a fresh local runtime with the selected profile')
  assert.match(body, /if \(runtime\) useTerminalStore\.getState\(\)\.spawn\(null\)/, 'tmux sidebar new session should attach only after runtime creation')
  assert.ok(body.indexOf('startNewSession({ spawn: false })') < body.indexOf('createRuntime(`Hermes ${count}`, { profile: selectedRuntimeProfile })'), 'new-session detection baseline must be captured before the runtime starts')
  assert.match(body, /useSessionStore\.getState\(\)\.startNewSession\(\)/, 'legacy sidebar new session should still run session-store new-session flow')
})

test('runtime dropdown is live-only and keeps compact switch affordances', () => {
  const appSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')
  const runtimeSource = fs.readFileSync(path.join(SOURCE_ROOT, 'stores/runtimes.ts'), 'utf8')
  assert.match(runtimeSource, /Runtime polling can race|snap back/i, 'runtime store should document stale polling snapback protection')
  assert.match(runtimeSource, /runtime\.state !== 'stopped' && runtime\.can_attach !== false/, 'runtime store should not select stopped/non-attachable runtimes')
  assert.match(appSource, />\s*refresh\s*<\/button>/, 'runtime dropdown should include a manual refresh action')
  assert.match(appSource, /<span>profile<\/span>/, 'runtime dropdown should expose a local Hermes profile selector')
  assert.match(appSource, /runtimeProfiles\.map\(\(profile\)/, 'runtime dropdown should render Hermes profiles from runtime config')
  assert.match(appSource, /createRuntime\(`Hermes \$\{count\}`, \{ profile: selectedRuntimeProfile \}\)/, 'new local runtime should start with the selected profile')
  assert.match(appSource, /runtime\.profile \|\| 'default'/, 'runtime rows should show the profile actually backing that runtime')
  assert.match(appSource, /liveLocalRuntimes\.map/, 'runtime dropdown should render only live local runtimes')
  assert.doesNotMatch(appSource, /isStopped \? 'stopped'/, 'runtime dropdown should not render stopped local runtimes as disabled rows')
  assert.doesNotMatch(appSource, /stopped runtime.*hidden/i, 'runtime dropdown should not display stopped-runtime counts')
  assert.match(appSource, /active \? 'current' : 'switch'/, 'runtime rows should show explicit current/switch state')
  assert.match(appSource, /width: '100%'/, 'runtime row switch target should span the row')
})

test('zero managed runtimes renders an intentional empty state instead of legacy PTY fallback', () => {
  const appSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')

  assert.match(appSource, /const hasAttachableTerminal = runtimeConfig\.enabled && \(runtimeConfig\.backend !== 'tmux' \|\| Boolean\(activeRuntime \|\| activeFleetRuntimeRecord\)\)/, 'terminal mounting must wait for a successful runtime config load')
  assert.match(appSource, /No Hermes Session Active/)
  assert.match(appSource, /Start New Session/)
  assert.match(appSource, /hasAttachableTerminal \? \(/, 'TerminalPane must mount only for a legacy backend or a live managed runtime')
  assert.match(appSource, /onClick=\{handleNewSession\}/, 'empty-state action must use the normal managed runtime creator')
})

test('sidebar mode defaults to profile-aware history and can persist active runtime navigation', () => {
  const prefsSource = fs.readFileSync(path.join(SOURCE_ROOT, 'utils/ui-prefs.ts'), 'utf8')
  assert.match(prefsSource, /sidebar:\s*\{\s*mode: 'history'/, 'history must remain the default mode')
  assert.match(prefsSource, /sidebar\.mode === 'active' \? 'active' : 'history'/, 'only the two supported modes may be restored')

  const sidebarSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/sidebar/Sidebar.tsx'), 'utf8')
  const appSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')
  const sessionStoreSource = fs.readFileSync(path.join(SOURCE_ROOT, 'stores/sessions.ts'), 'utf8')
  const activeListSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/sidebar/ActiveRuntimeList.tsx'), 'utf8')

  assert.match(sidebarSource, /prefs\.sidebar\.mode/)
  assert.match(sidebarSource, /history/)
  assert.match(sidebarSource, /active/)
  assert.match(sidebarSource, /<ActiveRuntimeList/)
  assert.match(activeListSource, /working/)
  assert.match(activeListSource, /idle/)
  assert.match(activeListSource, /runtime\.runtime_activity/, 'inactive runtime rows must use per-runtime activity from the API')
  assert.match(activeListSource, /onSelectLocal/)
  assert.match(activeListSource, /onSelectRemote/)
  assert.match(sessionStoreSource, /profile: string/)
  assert.match(sessionStoreSource, /\/api\/sessions\?limit=50&profile=/)
  assert.match(appSource, /setSessionProfile\(historyProfile\)/)
  assert.match(appSource, /profile: session\.profile/)
})

test('runtime dropdown stacks above xterm so menus remain selectable and copyable', () => {
  const appSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')
  const terminalSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/terminal/TerminalPane.tsx'), 'utf8')

  const topbarMatch = appSource.match(/Keep topbar\/dropdowns above[\s\S]*?zIndex: (\d+)/)
  const dropdownMatch = appSource.match(/width: 360,[\s\S]*?zIndex: (\d+)/)
  const terminalMatch = terminalSource.match(/padding: '12px 12px 36px 12px',[\s\S]*?zIndex: (\d+)/)

  assert.ok(topbarMatch, 'topbar stacking z-index not found')
  assert.ok(dropdownMatch, 'runtime dropdown stacking z-index not found')
  assert.ok(terminalMatch, 'terminal pane stacking z-index not found')

  assert.ok(Number(topbarMatch[1]) > Number(terminalMatch[1]), 'topbar must stack above TerminalPane/xterm')
  assert.ok(Number(dropdownMatch[1]) > Number(topbarMatch[1]), 'runtime dropdown should stack above the topbar contents')
})

test('runtime dropdown connects Fleet tmux remotes through the normal xterm attach path', () => {
  const appSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/AppShell.tsx'), 'utf8')
  const terminalSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components/terminal/TerminalPane.tsx'), 'utf8')
  const fleetStoreSource = fs.readFileSync(path.join(SOURCE_ROOT, 'stores/fleet.ts'), 'utf8')
  const backendSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'hermelin/server.py'), 'utf8')
  const proxySource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'hermelin/fleet_proxy.py'), 'utf8')

  assert.match(appSource, />Fleet<\/span>/, 'runtime menu should expose a compact Fleet section')
  assert.match(appSource, /remoteFleetRuntimes\.map/, 'runtime menu should render Fleet tmux runtime rows')
  assert.match(appSource, /runtime\.can_attach !== false && runtime\.state !== 'stopped'/, 'runtime menu should hide stale non-attachable Fleet tmux rows')
  assert.match(appSource, /remoteFleetStartNodes\.map/, 'runtime menu should render start-on-host rows even without sessions')
  assert.match(appSource, /handleSelectFleetTmuxRuntime/, 'remote tmux row click handler should exist')
  assert.match(appSource, /handleStartFleetTmuxRuntime/, 'remote host start handler should exist')
  assert.match(appSource, /setActiveFleetRuntimeTarget\(\{ kind: 'runtime'/, 'remote tmux selection should store node/runtime target')
  assert.match(appSource, /useTerminalStore\.getState\(\)\.spawn\(null\)/, 'remote tmux selection should reconnect the normal xterm without DB resume')
  assert.match(appSource, /fleetRuntimeAttachPath/, 'remote tmux rows should derive a websocket attach path')
  assert.match(appSource, /<TerminalPane attachPathOverride=\{activeFleetRuntimeAttachPath\}/, 'main pane should stay the normal xterm terminal')
  assert.doesNotMatch(appSource, /dashboard fallback/, 'node-advertised dashboards must not be exposed as terminal fallbacks')
  assert.doesNotMatch(appSource, /fleetAgentAttachPath/, 'only central-mediated managed runtimes may be attached')

  assert.match(appSource, /const uiTheme = useUiPrefsStore\.getState\(\)\.prefs\.theme/, 'remote runtime create should read the active HermelinChat theme at click time')
  assert.match(appSource, /createRuntime\(safeNode, `Hermes \$\{count\}`, \{ uiTheme \}\)/, 'remote runtime create should send active UI theme to Fleet')
  assert.match(fleetStoreSource, /apiCall<FleetSnapshot>\('\/api\/fleet\/snapshot'\)/, 'Fleet store should poll remote runtimes through the aggregate snapshot')
  assert.match(fleetStoreSource, /apiPost<FleetRuntimeCreateResponse>\(`\/api\/fleet\/nodes\/\$\{encodeURIComponent\(safeNode\)\}\/runtimes`/, 'Fleet store should create remote node runtimes')
  assert.match(fleetStoreSource, /body\.ui_theme = uiTheme/, 'Fleet store should forward UI theme for remote startup skin sync')
  assert.match(fleetStoreSource, /body\.skin = skin/, 'Fleet store should forward normalized Hermes skin for remote startup')
  assert.match(fleetStoreSource, /hermesSkinForUiTheme/, 'Fleet store should map HermelinChat themes to Hermes skins explicitly')
  assert.match(fleetStoreSource, /\/runtimes\/\$\{encodeURIComponent\(rid\)\}\/stop`/, 'Fleet store should stop remote node runtimes')

  assert.match(terminalSource, /attachPathOverride\?: string \| null/, 'TerminalPane should accept an attach-path override')
  assert.match(terminalSource, /const runtimeWsPath = attachPathOverride \|\| selectedRuntimeWsPath/, 'TerminalPane should use remote attach paths without changing UI shell')

  assert.match(proxySource, /@app\.get\("\/api\/fleet\/runtimes"\)/, 'HermelinChat proxy should expose Fleet runtime list')
  assert.match(proxySource, /@app\.post\("\/api\/fleet\/nodes\/\{node\}\/runtimes"\)/, 'HermelinChat proxy should expose remote runtime create')
  assert.match(proxySource, /@app\.post\("\/api\/fleet\/nodes\/\{node\}\/runtimes\/\{runtime_id\}\/stop"\)/, 'HermelinChat proxy should expose remote runtime stop')

  const tmuxRoute = backendSource.match(/@app\.websocket\("\/ws\/fleet\/nodes\/\{node\}\/runtimes\/\{runtime_id\}\/attach"\)[\s\S]*?@app\.websocket\("\/ws\/runtimes\/\{runtime_id\}\/attach"\)/)?.[0] || ''
  assert.match(tmuxRoute, /websockets\.connect\(\s*upstream_url/, 'HermelinChat should proxy remote tmux attach over websocket')
  assert.match(tmuxRoute, /max_size=_FLEET_RUNTIME_ATTACH_MAX_FRAME_BYTES/, 'HermelinChat should bound upstream Fleet websocket frames')
  assert.match(tmuxRoute, /_fleet_runtime_attach_frame_size\(raw\)/, 'HermelinChat should bound browser-to-Fleet websocket frames')
  assert.match(tmuxRoute, /\/nodes\/\{safe_node\}\/runtimes\/\{safe_runtime\}\/attach/, 'HermelinChat should attach to Fleet node runtime websocket')
  assert.match(tmuxRoute, /Authorization.*Bearer/, 'HermelinChat should keep the single-use Fleet attach ticket server-side')
  assert.doesNotMatch(tmuxRoute, /\/api\/pty\?/, 'remote tmux runtime attach should not depend on Hermes dashboard PTY')

  const dashboardRoute = backendSource.match(/@app\.websocket\("\/ws\/fleet\/agents\/\{agent_id\}\/attach"\)[\s\S]*?@app\.websocket\("\/ws\/fleet\/nodes\/\{node\}\/runtimes\/\{runtime_id\}\/attach"\)/)?.[0] || ''
  assert.match(dashboardRoute, /legacy Fleet dashboard attach is disabled/, 'legacy agent attach should fail closed')
  assert.doesNotMatch(dashboardRoute, /dashboard_address|dashboard_token|\/api\/pty\?/, 'agent metadata must not drive an outbound credential-bearing connection')
})
