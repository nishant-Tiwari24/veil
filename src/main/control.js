// Minimal client for tor's control protocol (control-spec.txt).
const net = require('net')

class TorControl {
  constructor() {
    this.queue = []
    this.current = []
    this.inData = false
    this.buf = ''
  }

  connect(port, cookie) {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(port, '127.0.0.1')
      this.sock.setEncoding('utf8')
      this.sock.on('data', d => this._onData(d))
      this.sock.on('error', reject)
      this.sock.on('close', () => {
        for (const p of this.queue) p.reject(new Error('control connection closed'))
        this.queue = []
      })
      this.sock.on('connect', () => {
        this.command(`AUTHENTICATE ${cookie.toString('hex')}`).then(resolve, reject)
      })
    })
  }

  _onData(chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\r\n')) >= 0) {
      this._onLine(this.buf.slice(0, i))
      this.buf = this.buf.slice(i + 2)
    }
  }

  _onLine(line) {
    if (this.inData) {
      if (line === '.') this.inData = false
      else this.current.push(line.startsWith('..') ? line.slice(1) : line)
      return
    }
    const code = line.slice(0, 3)
    const sep = line[3]
    this.current.push(line.slice(4))
    if (sep === '+') { this.inData = true; return }
    if (sep !== ' ') return

    const lines = this.current
    this.current = []
    if (code[0] === '6') return // async events: not subscribed
    const pending = this.queue.shift()
    if (!pending) return
    if (code[0] === '2') pending.resolve(lines)
    else pending.reject(new Error(`${code} ${lines.join(' ')}`))
  }

  command(cmd) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.sock.write(cmd + '\r\n')
    })
  }

  async getinfo(key) {
    const lines = await this.command(`GETINFO ${key}`)
    const first = lines[0] || ''
    const value = first.slice(first.indexOf('=') + 1)
    // multi-line values come back as "key=" followed by data lines, then "OK"
    return value ? value : lines.slice(1, -1).join('\n')
  }

  signal(name) {
    return this.command(`SIGNAL ${name}`)
  }

  // The circuit tor built for one SOCKS username/password pair (ADR 0003).
  async circuitFor(username, password) {
    const status = await this.getinfo('circuit-status')
    const circ = status.split('\n')
      .filter(l => l.includes(' BUILT ')
        && l.includes(`SOCKS_USERNAME="${username}"`)
        && l.includes(`SOCKS_PASSWORD="${password}"`))
      .pop()
    if (!circ) return null

    const parts = circ.split(' ')
    const purpose = (circ.match(/PURPOSE=(\S+)/) || [])[1] || 'GENERAL'
    const hops = await Promise.all(parts[2].split(',').map(async hop => {
      const [fp, nick] = hop.replace(/^\$/, '').split(/[~=]/)
      let ip = null
      let country = null
      try {
        const ns = await this.getinfo(`ns/id/${fp}`)
        ip = ns.split('\n').find(l => l.startsWith('r '))?.split(' ')[6] || null
        if (ip) country = await this.getinfo(`ip-to-country/${ip}`)
      } catch {}
      return { fingerprint: fp, nickname: nick, ip, country: country && country !== '??' ? country : null }
    }))
    return { id: parts[0], purpose, hops }
  }

  // Live streams (TCP connections) tor has attached to a circuit.
  async streamsOn(circuitId) {
    const status = await this.getinfo('stream-status').catch(() => '')
    return status.split('\n').filter(Boolean)
      .map(l => l.split(' '))
      .filter(p => p[2] === circuitId)
      .map(([id, state, , target]) => ({ id, state, target }))
  }

  async traffic() {
    const [read, written] = await Promise.all([this.getinfo('traffic/read'), this.getinfo('traffic/written')])
    return { read: Number(read), written: Number(written) }
  }

  close() {
    this.sock?.destroy()
  }
}

module.exports = { TorControl }
