// IsolationRelay — gives every first-party site its own Tor circuit (ADR 0003).
//
// Chromium speaks SOCKS5 without auth. For each site we open a local
// listener; connections to it are forwarded to tor with
//   username = site, password = <identity nonce>:<site salt>
// and tor (IsolateSOCKSAuth) builds a separate circuit per credential pair.
const net = require('net')

// Buffered reader for the SOCKS handshake.
function reader(sock) {
  let buf = Buffer.alloc(0)
  let waiting = null
  const pump = () => {
    if (waiting && buf.length >= waiting.n) {
      const out = buf.subarray(0, waiting.n)
      buf = buf.subarray(waiting.n)
      const { resolve } = waiting
      waiting = null
      resolve(out)
    }
  }
  const onData = d => { buf = Buffer.concat([buf, d]); pump() }
  const onEnd = () => waiting?.reject(new Error('socket closed'))
  sock.on('data', onData)
  sock.on('close', onEnd)
  return {
    read: n => new Promise((resolve, reject) => { waiting = { n, resolve, reject }; pump() }),
    // stop reading and hand back whatever was buffered
    release: () => { sock.off('data', onData); sock.off('close', onEnd); return buf },
  }
}

// Reads a SOCKS5 request (or reply, which has the same layout) and returns
// its second byte (CMD / REP) and raw bytes.
async function readRequest(r) {
  const head = await r.read(4) // VER CMD RSV ATYP
  let addr
  if (head[3] === 0x01) addr = await r.read(4)
  else if (head[3] === 0x04) addr = await r.read(16)
  else if (head[3] === 0x03) {
    const len = await r.read(1)
    addr = Buffer.concat([len, await r.read(len[0])])
  } else throw new Error('bad address type')
  const port = await r.read(2)
  return { cmd: head[1], raw: Buffer.concat([head, addr, port]) }
}

class IsolationRelay {
  constructor({ torPort, isReady, onError }) {
    this.torPort = torPort
    this.isReady = isReady
    this.onError = onError
    this.listeners = new Map() // site -> Promise<{server, port}>
    this.sockets = new Set()
    this.salts = new Map()
    this.nonce = ''
  }

  credentialsFor(site) {
    return { username: site, password: `${this.nonce}:${this.salts.get(site) || 0}` }
  }

  portFor(site) {
    if (!this.listeners.has(site)) {
      this.listeners.set(site, new Promise((resolve, reject) => {
        const server = net.createServer(sock => this._handle(sock, site))
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
      }))
    }
    return this.listeners.get(site).then(l => l.port)
  }

  async _handle(client, site) {
    this.sockets.add(client)
    client.on('close', () => this.sockets.delete(client))
    client.on('error', () => {})

    // Kill switch: nothing leaves until tor is fully bootstrapped.
    if (!this.isReady()) return client.destroy()

    const cr = reader(client)
    let tor
    try {
      // client greeting: VER NMETHODS METHODS...
      const greet = await cr.read(2)
      await cr.read(greet[1])
      client.write(Buffer.from([0x05, 0x00])) // no auth needed locally

      const req = await readRequest(cr)
      if (req.cmd !== 0x01) { // CONNECT only
        client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }

      tor = net.connect(this.torPort, '127.0.0.1')
      this.sockets.add(tor)
      tor.on('close', () => this.sockets.delete(tor))
      tor.on('error', () => client.destroy())
      const tr = reader(tor)

      const { username, password } = this.credentialsFor(site)
      const user = Buffer.from(username)
      const pass = Buffer.from(password)
      tor.write(Buffer.from([0x05, 0x01, 0x02])) // offer username/password
      const choice = await tr.read(2)
      if (choice[1] !== 0x02) throw new Error('tor refused auth method')
      tor.write(Buffer.concat([
        Buffer.from([0x01, user.length]), user,
        Buffer.from([pass.length]), pass,
      ]))
      const auth = await tr.read(2)
      if (auth[1] !== 0x00) throw new Error('tor auth failed')

      // Forward the original CONNECT and relay tor's reply. With ExtendedErrors,
      // onion failures come back as codes 0xF0-0xF7; report them so the browser
      // can say *why* (not found, needs an invite, bad address...).
      tor.write(req.raw)
      const reply = await readRequest(tr) // same layout as a request: VER REP RSV ATYP ADDR PORT
      client.write(reply.raw)
      if (reply.cmd !== 0x00) { // REP field
        this.onError?.(site, reply.cmd)
        client.end()
        tor.destroy()
        return
      }
      const leftClient = cr.release()
      const leftTor = tr.release()
      if (leftTor.length) client.write(leftTor)
      if (leftClient.length) tor.write(leftClient)
      tor.pipe(client)
      client.pipe(tor)
    } catch {
      client.destroy()
      tor?.destroy()
    }
  }

  // "New circuit for this site": next connections use a fresh credential.
  newCircuit(site) {
    this.salts.set(site, (this.salts.get(site) || 0) + 1)
  }

  // New Identity: drop every connection and listener, change the nonce.
  async rotate(nonce) {
    this.nonce = nonce
    this.salts.clear()
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    const listeners = [...this.listeners.values()]
    this.listeners.clear()
    for (const l of listeners) (await l).server.close()
  }
}

module.exports = { IsolationRelay }
