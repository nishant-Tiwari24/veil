// Creates the community signing keypair. Keep community.key secret.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'community')
const keyFile = path.join(dir, 'community.key')
if (fs.existsSync(keyFile)) {
  console.error('community.key already exists — refusing to overwrite')
  process.exit(1)
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
fs.writeFileSync(path.join(dir, 'community.pub.pem'), publicKey.export({ format: 'pem', type: 'spki' }))
console.log('Wrote community/community.key (secret) and community/community.pub.pem')
