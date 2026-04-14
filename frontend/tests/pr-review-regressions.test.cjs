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
  const assetPattern = /\.(svg(\?raw)?|png)$/

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
  assert.match(THEMES.nous.icons.topbarImageHref || '', /nous-girl-big\.png$/)
  assert.match(THEMES.nous.icons.alignmentImageHref || '', /nous-girl\.png$/)
  assert.equal(THEMES.nous.icons.topbarTintColor, '#5888c0')
  assert.equal(THEMES.nous.icons.alignmentAlwaysVisible, true)
  assert.equal(THEMES.nous.icons.alignmentBob, true)
})

test('theme icon renders image markup and tint overlay when requested', () => {
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
    }),
  )

  assert.match(html, /<img/)
  assert.match(html, /nous-girl\.png/)
  assert.match(html, /mix-blend-mode:color/)
  assert.match(html, /background:#5888c0/)
})

test('alignment easter egg supports always-on bobbing artwork', () => {
  const sourcePath = path.join(SOURCE_ROOT, 'components', 'AlignmentEasterEgg.tsx')
  const source = fs.readFileSync(sourcePath, 'utf8')

  assert.match(source, /alwaysVisible\?: boolean/)
  assert.match(source, /bob\?: boolean/)
  assert.match(source, /@keyframes eggBob/)
})
