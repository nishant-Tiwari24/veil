// Community layer (ADR 0007): signed directory, invite-only onions, hosting.
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')

const COMMUNITY_DIR = path.join(__dirname, '..', '..', 'community')
const INVITE_RE = /^veil-invite:([a-z2-7]{56})\.onion:([A-Za-z0-9+/]{43}=?)$/

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp',
}

function base32(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

// Tor v3 client authorization keys: x25519, public in base32, private in base64.
function clientAuthKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  const priv = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url')
  // no "=" padding: tor's control parser would read it as a key=value argument
  return { publicB32: base32(pub), privateB64: priv.toString('base64').replace(/=+$/, '') }
}

// A path can be lexically inside the hosted folder but point outside it via a
// symlink. Compare real paths, not string prefixes, before serving a file.
function within(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function staticServer(root) {
  const realRoot = fs.realpathSync(root)
  return http.createServer((req, res) => {
    let rel
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch {
      res.writeHead(400); return res.end()
    }
    // Do not publish .env, .git or other hidden files just because the user
    // selected a project folder. Also check backslashes for Windows paths.
    if (rel.split(/[\\/]/).some(part => part.startsWith('.'))) {
      res.writeHead(403); return res.end()
    }
    let file = path.resolve(realRoot, `.${rel}`)
    if (!within(realRoot, file)) { res.writeHead(403); return res.end() }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      const realFile = fs.realpathSync(file)
      if (!within(realRoot, realFile)) { res.writeHead(403); return res.end() }
      // An innocent-looking symlink name must not bypass the hidden-file rule.
      if (path.relative(realRoot, realFile).split(path.sep).some(part => part.startsWith('.'))) {
        res.writeHead(403); return res.end()
      }
      if (!fs.statSync(realFile).isFile()) { res.writeHead(404); return res.end() }
      const body = fs.readFileSync(realFile)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(realFile).toLowerCase()] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    }
  })
}

class Community {
  constructor({ getControl }) {
    this.getControl = getControl
    this.hosted = new Map() // serviceId -> { server, folder, inviteOnly, invite }
    this.joined = new Set()
  }

  // Refuses a directory whose signature doesn't match the community key.
  directory() {
    try {
      const data = fs.readFileSync(path.join(COMMUNITY_DIR, 'directory.json'))
      const sig = Buffer.from(fs.readFileSync(path.join(COMMUNITY_DIR, 'directory.sig'), 'utf8').trim(), 'base64')
      const pub = crypto.createPublicKey(fs.readFileSync(path.join(COMMUNITY_DIR, 'community.pub.pem')))
      const fingerprint = crypto.createHash('sha256')
        .update(pub.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16)
      if (!crypto.verify(null, data, pub, sig)) {
        return { verified: false, error: 'Signature check FAILED — directory was tampered with', sites: [] }
      }
      return { verified: true, fingerprint, ...JSON.parse(data) }
    } catch (err) {
      return { verified: false, error: err.message, sites: [] }
    }
  }

  async join(invite) {
    const m = String(invite).trim().match(INVITE_RE)
    if (!m) throw new Error('Not a valid Veil invite')
    const serviceId = m[1]
    const key = m[2].replace(/=+$/, '')
    await this.getControl().command(`ONION_CLIENT_AUTH_ADD ${serviceId} x25519:${key}`)
    this.joined.add(serviceId)
    return { url: `http://${serviceId}.onion/` }
  }

  async host({ folder, inviteOnly }) {
    const control = this.getControl()
    const root = path.resolve(folder)
    const server = staticServer(root)
    await new Promise((resolve, reject) => {
      server.on('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port

    // V3Auth flag is required alongside ClientAuthV3 (found in tor 0.4.9's binary strings)
    let keys
    let cmd = `ADD_ONION NEW:ED25519-V3 Flags=DiscardPK${inviteOnly ? ',V3Auth' : ''} Port=80,127.0.0.1:${port}`
    if (inviteOnly) {
      keys = clientAuthKeypair()
      cmd += ` ClientAuthV3=${keys.publicB32}`
    }
    let reply
    try {
      reply = await control.command(cmd)
    } catch (err) {
      server.close()
      throw err
    }
    const serviceId = reply.find(l => l.startsWith('ServiceID=')).slice('ServiceID='.length)
    let invite = null
    if (inviteOnly) {
      invite = `veil-invite:${serviceId}.onion:${keys.privateB64}`
      // let the host open their own invite-only site
      await control.command(`ONION_CLIENT_AUTH_ADD ${serviceId} x25519:${keys.privateB64}`)
      this.joined.add(serviceId)
    }
    const site = { serviceId, url: `http://${serviceId}.onion/`, folder: root, inviteOnly: !!inviteOnly, invite }
    this.hosted.set(serviceId, { ...site, server })
    return site
  }

  async stopHosting(serviceId) {
    const h = this.hosted.get(serviceId)
    if (!h) return
    this.hosted.delete(serviceId)
    h.server.close()
    await this.getControl()?.command(`DEL_ONION ${serviceId}`).catch(() => {})
  }

  listHosted() {
    return [...this.hosted.values()].map(({ server, ...site }) => site)
  }

  // Panic: forget invites and take hosted sites offline.
  async wipe() {
    const control = this.getControl()
    for (const id of this.joined) await control?.command(`ONION_CLIENT_AUTH_REMOVE ${id}`).catch(() => {})
    this.joined.clear()
    for (const id of [...this.hosted.keys()]) await this.stopHosting(id)
  }

  stop() {
    for (const h of this.hosted.values()) h.server.close()
    this.hosted.clear()
  }
}

module.exports = { Community, COMMUNITY_DIR }
