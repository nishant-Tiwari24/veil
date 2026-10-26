// Runs in every tab before page scripts (ADR 0004, 0006).
// contextIsolation is off for tabs so these patches land on the page's own
// globals; the sandbox means no Node APIs exist here to leak.
const { ipcRenderer } = require('electron')

const cfg = ipcRenderer.sendSync('veil:page-config') || { seed: 0, level: 'standard' }

function getter(obj, prop, get) {
  try { Object.defineProperty(obj, prop, { get, configurable: true }) } catch {}
}

// --- Hardware & platform: everyone reports the same values ---
getter(Navigator.prototype, 'hardwareConcurrency', () => 4)
getter(Navigator.prototype, 'deviceMemory', () => 8)
getter(Navigator.prototype, 'platform', () => 'Win32')
getter(Navigator.prototype, 'language', () => 'en-US')
getter(Navigator.prototype, 'languages', () => ['en-US', 'en'])
getter(Navigator.prototype, 'maxTouchPoints', () => 0)

if (navigator.userAgentData) {
  const brands = navigator.userAgentData.brands
  const full = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || ''
  const lowEntropy = { brands, mobile: false, platform: 'Windows' }
  const fakeUAData = {
    ...lowEntropy,
    getHighEntropyValues: async () => ({
      ...lowEntropy, architecture: 'x86', bitness: '64', model: '', platformVersion: '10.0.0',
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
getter(window, 'devicePixelRatio', () => 1)

// --- WebRTC, media devices, battery: gone ---
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
  try { delete window[k] } catch {}
}
getter(Navigator.prototype, 'mediaDevices', () => undefined)
try { delete Navigator.prototype.getBattery } catch {}

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
    bookmarks: () => call('bookmarks'),
    removeBookmark: url => call('removeBookmark', url),
    history: () => call('history'),
    clearHistory: () => call('clearHistory'),
  }
}
