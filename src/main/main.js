// Veil — main process.
process.env.TZ = 'UTC' // ADR 0006: every user reports the same timezone

const {
  app, BaseWindow, WebContentsView, ipcMain, session, protocol, Menu, clipboard, dialog,
} = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { getDomain } = require('tldts')
const { TorManager } = require('./tor')
const { IsolationRelay } = require('./relay')
const { Community, COMMUNITY_DIR } = require('./community')

const SRC = path.join(__dirname, '..')
const UI_PRELOAD = path.join(SRC, 'preload', 'ui.js')
const PAGE_PRELOAD = path.join(SRC, 'preload', 'page.js')
const PAGES_DIR = path.join(SRC, 'renderer', 'pages')

const TOOLBAR_HEIGHT = 88
const PANEL_WIDTH = 340
const HOME = 'veil://hub/'
const SEARCH = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q='

// ADR 0006: one uniform user agent — a common Chrome on Windows,
// matching our real Chromium major version so it isn't trivially inconsistent.
const CHROME_MAJOR = process.versions.chrome.split('.')[0]
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

// ADR 0004: leak prevention at the engine level.
const sw = app.commandLine
// Chromium can't resolve any hostname itself; only our loopback relay is reachable
sw.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND , EXCLUDE 127.0.0.1')
sw.appendSwitch('disable-quic') // UDP can't go through Tor
sw.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
sw.appendSwitch('dns-prefetch-disable')
sw.appendSwitch('disable-background-networking')
sw.appendSwitch('disable-component-update')
sw.appendSwitch('disable-domain-reliability')
sw.appendSwitch('no-pings')
sw.appendSwitch('lang', 'en-US')

protocol.registerSchemesAsPrivileged([
  { scheme: 'veil', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const tor = new TorManager()
let relay
let community
let win
let uiView
let level = 'standard' // standard | safer | safest
let panelOpen = false
let identity = newIdentityState()
const tabs = new Map()
let activeId = null
let nextTabId = 1
const sessions = new Map() // site -> Promise<Session>

function newIdentityState() {
  return { nonce: crypto.randomBytes(8).toString('hex') }
}

// ---------- sites & sessions ----------

// First-party key: the registrable domain (eTLD+1), e.g. news.bbc.co.uk -> bbc.co.uk
function siteFor(url) {
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol === 'veil:') return 'veil'
  if (!/^(https?|wss?):$/.test(u.protocol)) return null
  const host = u.hostname
  if (host.endsWith('.onion')) return host.split('.').slice(-2).join('.')
  return getDomain(host) || host
}

function hardenSession(ses) {
  ses.setUserAgent(USER_AGENT, 'en-US,en')
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false)) // camera, mic, location, notifications...
  ses.setPermissionCheckHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', e => e.preventDefault())

  // Kill switch (ADR 0004): only web schemes, and only once tor is ready.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = tor.ready && /^(https?|wss?|data|blob):/.test(details.url)
    cb({ cancel: !ok })
  })
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    h['Accept-Language'] = 'en-US,en;q=0.9'
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === 'sec-ch-ua-platform') h[k] = '"Windows"'
    }
    cb({ requestHeaders: h })
  })
}

// ADR 0005: one in-memory partition per site per identity. No "persist:" prefix
// means nothing is written to disk.
function sessionFor(site) {
  if (site === 'veil') return Promise.resolve(internalSession())
  if (!sessions.has(site)) {
    sessions.set(site, (async () => {
      const id = crypto.createHash('sha256').update(`${site}|${identity.nonce}`).digest('hex').slice(0, 24)
      const ses = session.fromPartition(`veil-${id}`, { cache: false })
      const port = await relay.portFor(site)
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: '<-loopback>', // even localhost goes through Tor (which refuses it)
      })
      hardenSession(ses)
      return ses
    })())
  }
  return sessions.get(site)
}

let _internal
function internalSession() {
  if (_internal) return _internal
  _internal = session.fromPartition('veil-internal', { cache: false })
  _internal.protocol.handle('veil', req => {
    const { hostname } = new URL(req.url)
    const file = path.join(PAGES_DIR, `${hostname.replace(/[^a-z]/g, '')}.html`)
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 })
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  // Internal pages never touch the network.
  _internal.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(veil|data|blob|devtools):/.test(d.url) }))
  _internal.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'))
  _internal.setSpellCheckerEnabled(false)
  return _internal
}

// ---------- tabs ----------

function tabFor(wc) {
  for (const t of tabs.values()) if (t.view?.webContents === wc) return t
  return null
}

function siteSeed(site) {
  return crypto.createHash('sha256').update(`seed|${site}|${identity.nonce}`).digest().readUInt32LE(0)
}

function createTab(url = HOME, { activate = true } = {}) {
  const tab = { id: nextTabId++, url: '', title: 'New Tab', site: null, view: null, loading: false, error: null }
  tabs.set(tab.id, tab)
  if (activate || activeId == null) activeId = tab.id
  loadInTab(tab, url)
  sendState()
  return tab
}

async function loadInTab(tab, url) {
  const site = siteFor(url)
  if (!site) return
  tab.error = null
  tab.url = url
  if (site !== tab.site || !tab.view || tab.level !== level) {
    // Different first party: brand-new view in that site's partition (ADR 0005).
    const ses = await sessionFor(site)
    if (!tabs.has(tab.id)) return
    replaceView(tab, site, ses)
  }
  tab.view.webContents.loadURL(url).catch(() => {})
  sendState()
}

function replaceView(tab, site, ses) {
  const internal = site === 'veil'
  if (tab.view) {
    win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: PAGE_PRELOAD,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: false, // preload must patch the page's own globals before page scripts run
      nodeIntegrationInSubFrames: true, // ...including inside iframes (still no Node: sandboxed)
      javascript: internal || level !== 'safest',
      webgl: internal || level === 'standard',
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  })
  view.setBackgroundColor('#0d0f14')
  tab.view = view
  tab.site = site
  tab.level = level

  const wc = view.webContents
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  wc.setWindowOpenHandler(({ url }) => {
    if (siteFor(url) && siteFor(url) !== 'veil') createTab(url)
    return { action: 'deny' }
  })
  const crossSite = (e, url) => {
    if (url.startsWith('veil:') && tab.site !== 'veil') return e.preventDefault() // web can't open internal pages
    const s = siteFor(url)
    if (!s) return e.preventDefault()
    if (s !== tab.site) {
      e.preventDefault()
      loadInTab(tab, url)
    }
  }
  wc.on('will-navigate', e => crossSite(e, e.url))
  wc.on('will-redirect', e => { if (e.isMainFrame) crossSite(e, e.url) })

  const update = () => {
    tab.url = wc.getURL() || tab.url
    tab.title = wc.getTitle() || tab.url
    sendState()
  }
  wc.on('did-start-loading', () => { tab.loading = true; tab.error = null; layout(); sendState() })
  wc.on('did-stop-loading', () => { tab.loading = false; update() })
  wc.on('page-title-updated', update)
  wc.on('did-navigate', update)
  wc.on('did-navigate-in-page', update)
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted (we redirected it)
    tab.error = tor.ready ? `${desc} (${code})` : 'Blocked: not connected to Tor yet'
    layout()
    sendState()
  })

  win.contentView.addChildView(view)
  layout()
}

function closeTab(id) {
  const tab = tabs.get(id)
  if (!tab) return
  tabs.delete(id)
  if (tab.view) {
    win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  if (activeId === id) activeId = [...tabs.keys()].pop() ?? null
  if (activeId == null) createTab()
  layout()
  sendState()
}

function activeTab() {
  return tabs.get(activeId)
}

// ADR 0006 letterboxing: page viewport is rounded down to multiples of
// 200x100 and centered, so window size can't fingerprint you.
function layout() {
  if (!win) return
  const [w, h] = win.getContentSize()
  uiView.setBounds({ x: 0, y: 0, width: w, height: h })
  const area = { x: 0, y: TOOLBAR_HEIGHT, width: w - (panelOpen ? PANEL_WIDTH : 0), height: h - TOOLBAR_HEIGHT }
  for (const tab of tabs.values()) {
    if (!tab.view) continue
    const visible = tab.id === activeId && !tab.error // errors show the UI's error card
    tab.view.setVisible(visible)
    if (!visible) continue
    let { x, y, width, height } = area
    if (tab.site !== 'veil') {
      const lw = width >= 200 ? Math.floor(width / 200) * 200 : width
      const lh = height >= 100 ? Math.floor(height / 100) * 100 : height
      x += Math.floor((width - lw) / 2)
      y += Math.floor((height - lh) / 2)
      width = lw
      height = lh
    }
    tab.view.setBounds({ x, y, width, height })
  }
}

// ---------- UI state ----------

function sendState() {
  if (!uiView || uiView.webContents.isDestroyed()) return
  uiView.webContents.send('veil:state', {
    tabs: [...tabs.values()].map(t => ({
      id: t.id, title: t.title, url: t.url, site: t.site, loading: t.loading, error: t.error,
      canBack: !!t.view?.webContents.navigationHistory.canGoBack(),
      canForward: !!t.view?.webContents.navigationHistory.canGoForward(),
    })),
    activeId,
    tor: tor.status(),
    level,
    panelOpen,
  })
}

function normalizeInput(input) {
  const s = String(input || '').trim()
  if (!s) return null
  if (/^(https?|veil):\/\//i.test(s)) return s
  if (!/\s/.test(s) && /^[^/]+\.[a-z0-9-]{2,}(:\d+)?(\/.*)?$/i.test(s)) {
    const host = s.split('/')[0]
    return (host.endsWith('.onion') ? 'http://' : 'https://') + s
  }
  return SEARCH + encodeURIComponent(s)
}

// ---------- identity ----------

async function newIdentity({ panic = false } = {}) {
  for (const tab of tabs.values()) {
    if (!tab.view) continue
    win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  tabs.clear()
  activeId = null
  const old = [...sessions.values()]
  sessions.clear()
  identity = newIdentityState()
  await relay.rotate(identity.nonce)
  for (const p of old) {
    const ses = await p.catch(() => null)
    if (!ses) continue
    ses.closeAllConnections()
    await ses.clearStorageData().catch(() => {})
    await ses.clearCache().catch(() => {})
    await ses.clearAuthCache().catch(() => {})
  }
  if (tor.control) await tor.control.signal('NEWNYM').catch(() => {})
  if (panic) {
    clipboard.clear()
    await community.wipe()
  }
  createTab(HOME)
}

async function newCircuitForSite() {
  const tab = activeTab()
  if (!tab || tab.site === 'veil') return
  relay.newCircuit(tab.site)
  const ses = await sessionFor(tab.site)
  await ses.closeAllConnections()
  tab.view.webContents.reload()
}

async function circuitInfo() {
  const tab = activeTab()
  if (!tab || tab.site === 'veil' || !tor.control) return { site: tab?.site || null, circuit: null }
  const { username, password } = relay.credentialsFor(tab.site)
  const circuit = await tor.control.circuitFor(username, password).catch(() => null)
  return { site: tab.site, circuit }
}

// ---------- leak test (veil://leaktest) ----------

async function torCheckFrom(site) {
  const ses = await sessionFor(site)
  const res = await ses.fetch('https://check.torproject.org/api/ip', { cache: 'no-store' })
  return res.json()
}

async function networkTest() {
  const result = {}
  try { result.tor = await torCheckFrom('leaktest-a.example') } catch (e) { result.tor = { error: e.message } }
  try { result.isolated = await torCheckFrom('leaktest-b.example') } catch (e) { result.isolated = { error: e.message } }
  // Local DNS must be impossible: Chromium's resolver should refuse everything.
  try {
    const ses = await sessionFor('leaktest-a.example')
    await ses.resolveHost('example.com')
    result.dns = { blocked: false }
  } catch {
    result.dns = { blocked: true }
  }
  return result
}

// ---------- IPC ----------

function fromUI(e) {
  return e.sender === uiView.webContents
}

function fromInternalPage(e) {
  const tab = tabFor(e.sender)
  return tab?.site === 'veil' && e.senderFrame?.url.startsWith('veil://')
}

ipcMain.on('veil:page-config', e => {
  const tab = tabFor(e.sender)
  e.returnValue = { seed: tab ? siteSeed(tab.site) : 0, level: tab?.level || level }
})

const uiCommands = {
  newTab: url => createTab(normalizeInput(url) || HOME),
  closeTab: id => closeTab(id),
  activate: id => { if (tabs.has(id)) { activeId = id; layout(); sendState() } },
  navigate: input => {
    const url = normalizeInput(input)
    const tab = activeTab()
    if (url && tab) loadInTab(tab, url)
  },
  back: () => activeTab()?.view?.webContents.navigationHistory.goBack(),
  forward: () => activeTab()?.view?.webContents.navigationHistory.goForward(),
  reload: () => activeTab()?.view?.webContents.reload(),
  stop: () => activeTab()?.view?.webContents.stop(),
  setLevel: l => {
    if (!['standard', 'safer', 'safest'].includes(l)) return
    level = l
    for (const t of tabs.values()) if (t.url) loadInTab(t, t.view?.webContents.getURL() || t.url)
    sendState()
  },
  panel: open => { panelOpen = !!open; layout(); sendState() },
  newIdentity: () => newIdentity(),
  panic: () => newIdentity({ panic: true }),
  newCircuit: () => newCircuitForSite(),
  circuit: () => circuitInfo(),
}

ipcMain.handle('veil:ui', async (e, cmd, ...args) => {
  if (!fromUI(e) || !uiCommands[cmd]) return null
  return uiCommands[cmd](...args)
})

// Commands that work before tor is connected; the rest need the network.
const OFFLINE_OK = new Set(['status', 'open', 'directory', 'hosted'])

const internalCommands = {
  status: () => ({ tor: tor.status(), level }),
  open: (sender, input) => {
    const url = normalizeInput(input)
    const tab = tabFor(sender)
    if (url && tab) loadInTab(tab, url)
  },
  directory: () => community.directory(),
  join: (sender, invite) => community.join(invite),
  hostSample: (sender, inviteOnly) => community.host({ folder: path.join(COMMUNITY_DIR, 'sample-site'), inviteOnly }),
  hostFolder: async (sender, inviteOnly) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a folder to host' })
    if (r.canceled || !r.filePaths[0]) return null
    return community.host({ folder: r.filePaths[0], inviteOnly })
  },
  stopHosting: (sender, id) => community.stopHosting(id),
  hosted: () => community.listHosted(),
  networkTest: () => networkTest(),
}

ipcMain.handle('veil:internal', async (e, cmd, ...args) => {
  if (!fromInternalPage(e) || !internalCommands[cmd]) throw new Error('not allowed')
  if (!OFFLINE_OK.has(cmd) && !tor.ready) throw new Error('Not connected to Tor yet')
  return internalCommands[cmd](e.sender, ...args)
})

// ---------- window & menu ----------

function buildMenu() {
  const veilItems = [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
    { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => uiView.webContents.send('veil:focus-address') },
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => uiCommands.reload() },
    { type: 'separator' },
    { label: 'New Identity', accelerator: 'CmdOrCtrl+Shift+U', click: () => newIdentity() },
    { label: 'New Circuit for This Site', accelerator: 'CmdOrCtrl+Shift+L', click: () => newCircuitForSite() },
    { label: 'PANIC — Wipe Everything', accelerator: 'CmdOrCtrl+Shift+X', click: () => newIdentity({ panic: true }) },
    { type: 'separator' },
    { label: 'Leak Test', click: () => createTab('veil://leaktest/') },
    { label: 'Community Hub', click: () => createTab(HOME) },
    { label: 'Toggle Page DevTools', accelerator: 'Alt+CmdOrCtrl+I', click: () => activeTab()?.view?.webContents.toggleDevTools() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Veil', submenu: veilItems },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]))
}

function createWindow() {
  win = new BaseWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 480,
    title: 'Veil', backgroundColor: '#0d0f14',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
  })
  uiView = new WebContentsView({
    webPreferences: { preload: UI_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  uiView.setBackgroundColor('#0d0f14')
  uiView.webContents.loadFile(path.join(SRC, 'renderer', 'ui.html'))
  uiView.webContents.on('will-navigate', e => e.preventDefault())
  uiView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  uiView.webContents.on('did-finish-load', sendState)
  win.contentView.addChildView(uiView)
  win.on('resize', layout)
  win.on('closed', () => { win = null; app.quit() })
  layout()
}

app.whenReady().then(async () => {
  // The UI loads from disk; refuse any network from the default session too.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|data):/.test(d.url) }))

  buildMenu()
  createWindow()

  relay = new IsolationRelay({ torPort: 0, isReady: () => tor.ready })
  community = new Community({ getControl: () => tor.control })
  tor.on('status', sendState)
  await tor.start()
  relay.torPort = tor.socksPort
  await relay.rotate(identity.nonce)

  createTab(HOME)

  if (process.env.VEIL_SELFTEST) {
    const { runSelfTest } = require('./selftest')
    const pageProbe = tab => tab.view.webContents.executeJavaScript(`({
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset(),
      rtc: typeof RTCPeerConnection,
      platform: navigator.platform,
      screen: screen.width + 'x' + screen.height,
      inner: innerWidth + 'x' + innerHeight,
    })`)
    runSelfTest({ tor, networkTest, createTab, circuitInfo, community, pageProbe, newCircuit: newCircuitForSite })
      .then(failed => failed ? 1 : 0)
      .catch(err => { console.error('SELFTEST ERROR', err); return 2 })
      .then(code => { community.stop(); tor.stop(); app.exit(code) }) // app.exit skips before-quit
  }
})

app.on('web-contents-created', (e, wc) => {
  wc.on('will-attach-webview', ev => ev.preventDefault())
})

app.on('before-quit', () => {
  community?.stop()
  tor.stop()
})

app.on('window-all-closed', () => app.quit())
