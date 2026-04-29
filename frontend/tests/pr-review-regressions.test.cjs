const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const COMPILED_ROOT = process.env.HERMELIN_FRONTEND_CJS_ROOT || '/tmp/hermelin-frontend-cjs'
const SOURCE_ROOT = path.resolve(__dirname, '..', 'src')
const UI_PREFS_STORAGE_KEY = 'hermelinChat.uiPrefs'

let assetStubsInstalled = false

function ensureCompiledRoot() {
  assert.ok(fs.existsSync(COMPILED_ROOT), `compiled frontend output not found: ${COMPILED_ROOT}`)
}

function installAssetStubs() {
  if (assetStubsInstalled) return

  const originalResolveFilename = Module._resolveFilename
  const originalLoad = Module._load
  const assetPattern = /\.(css|svg(\?raw)?|png)$/

  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (assetPattern.test(request)) return request
    return originalResolveFilename.call(this, request, parent, isMain, options)
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (assetPattern.test(request)) return request
    return originalLoad.call(this, request, parent, isMain)
  }

  assetStubsInstalled = true
}

function clearCompiledModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(COMPILED_ROOT)) {
      delete require.cache[key]
    }
  }
}

function makeStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]))
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
    clear() {
      values.clear()
    },
  }
}

function makeWindow({ innerWidth = 1400, storageSeed = {} } = {}) {
  const listeners = new Map()

  return {
    innerWidth,
    location: {
      origin: 'https://hermelin.test',
      href: 'https://hermelin.test/',
    },
    localStorage: makeStorage(storageSeed),
    addEventListener(type, handler) {
      const next = listeners.get(type) || []
      next.push(handler)
      listeners.set(type, next)
    },
    removeEventListener(type, handler) {
      const next = (listeners.get(type) || []).filter((entry) => entry !== handler)
      listeners.set(type, next)
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) {
        handler(event)
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(Date.now()), 0)
    },
    cancelAnimationFrame(handle) {
      clearTimeout(handle)
    },
  }
}

function setWindow(windowObject) {
  if (windowObject === undefined) {
    delete global.window
  } else {
    global.window = windowObject
  }
  delete global.document
}

function loadCompiled(relativePath) {
  ensureCompiledRoot()
  return require(path.join(COMPILED_ROOT, relativePath))
}

test('terminal store ignores stale disconnects from an earlier spawn cycle', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().spawn(null)
  const staleNonce = useTerminalStore.getState().spawnNonce

  useTerminalStore.getState().spawn(null)
  const currentNonce = useTerminalStore.getState().spawnNonce

  useTerminalStore.getState().onConnectionChange(false, staleNonce)
  useTerminalStore.getState().onConnectionChange(true, currentNonce)

  assert.equal(useTerminalStore.getState().state.phase, 'detecting')
})

test('terminal store keeps resumeId when a resumed session echoes its session id', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useSessionStore } = loadCompiled('stores/sessions.js')
  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useSessionStore.getState().reset()
  useTerminalStore.getState().reset()

  useTerminalStore.getState().spawn('20260413_134408_76e00f')
  const nonce = useTerminalStore.getState().spawnNonce
  useTerminalStore.getState().onConnectionChange(true, nonce)
  useTerminalStore.getState().onDetectedSessionId('20260413_134408_76e00f')

  assert.deepEqual(useTerminalStore.getState().state, {
    phase: 'connected',
    resumeId: '20260413_134408_76e00f',
  })
  assert.equal(useSessionStore.getState().activeSessionId, '20260413_134408_76e00f')
})

test('video fx store applies saved prefs immediately on startup', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(
    makeWindow({
      storageSeed: {
        [UI_PREFS_STORAGE_KEY]: JSON.stringify({
          videoFx: { enabled: true, intensity: 80, glitchPulses: false },
        }),
      },
    }),
  )

  const { useVideoFxStore } = loadCompiled('stores/video-fx.js')
  const state = useVideoFxStore.getState()

  assert.equal(state.enabled, true)
  assert.equal(state.factor, 0.8)
  assert.notEqual(state.filter, 'none')

  state.stopGlitchLoop()
})

test('opening a search peek closes the artifact panel', async () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { session_id: 'sess-1', messages: [] }
    },
  })

  try {
    const { useAuthStore } = loadCompiled('stores/auth.js')
    const { useArtifactStore } = loadCompiled('stores/artifacts.js')
    const { useSearchStore } = loadCompiled('stores/search.js')

    useAuthStore.setState({ loading: false, enabled: true, authenticated: true })
    useArtifactStore.setState({ panelOpen: true, panelDismissed: false })

    await useSearchStore.getState().openPeek({ id: 'msg-1', session_id: 'sess-1' })

    assert.equal(useSearchStore.getState().peek.open, true)
    assert.equal(useArtifactStore.getState().panelOpen, false)
  } finally {
    if (originalFetch === undefined) delete global.fetch
    else global.fetch = originalFetch
  }
})

test('artifact panel width re-clamps when the window shrinks', () => {
  installAssetStubs()
  clearCompiledModules()
  const windowObject = makeWindow({ innerWidth: 1400 })
  setWindow(windowObject)

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')

  useArtifactStore.getState().setPanelWidth(700)
  assert.equal(useArtifactStore.getState().panelWidth, 700)

  windowObject.innerWidth = 600
  windowObject.dispatchEvent({ type: 'resize' })

  assert.equal(useArtifactStore.getState().panelWidth, 320)
})

test('artifact store preserves tab references for unchanged poll payloads', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')
  useArtifactStore.getState().reset()

  const payload = [
    {
      id: 'artifact-1',
      type: 'markdown',
      title: 'Notes',
      timestamp: 1713379200000,
      data: { markdown: '# Notes\n\nselectable text' },
    },
  ]

  useArtifactStore.getState().applyArtifacts(payload)
  const firstTabs = useArtifactStore.getState().tabs
  const firstArtifact = firstTabs[0]

  // Polling /api/artifacts JSON-parses a fresh payload every time. If the
  // payload is semantically unchanged, keep both the artifact object and tabs
  // array references stable so AppShell/ArtifactPanel do not re-render and
  // disrupt text selection in markdown artifacts.
  const nextPayload = JSON.parse(JSON.stringify(payload))
  useArtifactStore.getState().applyArtifacts(nextPayload)

  const secondTabs = useArtifactStore.getState().tabs
  assert.equal(secondTabs, firstTabs)
  assert.equal(secondTabs[0], firstArtifact)
})

test('artifact store keeps render data stable for timestamp-only live updates', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')
  useArtifactStore.getState().reset()

  const payload = [
    {
      id: 'live-log',
      type: 'logs',
      title: 'Live Log',
      timestamp: 1713379200000,
      data: { lines: [{ level: 'info', message: 'still selectable' }] },
    },
  ]

  useArtifactStore.getState().applyArtifacts(payload)
  const firstArtifact = useArtifactStore.getState().tabs[0]
  const firstData = firstArtifact.data

  const nextPayload = JSON.parse(JSON.stringify(payload))
  nextPayload[0].timestamp = 1713379205000
  useArtifactStore.getState().applyArtifacts(nextPayload)

  const secondArtifact = useArtifactStore.getState().tabs[0]
  assert.notEqual(secondArtifact, firstArtifact)
  assert.equal(secondArtifact.timestamp, 1713379205000)
  assert.equal(secondArtifact.data, firstData)
})

test('artifact bridge commands do not steal active iframe focus', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')
  const { handleControlMessage } = loadCompiled('components/artifacts/bridge.js')
  useArtifactStore.getState().reset()

  useArtifactStore.getState().applyArtifacts([
    {
      id: 'focused-frame',
      type: 'iframe',
      title: 'Focused frame',
      timestamp: 1,
      data: { srcdoc: '<button>typing here</button>' },
    },
    {
      id: 'background-frame',
      type: 'iframe',
      title: 'Background frame',
      timestamp: 2,
      data: { srcdoc: '<button>background</button>' },
    },
  ])
  useArtifactStore.getState().setActiveId('focused-frame')

  assert.equal(handleControlMessage({
    type: 'artifact_bridge_command',
    payload: { artifact_id: 'background-frame', command: 'ping' },
  }), true)

  assert.equal(useArtifactStore.getState().activeId, 'focused-frame')
  assert.equal(useArtifactStore.getState().panelOpen, true)
})

test('artifact iframe data bridge is bounded and omits iframe transport fields', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createArtifactDataBridgeMessage, resolveArtifactFrameTargetOrigin } = loadCompiled('components/artifacts/ArtifactRenderer.js')

  assert.deepEqual(
    createArtifactDataBridgeMessage('dashboard', {
      src: '/api/default-artifacts/dashboard/index.html',
      srcdoc: '<script>expensive html</script>',
      html: '<div>inline html</div>',
      rows: [{ label: 'ok', value: 1 }],
      title: 'Runtime data',
    }),
    {
      type: 'hermes:artifact-data',
      artifactId: 'dashboard',
      data: {
        rows: [{ label: 'ok', value: 1 }],
        title: 'Runtime data',
      },
      artifactData: {
        rows: [{ label: 'ok', value: 1 }],
        title: 'Runtime data',
      },
    },
  )

  assert.equal(createArtifactDataBridgeMessage('empty', { src: '/only/transport.html' }), null)
  assert.equal(createArtifactDataBridgeMessage('huge', { rows: 'x'.repeat(300 * 1024) }), null)
  assert.equal(resolveArtifactFrameTargetOrigin(undefined), '*')
  assert.equal(resolveArtifactFrameTargetOrigin('/api/default-artifacts/strudel/index.html'), 'https://hermelin.test')
  assert.equal(resolveArtifactFrameTargetOrigin('https://example.com/artifact.html'), null)
})

test('artifact panel width no-ops when clamped width is unchanged', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow({ innerWidth: 1400 }))

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')
  useArtifactStore.getState().reset()
  useArtifactStore.getState().setPanelWidth(640)

  let updates = 0
  const unsubscribe = useArtifactStore.subscribe(() => {
    updates += 1
  })

  try {
    useArtifactStore.getState().setPanelWidth(640)
    assert.equal(updates, 0)
  } finally {
    unsubscribe()
  }
})

test('terminal write queue waits for xterm write callbacks before draining more output', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createTerminalWriteQueue } = loadCompiled('components/terminal/TerminalPane.js')
  const callbacks = []
  const writes = []
  const term = {
    write(data, callback) {
      writes.push(data)
      callbacks.push(callback)
    },
  }

  const queue = createTerminalWriteQueue(term)
  queue.enqueue('first')
  queue.enqueue('second')

  assert.deepEqual(writes, ['first'])
  assert.equal(callbacks.length, 1)

  callbacks.shift()()
  assert.deepEqual(writes, ['first', 'second'])
  queue.dispose()
})

test('terminal write queue closes itself when pending output exceeds the byte cap', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createTerminalWriteQueue } = loadCompiled('components/terminal/TerminalPane.js')
  const callbacks = []
  const reasons = []
  const term = {
    write(_data, callback) {
      callbacks.push(callback)
    },
  }

  const queue = createTerminalWriteQueue(term, {
    maxPendingBytes: 8,
    writeTimeoutMs: 1000,
    onBackpressureLimit(reason) {
      reasons.push(reason)
    },
  })

  assert.equal(queue.enqueue('1234'), true)
  assert.equal(queue.enqueue('56789'), false)
  assert.deepEqual(reasons, ['overflow'])
  assert.equal(queue.size(), 0)
  assert.equal(queue.bytes(), 0)
  assert.equal(callbacks.length, 1)
})

test('terminal write queue falls back to safe defaults for invalid option values', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createTerminalWriteQueue } = loadCompiled('components/terminal/TerminalPane.js')
  const callbacks = []
  const reasons = []
  const term = {
    write(_data, callback) {
      callbacks.push(callback)
    },
  }

  const queue = createTerminalWriteQueue(term, {
    maxPendingBytes: Number.NaN,
    maxPendingItems: Number.NaN,
    writeTimeoutMs: Number.NaN,
    onBackpressureLimit(reason) {
      reasons.push(reason)
    },
  })

  assert.equal(queue.enqueue('1234'), true)
  assert.equal(queue.enqueue('5678'), true)
  assert.deepEqual(reasons, [])
  assert.equal(callbacks.length, 1)
  queue.dispose()
})

test('TerminalPane guards websocket lifecycle callbacks against stale sockets', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'terminal', 'TerminalPane.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /const isCurrentSocket = \(\) => !cancelled && !!ws && ws === wsRef\.current/)
  assert.match(source, /ws\.onopen = \(\) => \{\s*if \(!isCurrentSocket\(\)\) return/)
  assert.match(source, /ws\.onmessage = \(ev: MessageEvent\) => \{\s*if \(!isCurrentSocket\(\)\) return/)
})

test('artifact store does not stringify huge payloads to preserve render data', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')
  useArtifactStore.getState().reset()

  const payload = [
    {
      id: 'huge-live-log',
      type: 'logs',
      title: 'Huge Live Log',
      timestamp: 1713379200000,
      data: { markdown: 'x'.repeat(300 * 1024) },
    },
  ]

  useArtifactStore.getState().applyArtifacts(payload)
  const firstArtifact = useArtifactStore.getState().tabs[0]
  const nextPayload = JSON.parse(JSON.stringify(payload))
  nextPayload[0].timestamp = 1713379205000

  useArtifactStore.getState().applyArtifacts(nextPayload)

  const secondArtifact = useArtifactStore.getState().tabs[0]
  assert.notEqual(secondArtifact.data, firstArtifact.data)
})

test('terminal session detector handles Session marker split across frames', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createSessionIdDetector } = loadCompiled('components/terminal/TerminalPane.js')
  const detected = []
  const detect = createSessionIdDetector((sid) => detected.push(sid))

  assert.equal(detect('Hermes Ses'), null)
  assert.equal(detect('sion: 20260429_091600_abcdef ready'), '20260429_091600_abcdef')
  assert.deepEqual(detected, ['20260429_091600_abcdef'])

  // Only detect once; later prompt redraws should not re-trigger session changes.
  assert.equal(detect('Session: 20260429_091601_123456'), null)
  assert.deepEqual(detected, ['20260429_091600_abcdef'])
})

test('artifact realtime token ignores stale websocket disconnects', async () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      async json() {
        return []
      },
    }
  }

  try {
    const { useArtifactStore } = loadCompiled('stores/artifacts.js')
    useArtifactStore.getState().reset()
    useArtifactStore.getState().startPolling()
    await new Promise((resolve) => setImmediate(resolve))

    const initialCalls = calls
    assert.equal(initialCalls, 1)

    useArtifactStore.getState().setRealtimeUpdatesActive(true, 'new-socket')
    useArtifactStore.getState().setRealtimeUpdatesActive(false, 'old-socket')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, initialCalls)

    useArtifactStore.getState().setRealtimeUpdatesActive(false, 'new-socket')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, initialCalls + 1)
  } finally {
    try {
      const { useArtifactStore } = loadCompiled('stores/artifacts.js')
      useArtifactStore.getState().stopPolling()
    } catch {}
    if (originalFetch === undefined) delete global.fetch
    else global.fetch = originalFetch
  }
})

test('index.css restores the Google Fonts JetBrains Mono import for terminal parity', () => {
  const indexCssPath = path.join(SOURCE_ROOT, 'index.css')
  const source = fs.readFileSync(indexCssPath, 'utf8')

  assert.match(source, /fonts\.googleapis\.com\/css2\?family=JetBrains\+Mono/)
})

test('appearance settings uses the active theme accent for timestamps', () => {
  const appearanceSettingsPath = path.join(SOURCE_ROOT, 'components', 'settings', 'AppearanceSettings.tsx')
  const source = fs.readFileSync(appearanceSettingsPath, 'utf8')

  assert.match(source, /accentColor:\s*AMBER\[400\]/)
  assert.ok(!source.includes("accentColor: '#f5b731'"))
})

test('nous theme uses dusk palette and sprite artwork', () => {
  installAssetStubs()
  clearCompiledModules()
  const { THEMES } = loadCompiled('theme/themes.js')

  assert.equal(THEMES.nous.SLATE.bg, '#0e1028')
  assert.equal(THEMES.nous.SLATE.accent, '#88b8f0')
  assert.match(THEMES.nous.icons.topbarImageHref || '', /nous-girl-topbar-blink\.png$/)
  assert.match(THEMES.nous.icons.alignmentImageHref || '', /nous-girl-blink\.png$/)
  assert.equal(THEMES.nous.icons.topbarTintColor, undefined)
  assert.equal(THEMES.nous.icons.topbarBackdropFadeColor, undefined)
  assert.equal(THEMES.nous.icons.topbarSpritesheet, true)
  assert.equal(THEMES.nous.icons.alignmentSpritesheet, true)
  assert.equal(THEMES.nous.icons.alignmentAlwaysVisible, true)
  assert.equal(THEMES.nous.icons.alignmentBob, true)
  assert.equal(THEMES.nous.icons.alignmentWidth, 64)
  assert.equal(THEMES.nous.icons.alignmentHeight, 64)
})

test('theme icon renders masked tint overlay and backdrop fade when requested', () => {
  installAssetStubs()
  clearCompiledModules()
  const React = require('react')
  const ReactDOMServer = require('react-dom/server')
  const { ThemeIcon } = loadCompiled('components/shared/icons.js')

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ThemeIcon, {
      imageHref: '/assets/nous-girl.png',
      title: 'nous girl',
      width: 64,
      height: 64,
      tintColor: '#5888c0',
      tintOpacity: 0.25,
      backdropFadeColor: '#141838',
    }),
  )

  assert.match(html, /<img/)
  assert.match(html, /nous-girl\.png/)
  assert.match(html, /mix-blend-mode:color/)
  assert.match(html, /background:#5888c0/)
  assert.match(html, /mask-image:url\(\/assets\/nous-girl\.png\)/)
  assert.match(html, /radial-gradient\(ellipse at center/)
})

test('alignment easter egg supports always-on bobbing artwork', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'AlignmentEasterEgg.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /alwaysVisible\?: boolean/)
  assert.match(source, /bob\?: boolean/)
  assert.match(source, /@keyframes eggBob/)
})

test('alignment easter egg disables bob animation and glow while paused', () => {
  installAssetStubs()
  clearCompiledModules()
  const React = require('react')
  const ReactDOMServer = require('react-dom/server')
  const { AlignmentEasterEgg } = loadCompiled('components/AlignmentEasterEgg.js')

  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AlignmentEasterEgg, {
      imageHref: '/assets/nous-girl.png',
      title: 'nous girl',
      width: 64,
      height: 64,
      alwaysVisible: true,
      bob: true,
      paused: true,
    }),
  )

  assert.doesNotMatch(html, /animation:eggBob/)
  assert.doesNotMatch(html, /drop-shadow/)
})

test('AppShell pauses the alignment easter egg when overlays are open', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'AppShell.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /<BackgroundRenderer paused=\{overlayOpen\} \/>/)
  assert.match(source, /<AlignmentEasterEgg[\s\S]*paused=\{overlayOpen\}/)
})

test('AppShell waits for authentication before probing for updates', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'AppShell.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /if \(authLoading\) return/)
  assert.match(source, /if \(authEnabled && !authenticated\) \{[\s\S]*setUpdateAvailable\(false\)/)
  assert.match(source, /setUpdateAvailable\(Boolean\(data\?\.update_available\)\)/)
  assert.match(source, /\}, \[authEnabled, authLoading, authenticated\]\)/)
})

test('theme background fields do not snapshot canvas into data URLs on pause', () => {
  const paths = [
    path.join(SOURCE_ROOT, 'components', 'backgrounds', 'NousCRTField.tsx'),
    path.join(SOURCE_ROOT, 'components', 'backgrounds', 'SamaritanField.tsx'),
    path.join(SOURCE_ROOT, 'components', 'backgrounds', 'ParticleField.tsx'),
    path.join(SOURCE_ROOT, 'components', 'backgrounds', 'MatrixRainField.tsx'),
  ]

  for (const sourcePath of paths) {
    const source = fs.readFileSync(sourcePath, 'utf8')
    assert.ok(!source.includes('toDataURL('), `${path.basename(sourcePath)} still snapshots canvas`)
    assert.ok(!source.includes('backgroundImage: `url(${snapshot})`'), `${path.basename(sourcePath)} still renders snapshot overlay`)
  }
})

test('samaritan theme uses warm palette and sprite artwork', () => {
  installAssetStubs()
  clearCompiledModules()
  const { THEMES } = loadCompiled('theme/themes.js')

  assert.equal(THEMES.samaritan.SLATE.bg, '#e8e6e1')
  assert.equal(THEMES.samaritan.SLATE.accent, '#cc3333')
  assert.equal(THEMES.samaritan.icons.topbarImageHref || '', '')
  assert.equal(THEMES.samaritan.icons.alignmentImageHref || '', '')
  assert.equal(THEMES.samaritan.icons.alignmentAlwaysVisible, true)
  assert.equal(THEMES.samaritan.icons.alignmentBob, true)
})
