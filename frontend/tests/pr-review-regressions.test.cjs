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

test('terminal store uses canonical Hermes pet activity state names', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().noteUserInput('hello boba\r')
  assert.equal(useTerminalStore.getState().petActivity.state, 'review')

  useTerminalStore.getState().notePtyOutput('[tool] executing terminal command')
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().noteUserInput('break please\r')
  useTerminalStore.getState().notePtyOutput('Traceback: tool failed')
  assert.equal(useTerminalStore.getState().petActivity.state, 'failed')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().spawn(null)
  const nonce = useTerminalStore.getState().spawnNonce
  useTerminalStore.getState().onConnectionChange(true, nonce)
  useTerminalStore.getState().onDetectedSessionId('20260626_120000_deadbe')
  assert.equal(useTerminalStore.getState().petActivity.state, 'wave')

  useTerminalStore.getState().reset()
})

test('terminal pet ignores focus clicks, blank input, and duplicate session redraws', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useSessionStore } = loadCompiled('stores/sessions.js')
  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useSessionStore.getState().reset()
  useTerminalStore.getState().reset()

  useTerminalStore.getState().noteUserInput('\x1b[I')
  useTerminalStore.getState().noteUserInput('\x1b[O')
  useTerminalStore.getState().noteUserInput('\r')
  useTerminalStore.getState().notePtyOutput('[tool] stale focus repaint')
  assert.equal(useTerminalStore.getState().petActivity.state, 'idle')

  useTerminalStore.getState().noteUserInput('not submitted yet')
  assert.equal(useTerminalStore.getState().petActivity.state, 'idle')
  useTerminalStore.getState().noteUserInput('\r')
  assert.equal(useTerminalStore.getState().petActivity.state, 'review')

  useTerminalStore.getState().notePetActivity('idle')
  useTerminalStore.getState().spawn(null)
  const nonce = useTerminalStore.getState().spawnNonce
  useTerminalStore.getState().onConnectionChange(true, nonce)
  useTerminalStore.getState().onDetectedSessionId('20260626_120000_deadbe')
  assert.equal(useTerminalStore.getState().petActivity.state, 'wave')
  useTerminalStore.getState().notePetActivity('idle')
  useTerminalStore.getState().onDetectedSessionId('20260626_120000_deadbe')
  assert.equal(useTerminalStore.getState().petActivity.state, 'idle')

  useTerminalStore.getState().reset()
})

test('terminal pet follows structured Hermes sidecar events and never falls back to PTY heuristics', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().notePetSyncMode({ mode: 'structured', source: 'tui-sidecar' })
  assert.equal(useTerminalStore.getState().petActivity.state, 'idle')

  useTerminalStore.getState().noteUserInput('run a tool\r')
  useTerminalStore.getState().notePtyOutput('[tool] terminal repaint should not drive pet')
  assert.equal(useTerminalStore.getState().petActivity.state, 'idle')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'message.start', payload: {} })
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'thinking.delta', payload: { text: '' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'reasoning.delta', payload: { text: 'thinking through tool choice' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'review')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'tool.start', payload: { tool_id: 'tool-1', name: 'terminal' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'tool.complete', payload: { tool_id: 'tool-1', name: 'terminal' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'message.complete', payload: {} })
  assert.equal(useTerminalStore.getState().petActivity.state, 'wave')

  useTerminalStore.getState().reset()
})

test('terminal pet does not let missing tool ids pin structured sync on run', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().notePetSyncMode({ mode: 'structured', source: 'tui-sidecar' })
  useTerminalStore.getState().noteHermesPetEvent({ type: 'message.start', payload: {} })
  useTerminalStore.getState().noteHermesPetEvent({ type: 'reasoning.delta', payload: { text: 'thinking before tool' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'review')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'tool.start', payload: { tool_id: 'tool-1', name: 'terminal' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'tool.complete', payload: { name: 'terminal' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'run')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'reasoning.delta', payload: { text: 'reading tool output' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'review')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'message.complete', payload: {} })
  assert.equal(useTerminalStore.getState().petActivity.state, 'wave')

  useTerminalStore.getState().reset()
})

test('terminal pet exposes structured sync debug state on window', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().notePetSyncMode({ mode: 'structured', source: 'tui-sidecar' })
  useTerminalStore.getState().noteHermesPetEvent({ type: 'message.start', payload: {} })
  useTerminalStore.getState().noteHermesPetEvent({ type: 'reasoning.delta', payload: { text: 'thinking' } })

  assert.equal(global.window.__HERMELIN_PET_SYNC__.state, 'review')
  assert.equal(global.window.__HERMELIN_PET_SYNC__.lastEventType, 'reasoning.delta')
  assert.deepEqual(global.window.__HERMELIN_PET_SYNC__.tools, [])

  useTerminalStore.getState().reset()
  setWindow(undefined)
})

test('terminal pet maps structured Hermes prompts and errors to waiting and failed states', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { useTerminalStore } = loadCompiled('stores/terminal.js')

  useTerminalStore.getState().reset()
  useTerminalStore.getState().notePetSyncMode({ mode: 'structured' })
  useTerminalStore.getState().noteHermesPetEvent({ type: 'message.start', payload: {} })
  useTerminalStore.getState().noteHermesPetEvent({ type: 'approval.request', payload: { command: 'rm -rf /tmp/nope' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'waiting')

  useTerminalStore.getState().noteHermesPetEvent({ type: 'error', payload: { message: 'boom' } })
  assert.equal(useTerminalStore.getState().petActivity.state, 'failed')

  useTerminalStore.getState().reset()
})

test('pet canvas avoids blank transition frames from sparse animation rows', () => {
  const source = fs.readFileSync(path.join(SOURCE_ROOT, 'components', 'pet', 'FloatingPetOverlay.tsx'), 'utf8')

  assert.match(source, /const DEFAULT_ROW_FRAME_COUNTS: Record<string, number> = \{[\s\S]*waving: 4,[\s\S]*jumping: 5,[\s\S]*\}/)
  assert.match(source, /function frameCountForRow\(/)
  assert.match(source, /function canvasHasVisiblePixels\(/)
  assert.match(source, /const scratch = document\.createElement\('canvas'\)/)
  assert.match(source, /scratchCtx\.drawImage\(image, frame \* frameW, row \* frameH, frameW, frameH, 0, 0, drawW, drawH\)[\s\S]*if \(!canvasHasVisiblePixels\(scratchCtx, scratch\.width, scratch\.height\)\)/)
  assert.match(source, /ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\)[\s\S]*ctx\.drawImage\(scratch, 0, 0\)/)
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

test('artifact runtime state distinguishes persisted live expectation from active runner', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { getArtifactRuntimeState } = loadCompiled('components/ArtifactPanel.js')

  assert.deepEqual(
    getArtifactRuntimeState({ id: 'legacy-live', type: 'iframe', live: true, refresh_seconds: 2 }),
    {
      expectedLive: true,
      hasRuntimeStatus: false,
      isLive: true,
      isStopped: false,
      runnerStatus: '',
    },
  )

  assert.deepEqual(
    getArtifactRuntimeState({ id: 'saved-live', type: 'iframe', live: true, refresh_seconds: 2, runner_active: false, runner_status: 'stopped' }),
    {
      expectedLive: true,
      hasRuntimeStatus: true,
      isLive: false,
      isStopped: true,
      runnerStatus: 'stopped',
    },
  )

  assert.deepEqual(
    getArtifactRuntimeState({ id: 'active-live', type: 'iframe', live: true, runner_active: true, runner_status: 'running' }),
    {
      expectedLive: true,
      hasRuntimeStatus: true,
      isLive: true,
      isStopped: false,
      runnerStatus: 'running',
    },
  )
})

test('artifact store treats runner status-only changes as semantic updates', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { useArtifactStore } = loadCompiled('stores/artifacts.js')
  useArtifactStore.getState().reset()

  useArtifactStore.getState().applyArtifacts([
    {
      id: 'saved-live',
      type: 'iframe',
      title: 'Saved live artifact',
      live: true,
      refresh_seconds: 2,
      runner_active: true,
      runner_status: 'running',
      timestamp: 1713379200000,
      updated_at: 1713379200000,
      data: { src: 'http://127.0.0.1:43123/' },
    },
  ])
  const firstTabs = useArtifactStore.getState().tabs
  const firstArtifact = firstTabs[0]
  const firstData = firstArtifact.data

  useArtifactStore.getState().applyArtifacts([
    {
      id: 'saved-live',
      type: 'iframe',
      title: 'Saved live artifact',
      live: true,
      refresh_seconds: 2,
      runner_active: false,
      runner_status: 'stopped',
      timestamp: 1713379200000,
      updated_at: 1713379200000,
      data: { src: 'http://127.0.0.1:43123/' },
    },
  ])

  const secondTabs = useArtifactStore.getState().tabs
  assert.notEqual(secondTabs, firstTabs)
  assert.notEqual(secondTabs[0], firstArtifact)
  assert.equal(secondTabs[0].runner_active, false)
  assert.equal(secondTabs[0].runner_status, 'stopped')
  assert.equal(secondTabs[0].data, firstData)
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

test('artifact src iframes allow downloads for browser-side recorders', () => {
  const rendererPath = path.join(SOURCE_ROOT, 'components', 'artifacts', 'ArtifactRenderer.tsx')
  const rendererSource = fs.readFileSync(rendererPath, 'utf8')

  assert.match(rendererSource, /sandbox=\{src \? 'allow-scripts allow-forms allow-same-origin allow-downloads'/)
})

test('oversized artifact placeholders render a clear load error', () => {
  const rendererPath = path.join(SOURCE_ROOT, 'components', 'artifacts', 'ArtifactRenderer.tsx')
  const rendererSource = fs.readFileSync(rendererPath, 'utf8')

  assert.match(rendererSource, /Artifact cannot load/)
  assert.match(rendererSource, /artifactLoadErrorInfo\(artifact\)/)
  assert.match(rendererSource, /case 'error':/)
  assert.match(rendererSource, /HERMELIN_ARTIFACT_READ_MAX_FILE_BYTES|env_var/)
})

test('Strudel recorder keeps blob URLs alive for Firefox downloads', () => {
  const strudelPath = path.resolve(__dirname, '..', '..', 'hermelin', 'default_artifact_assets', 'strudel', 'index.html')
  const strudelSource = fs.readFileSync(strudelPath, 'utf8')

  assert.match(strudelSource, /function downloadRecordingBlob\(/)
  assert.match(strudelSource, /document\.body\.appendChild\(a\)/)
  assert.match(strudelSource, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\),/)
})

test('artifact iframe data bridge is bounded and omits iframe transport fields', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createArtifactDataBridgeMessage, resolveArtifactFrameTargetOrigin, sanitizeArtifactSrcDoc } = loadCompiled('components/artifacts/ArtifactRenderer.js')

  const sanitizedSrcDoc = sanitizeArtifactSrcDoc(`
<script>
console.log('artifact ready')
//# sourceMappingURL=2
</script>
<style>
body { color: red }
/*# sourceMappingURL=theme.css.map */
</style>
`)
  assert.match(sanitizedSrcDoc, /console\.log\('artifact ready'\)/)
  assert.match(sanitizedSrcDoc, /body \{ color: red \}/)
  assert.doesNotMatch(sanitizedSrcDoc, /sourceMappingURL/)

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

test('artifact store can explicitly clear transient artifacts and refresh without auto-opening', async () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const originalFetch = global.fetch
  const calls = []
  global.fetch = async (path, opts = {}) => {
    calls.push({ path: String(path), method: String(opts.method || 'GET') })
    if (String(path) === '/api/artifacts/clear-session') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, removed_artifacts: 1, removed_artifact_ids: ['transient'] }
        },
      }
    }
    if (String(path) === '/api/artifacts') {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            {
              id: 'saved',
              type: 'markdown',
              title: 'Saved',
              persistent: true,
              timestamp: 2,
              data: { markdown: 'still here' },
            },
          ]
        },
      }
    }
    throw new Error(`unexpected fetch ${String(path)}`)
  }

  try {
    const { useArtifactStore } = loadCompiled('stores/artifacts.js')
    useArtifactStore.getState().reset()
    useArtifactStore.getState().applyArtifacts([
      { id: 'transient', type: 'markdown', title: 'Transient', timestamp: 1, data: { markdown: 'tmp' } },
      { id: 'saved', type: 'markdown', title: 'Saved', persistent: true, timestamp: 2, data: { markdown: 'saved' } },
    ])
    useArtifactStore.setState({ panelOpen: false, panelDismissed: true })

    assert.equal(typeof useArtifactStore.getState().clearSessionArtifacts, 'function')
    await useArtifactStore.getState().clearSessionArtifacts()

    assert.deepEqual(calls, [
      { path: '/api/artifacts/clear-session', method: 'POST' },
      { path: '/api/artifacts', method: 'GET' },
    ])
    assert.deepEqual(useArtifactStore.getState().tabs.map((item) => item.id), ['saved'])
    assert.equal(useArtifactStore.getState().panelOpen, false)
  } finally {
    if (originalFetch === undefined) delete global.fetch
    else global.fetch = originalFetch
  }
})

test('artifact store can rename an artifact and refresh without auto-opening', async () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const originalFetch = global.fetch
  const calls = []
  global.fetch = async (path, opts = {}) => {
    calls.push({
      path: String(path),
      method: String(opts.method || 'GET'),
      body: opts.body ? JSON.parse(String(opts.body)) : null,
    })
    if (String(path) === '/api/artifacts/chart/rename') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, artifact_id: 'chart', title: 'Quarterly Revenue' }
        },
      }
    }
    if (String(path) === '/api/artifacts') {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            {
              id: 'chart',
              type: 'markdown',
              title: 'Quarterly Revenue',
              timestamp: 1,
              data: { markdown: 'same data' },
            },
          ]
        },
      }
    }
    throw new Error(`unexpected fetch ${String(path)}`)
  }

  try {
    const { useArtifactStore } = loadCompiled('stores/artifacts.js')
    useArtifactStore.getState().reset()
    useArtifactStore.getState().applyArtifacts([
      { id: 'chart', type: 'markdown', title: 'Chart', timestamp: 1, data: { markdown: 'same data' } },
    ])
    useArtifactStore.setState({ panelOpen: false, panelDismissed: true })

    assert.equal(typeof useArtifactStore.getState().renameTab, 'function')
    await useArtifactStore.getState().renameTab('chart', 'Quarterly Revenue')

    assert.deepEqual(calls, [
      { path: '/api/artifacts/chart/rename', method: 'POST', body: { title: 'Quarterly Revenue' } },
      { path: '/api/artifacts', method: 'GET', body: null },
    ])
    assert.equal(useArtifactStore.getState().tabs[0].title, 'Quarterly Revenue')
    assert.equal(useArtifactStore.getState().panelOpen, false)
  } finally {
    if (originalFetch === undefined) delete global.fetch
    else global.fetch = originalFetch
  }
})

test('artifact panel exposes discoverable per-artifact and bulk delete actions', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'ArtifactPanel.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /artifactPanelDropdown__kebab/)
  assert.match(source, /Rename artifact/)
  assert.match(source, /Delete artifact/)
  assert.match(source, /Clear transient artifacts/)
  assert.match(source, /onRenameArtifact/)
  assert.match(source, /onClearSessionArtifacts/)
})

test('artifact panel excludes built-in artifacts from transient clear count and row actions', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { isClearableSessionArtifact, canShowArtifactActions } = loadCompiled('components/ArtifactPanel.js')

  const strudel = {
    id: 'strudel',
    type: 'iframe',
    title: 'Strudel',
    persistent: false,
    default: true,
    deletable: false,
  }

  assert.equal(isClearableSessionArtifact(strudel), false)
  assert.equal(canShowArtifactActions(strudel), false)
  assert.equal(isClearableSessionArtifact({ id: 'tmp', type: 'markdown', persistent: false }), true)
  assert.equal(canShowArtifactActions({ id: 'tmp', type: 'markdown', persistent: false }), true)
  assert.equal(isClearableSessionArtifact({ id: 'saved', type: 'markdown', persistent: true }), false)
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

test('terminal output filter strips TUI mouse tracking while preserving other modes', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { stripTerminalMouseModeSequences } = loadCompiled('components/terminal/TerminalPane.js')
  const esc = '\u001b'

  assert.equal(stripTerminalMouseModeSequences(`a${esc}[?1000h${esc}[?1006hb`), 'ab')
  assert.equal(stripTerminalMouseModeSequences(`${esc}[?1000;1006l`), '')
  assert.equal(stripTerminalMouseModeSequences(`${esc}[?1049;1000;1006h`), `${esc}[?1049h`)
  assert.equal(stripTerminalMouseModeSequences(`${esc}[?1007h`), `${esc}[?1007h`)
  assert.equal(stripTerminalMouseModeSequences(`${esc}[?25lcursor${esc}[?2004h`), `${esc}[?25lcursor${esc}[?2004h`)
})

test('terminal TUI wheel helper maps alternate-screen scroll intent to page keys', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { normalizeTerminalWheelDeltaRows, terminalWheelRowsToPageSequence } = loadCompiled('components/terminal/TerminalPane.js')
  const esc = '\u001b'

  assert.equal(terminalWheelRowsToPageSequence(normalizeTerminalWheelDeltaRows(48, 0, 30)), `${esc}[6~`)
  assert.equal(terminalWheelRowsToPageSequence(normalizeTerminalWheelDeltaRows(-3, 1, 30)), `${esc}[5~`)
  assert.equal(terminalWheelRowsToPageSequence(normalizeTerminalWheelDeltaRows(2, 1, 30)), null)
  assert.equal(terminalWheelRowsToPageSequence(normalizeTerminalWheelDeltaRows(1, 2, 30)), `${esc}[6~`)
})

test('terminal mouse mode filter handles private mode sequences split across frames', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { createTerminalMouseModeFilter } = loadCompiled('components/terminal/TerminalPane.js')
  const esc = '\u001b'
  const filter = createTerminalMouseModeFilter()

  assert.equal(filter.filter(`before${esc}[?10`), 'before')
  assert.equal(filter.filter('00;1006hafter'), 'after')
  assert.equal(filter.filter(`x${esc}[?2`), 'x')
  assert.equal(filter.filter('5ly'), `${esc}[?25ly`)
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

test('font setup keeps Google JetBrains globally and self-hosted B1 available for terminal panes', () => {
  const indexCssPath = path.join(SOURCE_ROOT, 'index.css')
  const fontsCssPath = path.join(SOURCE_ROOT, 'fonts.css')
  const mainPath = path.join(SOURCE_ROOT, 'main.tsx')
  const indexSource = fs.readFileSync(indexCssPath, 'utf8')
  const fontsSource = fs.readFileSync(fontsCssPath, 'utf8')
  const mainSource = fs.readFileSync(mainPath, 'utf8')

  assert.match(indexSource, /fonts\.googleapis\.com\/css2\?family=JetBrains\+Mono/)
  assert.match(mainSource, /import '\.\/fonts\.css'/)
  assert.match(fontsSource, /font-family:\s*'JetBrains Mono B1'/)
  assert.doesNotMatch(fontsSource, /font-family:\s*'JetBrains Mono';/)
})

test('TerminalPane uses the self-hosted B1 font for both classic CLI and TUI launches', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const {
    inferTerminalFontMode,
    TERMINAL_FONT_FAMILY_CHAT,
    TERMINAL_FONT_FAMILY_TUI,
  } = loadCompiled('components/terminal/TerminalPane.js')

  assert.equal(TERMINAL_FONT_FAMILY_CHAT, "'JetBrains Mono B1', 'JetBrains Mono', monospace")
  assert.equal(TERMINAL_FONT_FAMILY_TUI, "'JetBrains Mono B1', 'JetBrains Mono', monospace")
  assert.equal(inferTerminalFontMode({ hermelin: { hermes_launch_mode: 'chat' } }), 'chat')
  assert.equal(inferTerminalFontMode({ hermelin: { hermes_launch_mode: 'tui' } }), 'tui')
  assert.equal(inferTerminalFontMode({ hermelin: { effective_hermes_cmd: 'hermes chat --tui' } }), 'tui')
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

test('AppShell keeps auth alive and only clears session state on explicit logout', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'AppShell.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /Keep long-lived open tabs authenticated/)
  assert.match(source, /sessionTtlSeconds/)
  assert.match(source, /Math\.floor\(ttlMs \* 0\.5\)/)
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*useAuthStore\.getState\(\)\.refresh\(\{ preserveEnabledOnError: true \}\)[\s\S]*keepaliveMs/)
  assert.match(source, /logoutReason === 'explicit'/)
  assert.match(source, /\}, \[authEnabled, authenticated, sessionTtlSeconds\]\)/)
  assert.match(source, /\}, \[authenticated, logoutReason\]\)/)
  assert.match(source, /spawn\(useSessionStore\.getState\(\)\.activeSessionId \?\? null\)/)
  assert.match(source, /logoutReason === 'expired'/)
  assert.match(source, /reconnects[\s\S]*preserved activeSessionId/)

  const sessionsSource = fs.readFileSync(path.join(SOURCE_ROOT, 'stores', 'sessions.ts'), 'utf8')
  assert.match(sessionsSource, /Preserve visible session context/)
  assert.doesNotMatch(sessionsSource, /activeSession: computeActiveSession\(\[\], s\.activeSessionId\)/)
})

test('auth store distinguishes expired auth from deliberate logout', async () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const originalFetch = global.fetch
  const { useAuthStore } = loadCompiled('stores/auth.js')

  try {
    global.fetch = async (path, opts = {}) => {
      if (String(path) === '/api/auth/me') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { auth_enabled: true, authenticated: false, session_ttl_seconds: 120 }
          },
        }
      }
      if (String(path) === '/api/auth/logout' && String(opts.method || 'GET') === 'POST') {
        return { ok: true, status: 200, async json() { return { ok: true } } }
      }
      throw new Error(`unexpected fetch ${String(path)}`)
    }

    await useAuthStore.getState().refresh()
    assert.equal(useAuthStore.getState().authenticated, false)
    assert.equal(useAuthStore.getState().logoutReason, 'expired')
    assert.equal(useAuthStore.getState().sessionTtlSeconds, 120)

    global.fetch = async () => { throw new Error('temporary auth check failure') }
    useAuthStore.setState({ enabled: true, authenticated: true, logoutReason: null, sessionTtlSeconds: 120 })
    await useAuthStore.getState().refresh({ preserveEnabledOnError: true })
    assert.equal(useAuthStore.getState().enabled, true)
    assert.equal(useAuthStore.getState().authenticated, false)
    assert.equal(useAuthStore.getState().logoutReason, 'expired')
    assert.equal(useAuthStore.getState().sessionTtlSeconds, 120)

    global.fetch = async (path, opts = {}) => {
      if (String(path) === '/api/auth/logout' && String(opts.method || 'GET') === 'POST') {
        return { ok: true, status: 200, async json() { return { ok: true } } }
      }
      throw new Error(`unexpected fetch ${String(path)}`)
    }
    useAuthStore.setState({ authenticated: true, logoutReason: null })
    await useAuthStore.getState().logout()
    assert.equal(useAuthStore.getState().authenticated, false)
    assert.equal(useAuthStore.getState().logoutReason, 'explicit')
  } finally {
    global.fetch = originalFetch
  }
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

test('pet overlay can be disabled from browser-local UI prefs', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(undefined)

  const { normalizeUiPrefs, DEFAULT_UI_PREFS } = loadCompiled('utils/ui-prefs.js')

  assert.equal(DEFAULT_UI_PREFS.petOverlay.enabled, true)
  assert.equal(normalizeUiPrefs({ petOverlay: { position: 'top-left', size: 120, slug: 'boba' } }).petOverlay.enabled, true)
  assert.equal(normalizeUiPrefs({ petOverlay: { enabled: false, position: 'top-left', size: 120, slug: 'boba' } }).petOverlay.enabled, false)
  assert.equal(normalizeUiPrefs({ petOverlay: { enabled: 0 } }).petOverlay.enabled, false)

  const appShellSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components', 'AppShell.tsx'), 'utf8')
  const settingsSource = fs.readFileSync(path.join(SOURCE_ROOT, 'components', 'settings', 'PetOverlaySettings.tsx'), 'utf8')

  assert.match(appShellSource, /visible=\{authenticated && prefs\.petOverlay\.enabled\}/)
  assert.match(settingsSource, /Show browser pet overlay/)
  assert.match(settingsSource, /type="checkbox"/)
  assert.match(settingsSource, /updatePetOverlay\(\{ enabled: e\.target\.checked \}\)/)
})

test('Hermes dashboard settings panel exposes same-origin dashboard as an external link', () => {
  const dashboardPath = path.join(SOURCE_ROOT, 'components', 'settings', 'HermesDashboardSettings.tsx')
  const settingsPanelPath = path.join(SOURCE_ROOT, 'components', 'settings', 'SettingsPanel.tsx')
  const dashboardSource = fs.readFileSync(dashboardPath, 'utf8')
  const settingsSource = fs.readFileSync(settingsPanelPath, 'utf8')

  assert.match(dashboardSource, /\/api\/runners\/hermes-dashboard\//)
  assert.match(dashboardSource, /\/api\/hermes-dashboard\/status/)
  assert.match(dashboardSource, /\/api\/hermes-dashboard\/start/)
  assert.match(dashboardSource, /window\.open\(dashboardProxyUrl, '_blank', 'noopener,noreferrer'\)/)
  assert.ok(!dashboardSource.includes('<iframe'), 'settings panel should not embed the native dashboard')
  assert.ok(!dashboardSource.includes('frameNonce'), 'dashboard card should not keep iframe reload state')
  assert.ok(!dashboardSource.includes('127.0.0.1'))
  assert.match(settingsSource, /HermesDashboardSettings/)
})

test('integrated settings no longer exposes stale Hermes model or API-key editors', () => {
  const settingsPanelPath = path.join(SOURCE_ROOT, 'components', 'settings', 'SettingsPanel.tsx')
  const agentSettingsPath = path.join(SOURCE_ROOT, 'components', 'settings', 'AgentSettings.tsx')
  const settingsSource = fs.readFileSync(settingsPanelPath, 'utf8')
  const agentSource = fs.readFileSync(agentSettingsPath, 'utf8')

  assert.ok(!fs.existsSync(path.join(SOURCE_ROOT, 'components', 'settings', 'ModelSettings.tsx')))
  assert.ok(!fs.existsSync(path.join(SOURCE_ROOT, 'components', 'settings', 'KeySettings.tsx')))
  assert.ok(!settingsSource.includes('ModelSettings'))
  assert.ok(!settingsSource.includes('KeySettings'))
  assert.ok(!settingsSource.includes('API-Keys'))
  assert.ok(!agentSource.includes('Reasoning effort'))
  assert.ok(!agentSource.includes('Summary model'))
  assert.match(agentSource, /Launch mode for new terminals\./)
  assert.ok(!agentSource.includes('Local launch options only'))
  assert.ok(!agentSource.includes('Use the native Hermes Dashboard link'))
  assert.ok(!agentSource.includes('Used for new terminal sessions.'))
})

test('Hermes dashboard proxy path validator rejects non-same-origin values', () => {
  installAssetStubs()
  clearCompiledModules()
  setWindow(makeWindow())

  const { normalizeDashboardProxyUrl } = loadCompiled('components/settings/HermesDashboardSettings.js')
  const fallback = '/api/runners/hermes-dashboard/'

  assert.equal(normalizeDashboardProxyUrl('/api/custom-dashboard'), '/api/custom-dashboard/')
  assert.equal(normalizeDashboardProxyUrl('/api/custom-dashboard/'), '/api/custom-dashboard/')

  for (const unsafe of [
    'https://evil.example/dashboard',
    'http://127.0.0.1:9119/',
    '//evil.example/dashboard',
    'ws://evil.example/api/ws',
    'wss://evil.example/api/ws',
    'javascript:alert(1)',
    'data:text/html,pwned',
    'vbscript:msgbox(1)',
    '/r/hermes-dashboard/',
    'api/missing-leading-slash',
    '',
  ]) {
    assert.equal(normalizeDashboardProxyUrl(unsafe), fallback, unsafe)
  }
})

test('Hermes dashboard settings hides locked proxy details and process metadata', () => {
  const dashboardPath = path.join(SOURCE_ROOT, 'components', 'settings', 'HermesDashboardSettings.tsx')
  const dashboardSource = fs.readFileSync(dashboardPath, 'utf8')

  assert.match(dashboardSource, /Log in to manage Hermes Dashboard\./)
  assert.ok(!dashboardSource.includes('dashboard theme:'), 'dashboard theme detail should not be rendered in settings')
  assert.ok(!dashboardSource.includes('iframe source:'), 'dashboard proxy path should not be rendered as plain text')
  assert.ok(!dashboardSource.includes('status?.pid'), 'dashboard pid should not be rendered')
  assert.ok(!dashboardSource.includes('status?.host'), 'dashboard host should not be rendered')
  assert.ok(!dashboardSource.includes('status?.port'), 'dashboard port should not be rendered')
})
