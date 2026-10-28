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
const { Bookmarks } = require('./bookmarks')
const { attachContextMenu } = require('./contextmenu')
const { AdBlocker } = require('./adblock')

const SRC = path.join(__dirname, '..')
const UI_PRELOAD = path.join(SRC, 'preload', 'ui.js')
const PAGE_PRELOAD = path.join(SRC, 'preload', 'page.js')
const PAGES_DIR = path.join(SRC, 'renderer', 'pages')

const TOOLBAR_HEIGHT = 76
const FIND_HEIGHT = 34
const PANEL_WIDTH = 340
const HOME = 'veil://hub/'
const SEARCH = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/?q='

// ADR 0006: one uniform user agent — a common Chrome on Windows,
// matching our real Chromium major version so it isn't trivially inconsistent.
// Per-OS bucket like Tor Browser: the real OS family, generic version (ADR 0010).
const CHROME_MAJOR = process.versions.chrome.split('.')[0]
const OS_BUCKET = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
const UA_OS = {
  mac: ['Macintosh; Intel Mac OS X 10_15_7', '"macOS"'],
  windows: ['Windows NT 10.0; Win64; x64', '"Windows"'],
  linux: ['X11; Linux x86_64', '"Linux"'],
}[OS_BUCKET]
const USER_AGENT = `Mozilla/5.0 (${UA_OS[0]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

// Request headers that describe your device or network (client hints and
// their legacy forms). Only the low-detail sec-ch-ua, -mobile and -platform stay,
// because real Chrome always sends those.
const REVEALING_HEADER = /^(sec-ch-ua-(arch|bitness|full-version|full-version-list|model|platform-version|wow64|form-factors?)|sec-ch-(dpr|device-memory|viewport-width|viewport-height|width|prefers-color-scheme|prefers-reduced-motion|prefers-reduced-transparency|prefers-contrast|forced-colors|save-data|downlink|ect|rtt)|dpr|device-memory|viewport-width|width|downlink|ect|rtt|save-data|x-client-data)$/
// Response headers that ask the browser to start sending them.
const CLIENT_HINT_REQUEST = /^(accept-ch|critical-ch)$/

// Everyone reports the same system preferences, enforced in the engine so CSS
// media queries and matchMedia() agree.
const EMULATED_MEDIA = [
  { name: 'prefers-color-scheme', value: 'light' },
  { name: 'prefers-reduced-motion', value: 'no-preference' },
  { name: 'prefers-reduced-transparency', value: 'no-preference' },
  { name: 'prefers-contrast', value: 'no-preference' },
  { name: 'forced-colors', value: 'none' },
]

// Built-in bridges from Tor Browser's pt_config.json (REVERSE_ENGINEERING.md)
const PT_CONFIG = require('../../assets/pt_config.json')
const BRIDGE_MODES = ['none', 'snowflake', 'obfs4', 'meek', 'custom']

// tor's ExtendedErrors SOCKS replies (Tor Browser turns these into specific error pages)
const ONION_ERRORS = {
  0xF0: 'Onion site not found. It may be offline, or the address is wrong.',
  0xF1: 'Onion site is unreachable: its descriptor is invalid.',
  0xF2: 'Onion site disconnected: introduction failed. It may be offline or overloaded.',
  0xF3: 'Onion site disconnected: the rendezvous failed. Try a new circuit (⌘⇧L).',
  0xF4: 'This onion site is invite-only. Join it with an invite in the Community Hub.',
  0xF5: 'Your invite key for this onion site was rejected.',
  0xF6: 'Invalid onion address. Check it for typos.',
  0xF7: 'Onion site timed out. It may be offline or overloaded.',
}

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
let findOpen = false
let fullscreen = false
let identity = newIdentityState()
let tabs = new Map() // insertion order = tab order
let history = [] // this session only, never written to disk
let closedTabs = []
let bookmarks
let toast = null
const adblock = new AdBlocker()
let settings = { bridges: 'none', customBridges: [] } // the only settings Veil saves
const httpAllowed = new Set() // hosts the user let load over plain HTTP (this session only)
const socksErrors = new Map() // site -> { code, at } from tor's ExtendedErrors
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

function tabByWebContentsId(id) {
  for (const t of tabs.values()) if (t.view?.webContents.id === id) return t
  return null
}

function hardenSession(ses, site) {
  ses.setUserAgent(USER_AGENT, 'en-US,en')
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false)) // camera, mic, location, notifications...
  ses.setPermissionCheckHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', (e, item) => {
    const name = item.getFilename()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Download', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Download "${name}"?`,
      detail: 'The download itself goes through Tor. But some files (PDFs, Office documents, media) can '
        + 'connect to the internet directly when opened outside Veil and reveal your real IP. '
        + 'Open them offline.',
    })
    if (choice !== 0) return e.preventDefault()
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) })
    showToast(`Downloading ${name}…`)
    item.once('done', (ev, st) => showToast(st === 'completed' ? `Downloaded ${name}` : `Download ${st}: ${name}`))
  })

  // Onion-Location: a site advertising its .onion version (like Tor Browser's ".onion available")
  ses.webRequest.onHeadersReceived((d, cb) => {
    if (d.resourceType === 'mainFrame' && d.responseHeaders) {
      const key = Object.keys(d.responseHeaders).find(k => k.toLowerCase() === 'onion-location')
      const loc = key && d.responseHeaders[key][0]
      const tab = loc && [...tabs.values()].find(t => t.view?.webContents.id === d.webContentsId)
      if (tab && /^https?:\/\/([a-z0-9-]+\.)*[a-z2-7]{56}\.onion(\/|$)/.test(loc)) {
        tab.onionLocation = loc
        sendState()
      }
    }
    if (!d.responseHeaders) return cb({})
    // Sites can't ask for detailed device/network client hints.
    let headers = Object.fromEntries(Object.entries(d.responseHeaders).filter(([k]) => !CLIENT_HINT_REQUEST.test(k.toLowerCase())))
    let changed = Object.keys(headers).length !== Object.keys(d.responseHeaders).length
    // Pages served from an .onion never reveal its address to other sites
    // (Tor Browser: network.http.referer.hideOnionSource). Forcing the
    // document's Referrer-Policy lets Chromium itself enforce it.
    if (/^(mainFrame|subFrame)$/.test(d.resourceType) && new URL(d.url).hostname.endsWith('.onion')) {
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'referrer-policy'))
      headers['Referrer-Policy'] = ['same-origin']
      changed = true
    }
    cb(changed ? { responseHeaders: headers } : {})
  })

  // Kill switch (ADR 0004): only web schemes, and only once tor is ready.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = tor.ready && /^(https?|wss?|data|blob):/.test(details.url)
    if (!ok) return cb({ cancel: true })
    // HTTPS-Only mode, like Tor Browser (onions exempt: they're already end-to-end encrypted)
    if (details.resourceType === 'mainFrame' && details.url.startsWith('http://')) {
      const host = new URL(details.url).hostname
      if (!host.endsWith('.onion') && !httpAllowed.has(host)) {
        const tab = tabByWebContentsId(details.webContentsId)
        if (tab) tab.upgradedFrom = details.url
        return cb({ redirectURL: 'https://' + details.url.slice('http://'.length) })
      }
    }
    // Ads & trackers (ADR 0009)
    const verdict = /^(https?|wss?):/.test(details.url) && adblock.check(details, site)
    if (verdict) {
      const tab = tabByWebContentsId(details.webContentsId)
      if (tab) { tab.blocked++; scheduleState() }
      return cb(verdict)
    }
    cb({ cancel: false })
  })
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    h['Accept-Language'] = 'en-US,en;q=0.9'
    for (const k of Object.keys(h)) {
      const key = k.toLowerCase()
      if (REVEALING_HEADER.test(key)) { delete h[k]; continue }
      if (key === 'sec-ch-ua-platform') h[k] = UA_OS[1]
      // Referer, like Tor Browser: never reveal an .onion to another site,
      // and send only the origin (no path) across sites.
      if (key === 'referer') {
        try {
          const from = new URL(h[k])
          const to = new URL(details.url)
          if (from.hostname.endsWith('.onion') && siteFor(from.href) !== siteFor(to.href)) delete h[k]
          else if (from.origin !== to.origin) h[k] = from.origin + '/'
        } catch { delete h[k] }
      }
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
      hardenSession(ses, site)
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
  const tab = {
    id: nextTabId++, url: '', title: 'New Tab', site: null, view: null, loading: false, error: null,
    favicon: null, zoom: 0, onionLocation: null, find: null, blocked: 0,
  }
  tabs.set(tab.id, tab)
  if (activate || activeId == null) activeId = tab.id
  if (process.env.VEIL_DEBUG) console.log(`[tabs] created ${tab.id} ${url}, active now ${activeId}`)
  loadInTab(tab, url)
  sendState()
  return tab
}

async function loadInTab(tab, url) {
  const site = siteFor(url)
  if (!site) return
  tab.error = null
  tab.url = url
  const js = jsAllowed(url, site)
  if (site !== tab.site || !tab.view || tab.level !== level || tab.js !== js) {
    // Different first party: brand-new view in that site's partition (ADR 0005).
    const ses = await sessionFor(site)
    if (!tabs.has(tab.id)) return
    replaceView(tab, site, ses, js)
  }
  tab.view.webContents.loadURL(url).catch(() => {})
  sendState()
}

// Safest: no JavaScript. Safer: no JavaScript on plain-HTTP pages (NoScript's
// rule in Tor Browser); onions count as secure.
function jsAllowed(url, site) {
  if (site === 'veil') return true
  if (level === 'safest') return false
  if (level === 'safer') return !/^http:/.test(url) || site.endsWith('.onion')
  return true
}

function replaceView(tab, site, ses, js = true) {
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
      javascript: js,
      webgl: internal || level === 'standard',
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  })
  view.setBackgroundColor('#ffffff')
  tab.view = view
  tab.site = site
  tab.level = level
  tab.js = js

  const wc = view.webContents
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  if (process.env.VEIL_DEBUG) {
    wc.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') console.log(`[page ${site}] ${e.message}`) })
    wc.on('preload-error', (e, file, err) => console.log(`[preload ${site}] ${err.stack || err}`))
  }
  if (!internal) {
    // Engine-level overrides (Chrome DevTools Protocol), so CSS and JavaScript
    // see the same answers: fixed system preferences now, screen size in layout().
    try {
      wc.debugger.attach('1.3')
      wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: EMULATED_MEDIA }).catch(() => {})
    } catch {}
  }
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (siteFor(url) && siteFor(url) !== 'veil') createTab(url, { activate: disposition !== 'background-tab' })
    return { action: 'deny' }
  })
  attachContextMenu(wc, {
    openInNewTab: url => createTab(url, { activate: false }),
    search: text => createTab(SEARCH + encodeURIComponent(text)),
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
    const entry = history.find(h => h.url === tab.url)
    if (entry) entry.title = tab.title
    sendState()
  }
  wc.on('did-start-navigation', (e, url, inPlace, isMain) => {
    if ((e.isMainFrame ?? isMain) && !(e.isSameDocument ?? inPlace)) { tab.onionLocation = null; tab.favicon = null; tab.blocked = 0 }
  })
  wc.on('did-navigate', (e, url) => {
    tab.upgradedFrom = null
    if (!/^https?:/.test(url)) return
    history = [{ url, title: wc.getTitle() || url, time: Date.now() }, ...history.filter(h => h.url !== url)].slice(0, 300)
  })
  wc.on('page-favicon-updated', async (e, favicons) => {
    const src = favicons.find(f => /^https?:/.test(f))
    if (!src) return
    try {
      const res = await wc.session.fetch(src) // through this site's Tor circuit
      const type = res.headers.get('content-type') || ''
      const buf = Buffer.from(await res.arrayBuffer())
      if (!res.ok || !type.startsWith('image/') || buf.length > 200000) return
      tab.favicon = `data:${type};base64,${buf.toString('base64')}`
      sendState()
    } catch {}
  })
  wc.on('dom-ready', () => {
    const css = tab.site !== 'veil' && adblock.cosmeticCSS(wc.getURL(), tab.site)
    if (css) wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => {})
  })
  wc.on('found-in-page', (e, r) => { tab.find = { active: r.activeMatchOrdinal, matches: r.matches }; sendState() })
  wc.on('zoom-changed', (e, dir) => zoomTab(tab, dir === 'in' ? 1 : -1))
  wc.on('enter-html-full-screen', () => { fullscreen = true; win.setFullScreen(true); layout(); sendState() })
  wc.on('leave-html-full-screen', () => { fullscreen = false; win.setFullScreen(false); layout(); sendState() })
  wc.on('did-start-loading', () => { tab.loading = true; tab.error = null; layout(); sendState() })
  wc.on('did-stop-loading', () => { tab.loading = false; update() })
  wc.on('page-title-updated', update)
  wc.on('did-navigate', update)
  wc.on('did-navigate-in-page', update)
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted (we redirected it)
    const se = socksErrors.get(tab.site)
    tab.httpFallback = null
    if (!tor.ready) tab.error = 'Waiting for Tor to connect (takes about 15 seconds). This page will load by itself.'
    else if (se && Date.now() - se.at < 60000 && ONION_ERRORS[se.code]) tab.error = ONION_ERRORS[se.code]
    else if (tab.upgradedFrom && url.startsWith('https://')) {
      tab.error = "This site doesn't offer a secure connection (HTTPS). Veil upgrades every site to HTTPS, like Tor Browser's HTTPS-Only mode."
      tab.httpFallback = tab.upgradedFrom
    } else tab.error = `${desc} (${code})`
    tab.upgradedFrom = null
    layout()
    sendState()
  })

  win.contentView.addChildView(view)
  layout()
}

function closeTab(id) {
  const tab = tabs.get(id)
  if (!tab) return
  const ids = [...tabs.keys()]
  const idx = ids.indexOf(id)
  tabs.delete(id)
  if (tab.url && !tab.url.startsWith(HOME)) closedTabs = [tab.url, ...closedTabs].slice(0, 20)
  if (tab.view) {
    win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  if (activeId === id) activeId = ids[idx + 1] ?? ids[idx - 1] ?? null
  if (process.env.VEIL_DEBUG) console.log(`[tabs] closed ${id}, active now ${activeId}`)
  if (activeId == null) createTab()
  layout()
  sendState()
}

function activeTab() {
  return tabs.get(activeId)
}

function selectTab(index) {
  const ids = [...tabs.keys()]
  if (!ids.length) return
  const id = index === 'last' ? ids.at(-1) : ids[index]
  if (id != null) uiCommands.activate(id)
}

function cycleTab(step) {
  const ids = [...tabs.keys()]
  const i = ids.indexOf(activeId)
  selectTab((i + step + ids.length) % ids.length)
}

function moveTab(id, toIndex) {
  const entries = [...tabs.entries()]
  const from = entries.findIndex(([k]) => k === id)
  if (from < 0) return
  const [moved] = entries.splice(from, 1)
  entries.splice(Math.max(0, Math.min(toIndex, entries.length)), 0, moved)
  tabs = new Map(entries)
  sendState()
}

function reopenClosedTab() {
  const [url, ...rest] = closedTabs
  if (!url) return
  closedTabs = rest
  createTab(url)
}

// Chrome's zoom steps: 1.2^level
function zoomTab(tab, dir) {
  const wc = tab?.view?.webContents
  if (!wc) return
  tab.zoom = dir === 0 ? 0 : Math.max(-3, Math.min(5, tab.zoom + dir * 0.5))
  wc.setZoomLevel(tab.zoom)
  sendState()
}

function showToast(text) {
  toast = { text, id: Date.now() }
  sendState()
  const id = toast.id
  setTimeout(() => { if (toast?.id === id) { toast = null; sendState() } }, 5000)
}

function suggestions() {
  const seen = new Set()
  return [...bookmarks.list(), ...history]
    .filter(h => !seen.has(h.url) && seen.add(h.url))
    .slice(0, 60)
    .map(h => ({ url: h.url, title: h.title }))
}

// ADR 0006 letterboxing: page viewport is rounded down to multiples of
// 200x100 and centered, so window size can't fingerprint you.
function layout() {
  if (!win) return
  const [w, h] = win.getContentSize()
  uiView.setBounds({ x: 0, y: 0, width: w, height: h })
  const top = fullscreen ? 0 : TOOLBAR_HEIGHT + (findOpen ? FIND_HEIGHT : 0)
  const area = { x: 0, y: top, width: w - (panelOpen && !fullscreen ? PANEL_WIDTH : 0), height: h - top }
  for (const tab of tabs.values()) {
    if (!tab.view) continue
    const visible = tab.id === activeId && !tab.error // errors show the UI's error card
    tab.view.setVisible(visible)
    if (!visible) continue
    let { x, y, width, height } = area
    if (tab.site !== 'veil') { // also in full screen: the real screen size never shows
      const lw = width >= 200 ? Math.floor(width / 200) * 200 : width
      const lh = height >= 100 ? Math.floor(height / 100) * 100 : height
      x += Math.floor((width - lw) / 2)
      y += Math.floor((height - lh) / 2)
      width = lw
      height = lh
    }
    tab.view.setBounds({ x, y, width, height })
    const screenKey = `${width}x${height}`
    if (tab.site !== 'veil' && tab.screenKey !== screenKey && tab.view.webContents.debugger.isAttached()) {
      tab.screenKey = screenKey
      tab.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 0, height: 0, deviceScaleFactor: 0, mobile: false, // 0 = keep the real viewport and pixel ratio
        screenWidth: width, screenHeight: height, positionX: 0, positionY: 0,
      }).catch(() => {})
    }
  }
}

// ---------- UI state ----------

// Blocked-request counts change many times per page load; batch the UI updates.
let stateTimer = null
function scheduleState() {
  if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; sendState() }, 250)
}

function sendState() {
  if (!uiView || uiView.webContents.isDestroyed()) return
  uiView.webContents.send('veil:state', {
    tabs: [...tabs.values()].map(t => ({
      id: t.id, title: t.title, url: t.url, site: t.site, loading: t.loading, error: t.error, httpFallback: !!t.httpFallback,
      favicon: t.favicon, zoom: Math.round(Math.pow(1.2, t.zoom) * 100), onionLocation: t.onionLocation,
      find: t.find, bookmarked: !!bookmarks?.has(t.url),
      blocked: t.blocked, adblockOn: t.site !== 'veil' && adblock.active(t.site),
      canBack: !!t.view?.webContents.navigationHistory.canGoBack(),
      canForward: !!t.view?.webContents.navigationHistory.canGoForward(),
    })),
    activeId,
    tor: tor.status(),
    level,
    panelOpen,
    findOpen,
    fullscreen,
    toast: toast?.text || null,
    suggestions: bookmarks ? suggestions() : [],
    canReopen: closedTabs.length > 0,
    adblockEnabled: adblock.enabled,
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
  history = []
  closedTabs = []
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
    bookmarks.wipe()
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

// Data for veil://routing: the real circuit for a site plus live tor stats.
async function routingInfo(site) {
  const sites = [...new Set([...tabs.values()].map(t => t.site).filter(x => x && x !== 'veil'))]
  site = site || sites[0] || null
  if (!site || !tor.control) return { site, sites, circuit: null }
  const { username, password } = relay.credentialsFor(site)
  const circuit = await tor.control.circuitFor(username, password).catch(() => null)
  const streams = circuit ? await tor.control.streamsOn(circuit.id).catch(() => []) : []
  const traffic = await tor.control.traffic().catch(() => null)
  return { site, sites, circuit, streams, traffic }
}

// ---------- connection settings (bridges) ----------

let wasReady = false // flips once per tor start, so blocked tabs reload when it connects

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    if (BRIDGE_MODES.includes(saved.bridges)) settings = { ...settings, ...saved }
  } catch {}
}

function saveSettings() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}

function bridgeLines() {
  if (settings.bridges === 'none') return []
  if (settings.bridges === 'custom') return settings.customBridges
  return PT_CONFIG.bridges[settings.bridges] || []
}

async function reconnect() {
  wasReady = false
  await tor.restart({ bridges: bridgeLines() })
  relay.torPort = tor.socksPort
  sendState()
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
  e.returnValue = { seed: tab ? siteSeed(tab.site) : 0, level: tab?.level || level, os: OS_BUCKET }
})

const uiCommands = {
  newTab: url => { createTab(normalizeInput(url) || HOME) },
  allowHttp: () => {
    const t = activeTab()
    if (!t?.httpFallback) return
    httpAllowed.add(new URL(t.httpFallback).hostname)
    loadInTab(t, t.httpFallback)
  },
  closeTab: id => closeTab(id),
  activate: id => {
    if (process.env.VEIL_DEBUG) console.log(`[tabs] activate ${id} (was ${activeId})`)
    if (tabs.has(id)) { activeId = id; layout(); sendState() }
  },
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
  watchRouting: () => {
    const site = activeTab()?.site
    createTab(`veil://routing/${site && site !== 'veil' ? `?site=${encodeURIComponent(site)}` : ''}`)
  },
  moveTab: (id, toIndex) => moveTab(id, toIndex),
  reopenClosed: () => reopenClosedTab(),
  tabMenu: id => {
    const t = tabs.get(id)
    if (!t) return
    Menu.buildFromTemplate([
      { label: 'New Tab', click: () => createTab() },
      { type: 'separator' },
      { label: 'Reload', click: () => t.view?.webContents.reload() },
      { label: 'Duplicate', click: () => createTab(t.url) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => closeTab(id) },
      { label: 'Close Other Tabs', enabled: tabs.size > 1, click: () => { for (const o of [...tabs.keys()]) if (o !== id) closeTab(o) } },
      { type: 'separator' },
      { label: 'Reopen Closed Tab', enabled: closedTabs.length > 0, click: reopenClosedTab },
    ]).popup()
  },
  bookmark: () => {
    const t = activeTab()
    if (!t || t.site === 'veil') return
    const on = bookmarks.toggle(t.url, t.title)
    showToast(on ? 'Bookmarked (saved on this computer)' : 'Bookmark removed')
  },
  toggleAdblockSite: () => {
    const t = activeTab()
    if (!t || t.site === 'veil') return
    const on = adblock.toggleSite(t.site)
    showToast(on ? `Blocking ads on ${t.site}` : `Ads allowed on ${t.site} (this session only)`)
    t.view.webContents.reload()
  },
  toggleAdblock: () => {
    adblock.enabled = !adblock.enabled
    showToast(adblock.enabled ? 'Ad & tracker blocking on' : 'Ad & tracker blocking off')
    buildMenu()
    activeTab()?.view?.webContents.reload()
  },
  openOnion: () => { const t = activeTab(); if (t?.onionLocation) loadInTab(t, t.onionLocation) },
  zoom: dir => zoomTab(activeTab(), dir),
  findOpen: open => {
    findOpen = !!open
    if (!findOpen) {
      const t = activeTab()
      t?.view?.webContents.stopFindInPage('clearSelection')
      if (t) t.find = null
    }
    layout()
    sendState()
  },
  find: (text, forward = true, next = false) => {
    const wc = activeTab()?.view?.webContents
    if (!wc) return
    if (!text) { wc.stopFindInPage('clearSelection'); activeTab().find = null; return sendState() }
    wc.findInPage(text, { forward, findNext: !next })
  },
}

ipcMain.handle('veil:ui', async (e, cmd, ...args) => {
  if (!fromUI(e) || !uiCommands[cmd]) return null
  return uiCommands[cmd](...args)
})

// Commands that work before tor is connected; the rest need the network.
const OFFLINE_OK = new Set(['status', 'open', 'directory', 'hosted', 'bookmarks', 'removeBookmark', 'history', 'clearHistory', 'connection', 'setConnection'])

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
  connection: () => ({ ...settings, recommended: 'snowflake', bridgesAvailable: fs.existsSync(path.join(__dirname, '..', '..', 'bin', 'lyrebird')) }),
  setConnection: async (sender, mode, customText) => {
    if (!BRIDGE_MODES.includes(mode)) throw new Error('Unknown connection type')
    const custom = String(customText || '').split('\n').map(l => l.trim().replace(/^Bridge\s+/i, '')).filter(Boolean)
    if (mode === 'custom' && !custom.length) throw new Error('Paste at least one bridge line')
    settings = { bridges: mode, customBridges: mode === 'custom' ? custom : settings.customBridges }
    saveSettings()
    await reconnect()
    return { ok: true }
  },
  routing: (sender, site) => routingInfo(site),
  bookmarks: () => bookmarks.list(),
  removeBookmark: (sender, url) => { bookmarks.remove(url); sendState() },
  history: () => history,
  clearHistory: () => { history = []; closedTabs = []; sendState() },
}

ipcMain.handle('veil:internal', async (e, cmd, ...args) => {
  if (!fromInternalPage(e) || !internalCommands[cmd]) throw new Error('not allowed')
  if (!OFFLINE_OK.has(cmd) && !tor.ready) throw new Error(`Not connected to Tor yet (${cmd})`)
  return internalCommands[cmd](e.sender, ...args)
})

// ---------- window & menu ----------

function buildMenu() {
  const wc = () => activeTab()?.view?.webContents
  const ui = (channel, ...args) => uiView.webContents.send(channel, ...args)
  const tabItems = [...Array(8)].map((_, i) => ({
    label: `Select Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, click: () => selectTab(i),
  }))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab },
      { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => ui('veil:focus-address') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
      { type: 'separator' },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => wc()?.print() },
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => { uiCommands.findOpen(true); ui('veil:focus-find') } },
      { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => ui('veil:find-step', true) },
      { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => ui('veil:find-step', false) },
    ] },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => wc()?.reload() },
      { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => wc()?.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => uiCommands.zoom(1) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => uiCommands.zoom(-1) },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => uiCommands.zoom(0) },
      { type: 'separator' },
      { label: 'Toggle Full Screen', accelerator: 'Ctrl+CmdOrCtrl+F', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => wc()?.toggleDevTools() },
    ] },
    { label: 'History', submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => wc()?.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => wc()?.navigationHistory.goForward() },
      { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => { const t = activeTab(); if (t) loadInTab(t, HOME) } },
      { type: 'separator' },
      { label: 'Show History', accelerator: 'CmdOrCtrl+Y', click: () => createTab('veil://history/') },
    ] },
    { label: 'Bookmarks', submenu: [
      { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => uiCommands.bookmark() },
      { label: 'Show Bookmarks', accelerator: 'Alt+CmdOrCtrl+B', click: () => createTab(HOME) },
    ] },
    { label: 'Tab', submenu: [
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => cycleTab(1) },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => cycleTab(-1) },
      { type: 'separator' },
      ...tabItems,
      { label: 'Select Last Tab', accelerator: 'CmdOrCtrl+9', click: () => selectTab('last') },
    ] },
    { label: 'Privacy', submenu: [
      { label: 'New Identity', accelerator: 'CmdOrCtrl+Shift+U', click: () => newIdentity() },
      { label: 'New Circuit for This Site', accelerator: 'CmdOrCtrl+Shift+L', click: () => newCircuitForSite() },
      { label: 'PANIC — Wipe Everything', accelerator: 'CmdOrCtrl+Shift+X', click: () => newIdentity({ panic: true }) },
      { type: 'separator' },
      { label: 'Security Level', submenu: ['standard', 'safer', 'safest'].map(l => ({
        label: l[0].toUpperCase() + l.slice(1), click: () => uiCommands.setLevel(l),
      })) },
      { label: 'Block Ads & Trackers', type: 'checkbox', checked: adblock.enabled, click: () => uiCommands.toggleAdblock() },
      { label: 'Tor Circuit', click: () => uiCommands.panel(!panelOpen) },
      { label: 'See Onion Routing', accelerator: 'CmdOrCtrl+Shift+O', click: () => uiCommands.watchRouting() },
      { label: 'Leak Test', click: () => createTab('veil://leaktest/') },
      { label: 'Community Hub', click: () => createTab(HOME) },
    ] },
    { role: 'windowMenu' },
  ]))
}

function createWindow() {
  win = new BaseWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 480,
    title: 'Veil', backgroundColor: '#ffffff',
    show: !process.env.VEIL_SELFTEST, // self-tests run hidden so nobody's clicks interfere
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
  })
  uiView = new WebContentsView({
    webPreferences: { preload: UI_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  uiView.setBackgroundColor('#ffffff')
  uiView.webContents.loadFile(path.join(SRC, 'renderer', 'ui.html'))
  uiView.webContents.on('will-navigate', e => e.preventDefault())
  uiView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  uiView.webContents.on('did-finish-load', sendState)
  win.contentView.addChildView(uiView)
  win.on('resize', layout)
  win.on('leave-full-screen', () => { if (fullscreen) { fullscreen = false; activeTab()?.view?.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {}); layout(); sendState() } })
  win.on('closed', () => { win = null; app.quit() })
  layout()
}

// One Veil at a time: `npx electron . <url>` opens the URL in the running
// window instead of starting a second browser (and a second tor).
const testMode = process.env.VEIL_SELFTEST || process.env.VEIL_DEMO || process.env.VEIL_FP
const urlArgs = argv => argv.filter(a => /^(https?|veil):\/\//i.test(a))
if (!testMode && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (e, argv) => {
  for (const url of urlArgs(argv)) createTab(url)
  if (win) { win.show(); win.focus() }
})

app.whenReady().then(async () => {
  // The UI loads from disk; refuse any network from the default session too.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|data):/.test(d.url) }))

  bookmarks = new Bookmarks(app.getPath('userData'))
  buildMenu()
  createWindow()

  relay = new IsolationRelay({
    torPort: 0,
    isReady: () => tor.ready,
    onError: (site, code) => socksErrors.set(site, { code, at: Date.now() }),
  })
  community = new Community({ getControl: () => tor.control })
  // Tabs blocked by the kill switch while tor was still connecting load
  // themselves as soon as it's ready.
  tor.on('status', () => {
    if (tor.ready && !wasReady) {
      wasReady = true
      for (const t of tabs.values()) if (t.error && t.url && t.site !== 'veil') loadInTab(t, t.url)
    }
    sendState()
  })
  loadSettings()
  await tor.start({ bridges: bridgeLines() })
  relay.torPort = tor.socksPort
  await relay.rotate(identity.nonce)

  createTab(HOME)
  for (const url of urlArgs(process.argv)) createTab(url)

  if (process.env.VEIL_DEMO) {
    const { runDemo } = require('./demo')
    runDemo({
      tor,
      urls: process.env.VEIL_DEMO.split(',').map(s => s.trim()).filter(Boolean),
      createTab,
      uiView,
      outDir: process.env.VEIL_SHOTS || path.join(process.cwd(), 'shots'),
      activate: id => uiCommands.activate(id),
      setPanel: open => uiCommands.panel(open),
    }).catch(err => console.error('DEMO ERROR', err))
  }

  // VEIL_FP=<html file>: run that page's script in a real web tab, print what it measured.
  if (process.env.VEIL_FP) {
    const html = fs.readFileSync(process.env.VEIL_FP, 'utf8')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
      .replace(/document\.getElementById\('t'\)[\s\S]*$/, 'JSON.stringify(Object.fromEntries(rows))')
    const until = async f => { while (!(await f())) await new Promise(r => setTimeout(r, 500)) }
    await until(() => tor.ready)
    const tab = createTab('https://check.torproject.org/')
    await until(() => tab.view && !tab.loading && tab.title !== 'New Tab')
    console.log('FP ' + await tab.view.webContents.executeJavaScript(script))
    community.stop(); tor.stop(); app.exit(0)
  }

  if (process.env.VEIL_SELFTEST) {
    const { runSelfTest } = require('./selftest')
    const pageProbe = tab => tab.view.webContents.executeJavaScript(`({
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date().getTimezoneOffset(),
      rtc: typeof RTCPeerConnection,
      platform: navigator.platform,
      uaMac: /Macintosh/.test(navigator.userAgent),
      connection: 'connection' in navigator,
      serviceWorker: 'serviceWorker' in navigator,
      webgl2: !!document.createElement('canvas').getContext('webgl2'),
      timer: (() => { let a = performance.now(), b; do { b = performance.now() } while (b === a); return b - a })(),
      light: matchMedia('(prefers-color-scheme: light)').matches,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      dprConsistent: matchMedia('(resolution: ' + devicePixelRatio + 'dppx)').matches,
      fonts: (() => {
        const width = family => { const s = document.createElement('span'); s.style.fontSize = '72px'; s.style.fontFamily = family; s.textContent = 'mmmmmmmmmmlli WwQ'; document.body.append(s); const w = s.offsetWidth; s.remove(); return w }
        const ctx = document.createElement('canvas').getContext('2d')
        const measure = font => { ctx.font = font; return ctx.measureText('mmmmmmmmmmlli WwQ').width }
        return {
          domHidden: width("'Comic Sans MS', monospace") === width('monospace'),
          canvasHidden: measure("72px 'Comic Sans MS', monospace") === measure('72px monospace'),
          checkHidden: !document.fonts.check('16px "Comic Sans MS"'),
          systemVisible: width('Georgia, monospace') !== width('monospace'),
        }
      })(),
      screen: screen.width + 'x' + screen.height,
      inner: innerWidth + 'x' + innerHeight,
    })`)
    const browser = {
      ui: uiCommands, bookmarks, closeTab, history: () => history, tabCount: () => tabs.size, uiView, adblock, sessionFor, activeId: () => activeId,
    }
    runSelfTest({ tor, networkTest, createTab, circuitInfo, community, pageProbe, newCircuit: newCircuitForSite, browser })
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
