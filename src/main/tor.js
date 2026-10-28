// TorManager — spawns and owns Veil's private tor process (ADR 0002).
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const { TorControl } = require('./control')

const TOR_CANDIDATES = ['/opt/homebrew/bin/tor', '/usr/local/bin/tor', '/usr/bin/tor']

function findTor() {
  if (process.env.VEIL_TOR_PATH) return process.env.VEIL_TOR_PATH
  return TOR_CANDIDATES.find(p => fs.existsSync(p)) || 'tor'
}

// lyrebird runs obfs4 / Snowflake / meek bridges (copied from Tor Browser by
// `npm run bridges:setup`; Homebrew doesn't package it). A packaged Veil keeps
// it outside the app archive, in Resources/bin, so it can be executed.
const LYREBIRD = process.env.VEIL_LYREBIRD || [
  path.join(__dirname, '..', '..', 'bin', 'lyrebird'),
  process.resourcesPath && path.join(process.resourcesPath, 'bin', 'lyrebird'),
].find(p => p && fs.existsSync(p)) || path.join(__dirname, '..', '..', 'bin', 'lyrebird')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// A Veil that was killed (not quit) can't wipe its tor folder; the next start does.
function sweepStaleDataDirs() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('veil-tor-')) continue
    const dir = path.join(os.tmpdir(), name)
    try {
      const pid = Number(fs.readFileSync(path.join(dir, 'veil.pid'), 'utf8'))
      try { process.kill(pid, 0); continue } catch {} // owner still running
    } catch {
      if (Date.now() - fs.statSync(dir).mtimeMs < 24 * 3600e3) continue // no owner file: leave recent ones alone
    }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

class TorManager extends EventEmitter {
  constructor() {
    super()
    this.progress = 0
    this.summary = 'Starting tor'
    this.ready = false
    this.error = null
    this.control = null
  }

  // bridges: bridge lines ("obfs4 1.2.3.4:443 FINGERPRINT cert=..."), or [] to connect directly
  async start({ bridges = [] } = {}) {
    const bin = findTor()
    this.stopping = false
    this.ready = false
    this.error = null
    this.progress = 0
    this.control = null
    this.bridges = bridges
    this.summary = bridges.length ? 'Starting tor with bridges' : 'Starting tor'
    sweepStaleDataDirs()
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-tor-'))
    fs.writeFileSync(path.join(this.dataDir, 'veil.pid'), String(process.pid))
    this.socksPort = await freePort()
    this.controlPort = await freePort()

    // Bridges go in the torrc: Bridge is a repeated option (Tor Browser's torrc-defaults
    // registers the same transports).
    let rc = ''
    if (bridges.length) {
      if (!fs.existsSync(LYREBIRD)) {
        return this._fail('Bridges need lyrebird. Run: npm run bridges:setup')
      }
      rc = [
        'UseBridges 1',
        `ClientTransportPlugin meek_lite,obfs2,obfs3,obfs4,scramblesuit,webtunnel exec ${LYREBIRD}`,
        `ClientTransportPlugin snowflake exec ${LYREBIRD}`,
        ...bridges.map(line => `Bridge ${line}`),
      ].join('\n') + '\n'
    }
    const emptyRc = path.join(this.dataDir, 'torrc')
    fs.writeFileSync(emptyRc, rc)

    const args = [
      '-f', emptyRc,
      '--defaults-torrc', emptyRc,
      '--DataDirectory', this.dataDir,
      // Different SOCKS username/password => different circuit (ADR 0003)
      // Same SOCKS flags as Tor Browser (REVERSE_ENGINEERING.md §4)
      '--SocksPort', `127.0.0.1:${this.socksPort} IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth ExtendedErrors IPv6Traffic PreferIPv6`,
      '--ControlPort', `127.0.0.1:${this.controlPort}`,
      '--CookieAuthentication', '1',
      '--ClientOnly', '1',
      '--AvoidDiskWrites', '1',
      '--DormantCanceledByStartup', '1', // from Tor Browser's torrc-defaults
      // tor exits on its own if Veil dies
      '--__OwningControllerProcess', String(process.pid),
      '--Log', 'notice stdout',
    ]
    // Homebrew layout: <prefix>/bin/tor and <prefix>/share/tor/geoip
    const shareDir = fs.existsSync(bin)
      ? path.join(path.dirname(fs.realpathSync(bin)), '..', 'share', 'tor')
      : ''
    const geoip = path.join(shareDir, 'geoip')
    if (shareDir && fs.existsSync(geoip)) {
      args.push('--GeoIPFile', geoip, '--GeoIPv6File', path.join(shareDir, 'geoip6'))
    }

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    proc.on('error', err => this._fail(`Could not start tor (${err.message}). Install it with: brew install tor`))
    proc.on('exit', code => {
      if (proc !== this.proc) return // an old tor from before a restart
      this.ready = false
      if (!this.stopping) this._fail(`tor exited (code ${code})`)
    })

    let buf = ''
    proc.stdout.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        this._onLog(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
  }

  _onLog(line) {
    if (process.env.VEIL_DEBUG) console.log('[tor]', line)
    const m = line.match(/Bootstrapped (\d+)%[^:]*: (.*)$/)
    if (m) {
      this.progress = Number(m[1])
      this.summary = m[2].trim()
      if (this.progress === 100 && !this.control) this._connectControl()
      this.emit('status')
    }
  }

  async _connectControl() {
    try {
      const cookie = fs.readFileSync(path.join(this.dataDir, 'control_auth_cookie'))
      this.control = new TorControl()
      await this.control.connect(this.controlPort, cookie)
      await this.control.command('TAKEOWNERSHIP')
      this.ready = true
      this.summary = this.bridges.length ? 'Connected to the Tor network via a bridge' : 'Connected to the Tor network'
    } catch (err) {
      this._fail(`Control port: ${err.message}`)
    }
    this.emit('status')
  }

  _fail(msg) {
    this.error = msg
    this.summary = msg
    this.emit('status')
  }

  status() {
    return { progress: this.progress, summary: this.summary, ready: this.ready, error: this.error, bridged: !!this.bridges?.length }
  }

  // Switching bridges: a fresh tor with a fresh data folder and new ports.
  async restart(options) {
    this.stop()
    this.emit('status')
    await this.start(options)
    this.emit('status')
  }

  stop() {
    this.stopping = true
    this.ready = false
    try { this.control?.close() } catch {}
    this.control = null
    const dir = this.dataDir // captured: after a restart this.dataDir is the new tor's
    const wipe = () => {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
    }
    // tor may still be writing on its way out: wipe now and again once it exits
    this.proc?.once('exit', wipe)
    try { this.proc?.kill('SIGTERM') } catch {}
    if (dir) wipe()
  }
}

module.exports = { TorManager, LYREBIRD }
