// Built-in ad & tracker blocking (ADR 0009). One fixed list for every user.
const fs = require('fs')
const path = require('path')
const { FiltersEngine, Request } = require('@ghostery/adblocker')

const ENGINE_FILE = path.join(__dirname, '..', '..', 'assets', 'adblock.engine')

// Electron resourceType -> filter-list request type
const TYPES = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script',
  image: 'image', font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping',
  cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other',
}

class AdBlocker {
  constructor() {
    this.enabled = true
    this.allowed = new Set() // sites the user allowed this session (never saved)
    try {
      this.engine = FiltersEngine.deserialize(fs.readFileSync(ENGINE_FILE))
    } catch (err) {
      this.engine = null
      this.error = `Blocklist missing: run "npm run adblock:update" (${err.message})`
    }
  }

  active(site) {
    return this.enabled && !!this.engine && !this.allowed.has(site)
  }

  // For an ad/tracker returns { cancel: true } or, when the list provides a
  // harmless stand-in (e.g. a no-op analytics.js so pages don't break),
  // { redirectURL: <data: URL> }. Returns null for everything else.
  check({ url, resourceType, referrer }, site) {
    if (!this.active(site) || resourceType === 'mainFrame') return null
    const request = Request.fromRawDetails({ url, sourceUrl: referrer || '', type: TYPES[resourceType] || 'other' })
    const { match, redirect } = this.engine.match(request)
    if (!match) return null
    return redirect?.dataUrl ? { redirectURL: redirect.dataUrl } : { cancel: true }
  }

  // Element-hiding CSS for a page (removes empty ad boxes).
  cosmeticCSS(url, site) {
    if (!this.active(site)) return ''
    try {
      const { hostname } = new URL(url)
      const { styles } = this.engine.getCosmeticsFilters({
        url, hostname, domain: site, getBaseRules: true, getInjectionRules: false, getExtendedRules: false,
      })
      return styles || ''
    } catch {
      return ''
    }
  }

  toggleSite(site) {
    if (this.allowed.has(site)) this.allowed.delete(site)
    else this.allowed.add(site)
    return !this.allowed.has(site)
  }
}

module.exports = { AdBlocker }
