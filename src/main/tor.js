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

class TorManager extends EventEmitter {
  constructor() {
    super()
    this.progress = 0
    this.summary = 'Starting tor'
    this.ready = false
    this.error = null
    this.control = null
  }

  async start() {
    const bin = findTor()
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-tor-'))
    this.socksPort = await freePort()
    this.controlPort = await freePort()

    const emptyRc = path.join(this.dataDir, 'torrc')
    fs.writeFileSync(emptyRc, '')

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

    this.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc.on('error', err => this._fail(`Could not start tor (${err.message}). Install it with: brew install tor`))
    this.proc.on('exit', code => {
      this.ready = false
      if (!this.stopping) this._fail(`tor exited (code ${code})`)
    })

    let buf = ''
    this.proc.stdout.on('data', chunk => {
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
      if (this.progress === 100) this._connectControl()
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
      this.summary = 'Connected to the Tor network'
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
    return { progress: this.progress, summary: this.summary, ready: this.ready, error: this.error }
  }

  stop() {
    this.stopping = true
    this.ready = false
    try { this.control?.close() } catch {}
    const wipe = () => {
      try { fs.rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
    }
    // tor may still be writing on its way out: wipe now and again once it exits
    this.proc?.once('exit', wipe)
    try { this.proc?.kill('SIGTERM') } catch {}
    if (this.dataDir) wipe()
  }
}

module.exports = { TorManager }
