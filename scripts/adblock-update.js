// Builds Veil's built-in ad & tracker blocklist (EasyList + EasyPrivacy +
// uBlock filters, via Ghostery's prebuilt engine) into assets/adblock.engine.
// Run at build time only: the browser itself never downloads filter lists, so
// every Veil user ships with the exact same list (see ADR 0009).
const fs = require('fs')
const path = require('path')
const { FiltersEngine } = require('@ghostery/adblocker')

;(async () => {
  const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch)
  const out = path.join(__dirname, '..', 'assets', 'adblock.engine')
  fs.writeFileSync(out, engine.serialize())
  console.log(`Wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`)
})()
