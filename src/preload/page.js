// Runs in every tab before page scripts (ADR 0004, 0006).
// contextIsolation is off for tabs so these patches land on the page's own
// globals; the sandbox means no Node APIs exist here to leak.
const { ipcRenderer } = require('electron')

const cfg = ipcRenderer.sendSync('veil:page-config') || { seed: 0, level: 'standard', os: 'windows' }

// Per-OS buckets, like Tor Browser: report your real OS *family* with generic
// values. Pretending to be another OS is worse: fonts and rendering still give
// the real OS away, and the mismatch makes you stand out (REVERSE_ENGINEERING.md §7).
const OS = {
  mac: { platform: 'MacIntel', uaPlatform: 'macOS', platformVersion: '10.15.7' },
  windows: { platform: 'Win32', uaPlatform: 'Windows', platformVersion: '10.0.0' },
  linux: { platform: 'Linux x86_64', uaPlatform: 'Linux', platformVersion: '' },
}[cfg.os] || { platform: 'Win32', uaPlatform: 'Windows', platformVersion: '10.0.0' }

function getter(obj, prop, get) {
  try { Object.defineProperty(obj, prop, { get, configurable: true }) } catch {}
}

// --- Hardware & platform: everyone reports the same values ---
getter(Navigator.prototype, 'hardwareConcurrency', () => 4)
getter(Navigator.prototype, 'deviceMemory', () => 8)
getter(Navigator.prototype, 'platform', () => OS.platform)
getter(Navigator.prototype, 'language', () => 'en-US')
getter(Navigator.prototype, 'languages', () => ['en-US', 'en'])
getter(Navigator.prototype, 'maxTouchPoints', () => 0)

if (navigator.userAgentData) {
  const brands = navigator.userAgentData.brands
  const full = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''
  const lowEntropy = { brands, mobile: false, platform: OS.uaPlatform }
  const fakeUAData = {
    ...lowEntropy,
    getHighEntropyValues: async () => ({
      ...lowEntropy, architecture: 'x86', bitness: '64', model: '', platformVersion: OS.platformVersion,
      uaFullVersion: full, fullVersionList: brands, wow64: false,
    }),
    toJSON: () => lowEntropy,
  }
  getter(Navigator.prototype, 'userAgentData', () => fakeUAData)
}

// --- Screen = letterboxed window (no real monitor size) ---
getter(Screen.prototype, 'width', () => window.innerWidth)
getter(Screen.prototype, 'availWidth', () => window.innerWidth)
getter(Screen.prototype, 'height', () => window.innerHeight)
getter(Screen.prototype, 'availHeight', () => window.innerHeight)
getter(Screen.prototype, 'colorDepth', () => 24)
getter(Screen.prototype, 'pixelDepth', () => 24)
getter(window, 'outerWidth', () => window.innerWidth)
getter(window, 'outerHeight', () => window.innerHeight)
getter(window, 'screenX', () => 0)
getter(window, 'screenY', () => 0)
// devicePixelRatio is left real, like Tor Browser: CSS resolution queries see
// the real value anyway, and a lie that disagrees with CSS is itself a fingerprint.

// --- WebRTC, media devices, battery: gone ---
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
  try { delete window[k] } catch {}
}
getter(Navigator.prototype, 'mediaDevices', () => undefined)
try { delete Navigator.prototype.getBattery } catch {}

// --- Removed like Tor Browser (dom.netinfo.enabled, dom.serviceWorkers.enabled = false) ---
// navigator.connection reveals network type/speed; service workers are
// background scripts a site can install.
for (const k of ['connection', 'serviceWorker']) {
  try { delete Navigator.prototype[k] } catch {}
}

// --- Coarse timers: Tor Browser clamps performance.now() to one frame (16.67 ms) ---
// Precise timing lets sites fingerprint hardware and run side-channel attacks.
const TICK = 1000 / 60
const clamp = t => Math.floor(t / TICK) * TICK
const origNow = Performance.prototype.now
Performance.prototype.now = function () { return clamp(origNow.call(this)) }
const tsDesc = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp')
if (tsDesc?.get) getter(Event.prototype, 'timeStamp', function () { return clamp(tsDesc.get.call(this)) })
const origRAF = window.requestAnimationFrame
window.requestAnimationFrame = function (cb) { return origRAF.call(window, t => cb(clamp(t))) }

// --- Canvas: reads get faint per-site, per-identity noise ---
// Stable within a site (so pages work) but different across sites and identities,
// so a canvas fingerprint can't link you.
function noise(imageData) {
  const d = imageData.data
  let s = cfg.seed >>> 0
  for (let i = 0; i < d.length; i += 4) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    if ((s >>> 24) < 26) d[i + (s & 3) % 3] ^= 1 // ~10% of pixels, lowest bit of one channel
  }
  return imageData
}
const C2D = CanvasRenderingContext2D.prototype
const origGetImageData = C2D.getImageData
const origToDataURL = HTMLCanvasElement.prototype.toDataURL
const origToBlob = HTMLCanvasElement.prototype.toBlob

C2D.getImageData = function (...args) {
  return noise(origGetImageData.apply(this, args))
}

function noisyCopy(canvas) {
  if (!canvas.width || !canvas.height) return null
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  const ctx = copy.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  ctx.putImageData(noise(origGetImageData.call(ctx, 0, 0, copy.width, copy.height)), 0, 0)
  return copy
}
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  return origToDataURL.apply(noisyCopy(this) || this, args)
}
HTMLCanvasElement.prototype.toBlob = function (...args) {
  return origToBlob.apply(noisyCopy(this) || this, args)
}

// --- Fonts: only a fixed, per-OS list is visible to scripts ---
// Font fingerprinting tests whether a font name changes how text is drawn.
// Every way a script can name a font is filtered to the fonts that ship with
// the OS (Tor Browser's macOS whitelist, font.system.whitelist), the generic
// families, and web fonts the page itself loads. A probe for any other
// installed font silently falls back, so it never reveals it.
const SYSTEM_FONTS = {
  mac: ['AppleGothic', 'Apple Color Emoji', 'Arial', 'Arial Black', 'Arial Narrow', 'Courier', 'Courier New', 'Geneva', 'Georgia', 'Heiti TC', 'Helvetica', 'Helvetica Neue', 'Hiragino Kaku Gothic ProN', 'Kailasa', 'Lucida Grande', 'Menlo', 'Monaco', 'PingFang HK', 'PingFang SC', 'PingFang TC', 'Songti SC', 'Songti TC', 'Tahoma', 'Thonburi', 'Times', 'Times New Roman', 'Verdana', 'STIX Two Math'],
  windows: ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'],
  linux: ['DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Noto Sans', 'Noto Serif', 'Noto Color Emoji'],
}[cfg.os] || []
const GENERIC_FONTS = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert']
const allowedFonts = new Set([...SYSTEM_FONTS, ...GENERIC_FONTS].map(f => f.toLowerCase()))

function fontAllowed(name) {
  const n = name.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  if (!n || allowedFonts.has(n)) return true
  try { // web fonts the page declared itself (@font-face or new FontFace)
    for (const face of document.fonts) if (face.family.replace(/^['"]|['"]$/g, '').toLowerCase() === n) return true
  } catch {}
  return false
}
function filterFamilies(list) {
  const kept = String(list).split(',').filter(fontAllowed).map(f => f.trim())
  return kept.length ? kept.join(', ') : 'serif'
}
// "italic bold 16px/1.2 'Some Font', serif" -> keep everything up to the size, filter the rest
const FONT_SHORTHAND = /^(.*?[\d.]+(?:px|pt|pc|em|rem|ex|ch|%|vw|vh|in|cm|mm|q)?(?:\s*\/\s*[\w.%-]+)?\s+)(.+)$/i
function filterShorthand(value) {
  const m = String(value).match(FONT_SHORTHAND)
  return m ? m[1] + filterFamilies(m[2]) : value
}
function filterCss(text) {
  return String(text)
    .replace(/(font-family\s*:\s*)([^;]+)/gi, (_, k, v) => k + filterFamilies(v))
    .replace(/((?:^|;)\s*font\s*:\s*)([^;]+)/gi, (_, k, v) => k + filterShorthand(v))
}
function wrapSetter(proto, prop, filter) {
  const d = proto && Object.getOwnPropertyDescriptor(proto, prop)
  if (!d?.set) return
  Object.defineProperty(proto, prop, { ...d, set(v) { d.set.call(this, filter(v)) } })
}
const CSD = CSSStyleDeclaration.prototype
wrapSetter(CSD, 'cssText', filterCss)
// Chromium resolves style.fontFamily / style.font internally (no prototype
// accessor to wrap), so element.style hands back a thin proxy that filters
// font names on the way in. One proxy per declaration keeps el.style === el.style.
const styleProxies = new WeakMap()
function proxyStyle(decl) {
  if (!decl) return decl
  let p = styleProxies.get(decl)
  if (!p) {
    p = new Proxy(decl, {
      get(t, k) { const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v },
      set(t, k, v) {
        if (k === 'fontFamily' || k === 'font-family') v = filterFamilies(v)
        else if (k === 'font') v = filterShorthand(v)
        else if (k === 'cssText') v = filterCss(v)
        return Reflect.set(t, k, v, t)
      },
    })
    styleProxies.set(decl, p)
  }
  return p
}
for (const proto of [HTMLElement.prototype, SVGElement.prototype, window.MathMLElement?.prototype]) {
  const d = proto && Object.getOwnPropertyDescriptor(proto, 'style')
  if (!d?.get) continue
  Object.defineProperty(proto, 'style', {
    ...d,
    get() { return proxyStyle(d.get.call(this)) },
    set(v) { d.set.call(this, filterCss(v)) },
  })
}
const origSetProperty = CSD.setProperty
CSD.setProperty = function (name, value, priority) {
  const n = String(name).toLowerCase()
  if (n === 'font-family') value = filterFamilies(value)
  else if (n === 'font') value = filterShorthand(value)
  return origSetProperty.call(this, name, value, priority)
}
const origSetAttribute = Element.prototype.setAttribute
Element.prototype.setAttribute = function (name, value) {
  if (String(name).toLowerCase() === 'style') value = filterCss(value)
  return origSetAttribute.call(this, name, value)
}
wrapSetter(CanvasRenderingContext2D.prototype, 'font', filterShorthand)
wrapSetter(window.OffscreenCanvasRenderingContext2D?.prototype, 'font', filterShorthand)
if (window.FontFaceSet) {
  const origCheck = FontFaceSet.prototype.check
  FontFaceSet.prototype.check = function (font, text) {
    const m = String(font).match(FONT_SHORTHAND)
    if (m && !m[2].split(',').some(fontAllowed)) return false
    return origCheck.call(this, font, text)
  }
}

// --- WebGL2 off, like Tor Browser (webgl.enable-webgl2 = false) ---
for (const proto of [HTMLCanvasElement.prototype, window.OffscreenCanvas?.prototype]) {
  if (!proto) continue
  const orig = proto.getContext
  proto.getContext = function (type, ...rest) {
    if (/^(experimental-)?webgl2$/.test(String(type))) return null
    return orig.call(this, type, ...rest)
  }
}

// --- WebGL: hide the real GPU ---
for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
  if (!proto) continue
  const orig = proto.getParameter
  proto.getParameter = function (p) {
    if (p === 0x9245 || p === 0x1F00) return 'Google Inc.' // UNMASKED_VENDOR, VENDOR
    if (p === 0x9246) return 'ANGLE (Generic GPU)' // UNMASKED_RENDERER
    if (p === 0x1F01) return 'WebKit WebGL' // RENDERER
    return orig.call(this, p)
  }
}

// --- Safer level: no WebAssembly (WebGL is disabled by the engine) ---
if (cfg.level !== 'standard') {
  try { delete window.WebAssembly } catch {}
}

// --- Internal pages (veil://) get a small API; web pages never do ---
if (location.protocol === 'veil:') {
  window.__veilErrors = [] // read by the self-test
  window.addEventListener('error', e => window.__veilErrors.push(e.message))
  const call = (cmd, ...args) => ipcRenderer.invoke('veil:internal', cmd, ...args)
  window.veil = {
    status: () => call('status'),
    open: input => call('open', input),
    directory: () => call('directory'),
    join: invite => call('join', invite),
    hostSample: inviteOnly => call('hostSample', inviteOnly),
    hostFolder: inviteOnly => call('hostFolder', inviteOnly),
    stopHosting: id => call('stopHosting', id),
    hosted: () => call('hosted'),
    networkTest: () => call('networkTest'),
    routing: site => call('routing', site),
    bookmarks: () => call('bookmarks'),
    removeBookmark: url => call('removeBookmark', url),
    history: () => call('history'),
    clearHistory: () => call('clearHistory'),
    connection: () => call('connection'),
    setConnection: (mode, custom) => call('setConnection', mode, custom),
  }
}
