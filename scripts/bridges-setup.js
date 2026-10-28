// Copies lyrebird (the pluggable-transport program behind obfs4, Snowflake
// and meek bridges) out of an installed or unpacked Tor Browser into bin/.
// Homebrew doesn't package lyrebird; Tor Browser's copy is signed by the Tor Project.
const fs = require('fs')
const path = require('path')
const os = require('os')

const rel = 'Contents/MacOS/Tor/PluggableTransports/lyrebird'
const candidates = [
  process.argv[2],
  '/Applications/Tor Browser.app',
  path.join(os.homedir(), 'Desktop/veil-re/app/Tor Browser.app'),
].filter(Boolean).map(app => app.endsWith('lyrebird') ? app : path.join(app, rel))

const src = candidates.find(p => fs.existsSync(p))
if (!src) {
  console.error('lyrebird not found. Install Tor Browser, or pass the path to Tor Browser.app.')
  process.exit(1)
}
const dest = path.join(__dirname, '..', 'bin', 'lyrebird')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.copyFileSync(src, dest)
fs.chmodSync(dest, 0o755)
console.log(`Copied ${src} -> bin/lyrebird`)

// lyrebird is BSD-licensed: keep its licence next to the binary
const pt = path.dirname(src)
const licence = [
  path.join(pt, '..', '..', 'Docs', 'Licenses', 'lyrebird.txt'), // Linux: Browser/TorBrowser/Tor/PluggableTransports
  path.join(pt, '..', '..', '..', 'Resources', 'TorBrowser', 'Docs', 'Licenses', 'lyrebird.txt'), // macOS: Contents/MacOS/Tor/PluggableTransports
].find(p => fs.existsSync(p))
if (licence) fs.copyFileSync(licence, path.join(path.dirname(dest), 'lyrebird-LICENSE.txt'))
